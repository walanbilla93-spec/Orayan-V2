'use strict';
const fs=require('fs');
const path=require('path');
const {Readable}=require('stream');
const {StringDecoder}=require('string_decoder');
const store = require('./store');
const logger=require('./logger');
const runtime=require('./runtimeIdentity');
const VERSION = 'MARKET_ENVIRONMENT_RESEARCH_V1';
// Research events are needed for rejected-candidate counterfactual work. Keep a time-based
// window large enough for multi-day analysis; the old 20k hard cap discarded ~7h in <2 days.
const RETENTION_MS = 4 * 86400000; // 96h, safely above the requested 72h minimum
const MAX_SNAPSHOTS = 2500;
let snapshots = store.read('researchEnvironmentV1', []);
if (!Array.isArray(snapshots)) snapshots = [];
const bootNow = Date.now();
snapshots = snapshots.filter(x => Number(x?.barOpenAt || x?.observedAt || 0) >= bootNow - RETENTION_MS).slice(-MAX_SNAPSHOTS);
let timer = null, dirty = false,lastEventPrune=Date.now();
const eventDir=path.join(store.DATA_DIR,'research-events-v1');
const legacyEventFile=path.join(store.DATA_DIR,'researchEventsV1.json');
const lastEventSignature=new Map(),recentEvents=[];
const MAX_SIGNATURES=4096,MAX_RECENT=256;
function eventFiles() {
  if (!fs.existsSync(eventDir)) return [];
  return fs.readdirSync(eventDir).filter(x=>/^events-\d{4}-\d{2}-\d{2}-\d{2}\.jsonl$/.test(x))
    .sort().map(x=>path.join(eventDir,x));
}
function pruneEventFiles(now=Date.now()) {
  const cutoff=now-RETENTION_MS;
  for(const file of eventFiles()) {
    const m=/events-(\d{4}-\d{2}-\d{2})-(\d{2})\.jsonl$/.exec(file);
    if(Date.parse(`${m[1]}T${m[2]}:00:00Z`)+3600000<cutoff)
      try{fs.unlinkSync(file);}catch(e){logger.warn('research','Could not prune event file',{error:e.message});}
  }
}
// Only recent signatures are needed for restart dedupe. Never parse the legacy
// researchEventsV1.json array at boot; it can occupy most of a small V8 heap.
try {
  pruneEventFiles();
  const cutoff=Date.now()-3*3600000;
  for(const file of eventFiles()) {
    const m=/events-(\d{4}-\d{2}-\d{2})-(\d{2})\.jsonl$/.exec(file);
    if(Date.parse(`${m[1]}T${m[2]}:00:00Z`)+3600000<cutoff)continue;
    const fd=fs.openSync(file,'r'),buf=Buffer.allocUnsafe(65536),decoder=new StringDecoder('utf8');
    let carry='';
    try {
      let count;
      while((count=fs.readSync(fd,buf,0,buf.length,null))>0){
        carry+=decoder.write(buf.subarray(0,count));
        let end;
        while((end=carry.indexOf('\n'))>=0){
          const line=carry.slice(0,end);carry=carry.slice(end+1);
          if(line.length>1048576)throw Error('Research event row exceeds 1 MB');
          if(line)try{const row=JSON.parse(line);if(row.candidateKey&&row.signature){
            lastEventSignature.delete(row.candidateKey);
            lastEventSignature.set(row.candidateKey,row.signature);
            if(lastEventSignature.size>MAX_SIGNATURES)
              lastEventSignature.delete(lastEventSignature.keys().next().value);
          }}catch(e){logger.warn('research','Skipping malformed research event row',{file,error:e.message});}
        }
        if(carry.length>1048576)throw Error('Research event row exceeds 1 MB');
      }
      carry+=decoder.end();
      // A crash during append can leave an incomplete final line. Do not let
      // that one line prevent restoration of all earlier complete records.
      if(carry)try{const row=JSON.parse(carry);if(row.candidateKey&&row.signature){
        lastEventSignature.delete(row.candidateKey);
        lastEventSignature.set(row.candidateKey,row.signature);
      }}catch(e){logger.warn('research','Ignoring incomplete final event row',{file,error:e.message});}
    }finally{fs.closeSync(fd);}
  }
  while(lastEventSignature.size>MAX_SIGNATURES)lastEventSignature.delete(lastEventSignature.keys().next().value);
}catch(e){logger.warn('research','Could not restore research event signatures',{error:e.message});}
function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!dirty) return;
  dirty = false;
  // Minified persistence materially lowers the temporary JSON string allocated during flush.
  // These files are machine research stores; pretty printing only increases heap pressure.
  store.write('researchEnvironmentV1', snapshots, false);
}
function schedule() {
  dirty = true;
  if (!timer) {
    timer = setTimeout(flush, 3000);
    if (timer.unref) timer.unref();
  }
}
function finite(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function round(v, digits = 8) {
  if (!Number.isFinite(v)) return null;
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}
function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function stddev(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((sum, x) => sum + (x - m) ** 2, 0) / xs.length);
}
function pct(n, d) { return d ? 100 * n / d : null; }
function sign(v) { return v > 1e-12 ? 1 : v < -1e-12 ? -1 : 0; }
function ema(values, period) {
  if (!values.length) return null;
  const a = 2 / (period + 1);
  let out = values[0];
  for (let i = 1; i < values.length; i++) out = a * values[i] + (1 - a) * out;
  return out;
}
function ret(closes, bars) {
  const base = closes[closes.length - 1 - bars];
  return closes.length > bars && base > 0 ? closes[closes.length - 1] / base - 1 : null;
}
function observation(symbol, candles) {
  if (!symbol || !Array.isArray(candles)) return null;
  const clean = candles.filter(c => Number.isFinite(Number(c?.close)))
    .map(c => ({ ts:Number(c.ts), close:Number(c.close) }));
  if (clean.length < 3) return null;
  const closes = clean.map(c => c.close), returns = [];
  for (let i = Math.max(1, closes.length - 20); i < closes.length; i++) {
    if (closes[i - 1] > 0) returns.push(closes[i] / closes[i - 1] - 1);
  }
  const last = clean[clean.length - 1], e21 = ema(closes.slice(-80), 21), e55 = ema(closes.slice(-120), 55);
  return {
    symbol, barOpenAt:last.ts, close:last.close, r1:ret(closes, 1),
    previousReturn:closes[closes.length - 3] > 0 ? closes[closes.length - 2] / closes[closes.length - 3] - 1 : null,
    r3:ret(closes, 3), r12:ret(closes, 12), realisedVol20:stddev(returns),
    trend:last.close > e21 && e21 > e55 ? 1 : last.close < e21 && e21 < e55 ? -1 : 0,
  };
}
function volatilityBucket(value) {
  const history = snapshots.slice(-192).map(s => finite(s.medianRealisedVol20)).filter(v => v !== null);
  if (value === null || history.length < 12) return 'WARMUP';
  const base = median(history);
  if (!(base > 0)) return 'UNKNOWN';
  return value >= base * 1.5 ? 'HIGH' : value <= base * 0.67 ? 'LOW' : 'NORMAL';
}
function captureMarketSnapshot(observations, meta = {}) {
  const rows = (Array.isArray(observations) ? observations : []).filter(Boolean);
  const allAlts = rows.filter(r => r.symbol !== 'BTCUSDT');
  if (!allAlts.length) return null;
  const barOpenAt = Math.max(...allAlts.map(r => r.barOpenAt).filter(Number.isFinite));
  if (!Number.isFinite(barOpenAt)) return null;
  // Never mix a stale symbol candle into a newer completed-bar cross-section.
  const alts = allAlts.filter(r => r.barOpenAt === barOpenAt);
  const btc = rows.find(r => r.symbol === 'BTCUSDT' && r.barOpenAt === barOpenAt) || null;
  const old = snapshots.find(s => s.barOpenAt === barOpenAt && s.timeframe === meta.timeframe);
  if (old) return old;
  const valid = alts.filter(r => finite(r.r1) !== null);
  const prior = valid.filter(r => finite(r.previousReturn) !== null);
  const positive = valid.filter(r => r.r1 > 0).length, negative = valid.filter(r => r.r1 < 0).length;
  const currentBreadth = pct(positive - negative, valid.length);
  const previousBreadth = pct(
    prior.filter(r => r.previousReturn > 0).length - prior.filter(r => r.previousReturn < 0).length,
    prior.length);
  const r1s = valid.map(r => r.r1), absMean = mean(r1s.map(Math.abs));
  const persistence = prior.filter(r => sign(r.r1) && sign(r.r1) === sign(r.previousReturn)).length;
  const reversals = prior.filter(r => sign(r.r1) && sign(r.previousReturn) && sign(r.r1) !== sign(r.previousReturn)).length;
  const btcDirection = sign(btc?.r1 || 0), alignable = btcDirection ? valid.filter(r => sign(r.r1)) : [];
  const medianVol = median(valid.map(r => finite(r.realisedVol20)).filter(v => v !== null));
  const shockZ = btc && finite(btc.realisedVol20) > 0 ? btc.r1 / btc.realisedVol20 : null;
  const shock = shockZ === null ? 'UNKNOWN' : Math.abs(shockZ) >= 3
    ? (shockZ > 0 ? 'UP_EXTREME' : 'DOWN_EXTREME') : Math.abs(shockZ) >= 2
      ? (shockZ > 0 ? 'UP_SHOCK' : 'DOWN_SHOCK') : 'NORMAL';
  const id = `mes_${meta.timeframe || 'na'}_${barOpenAt}`;
  const snapshot = {
    ...runtime.rowFields(),
    version:VERSION, id, marketSnapshotId:id, barOpenAt, configHash:meta.configHash || null,
    barOpenIso:new Date(barOpenAt).toISOString(), observedAt:meta.scanAt || Date.now(),
    timeframe:meta.timeframe || null, expectedUniverseCount:meta.expectedUniverseCount || null,
    universeCount:alts.length, coveragePct:pct(alts.length, meta.expectedUniverseCount || alts.length),
    positiveCount:positive, negativeCount:negative,
    marketBreadthUpPct:pct(positive, valid.length), marketBreadthDownPct:pct(negative, valid.length),
    directionalBreadth:currentBreadth,
    breadthMomentum:currentBreadth === null || previousBreadth === null ? null : currentBreadth - previousBreadth,
    trendUpPct:pct(valid.filter(r => r.trend > 0).length, valid.length),
    trendDownPct:pct(valid.filter(r => r.trend < 0).length, valid.length),
    crossSectionalDispersion:round(stddev(r1s)),
    directionalCoherence:round(absMean > 0 ? Math.abs(mean(r1s)) / absMean : null),
    directionalPersistencePct:pct(persistence, prior.length),
    btcAltAlignmentPct:alignable.length ? pct(alignable.filter(r => sign(r.r1) === btcDirection).length, alignable.length) : null,
    reversalFailureRatePct:pct(reversals, prior.length),
    medianRealisedVol20:round(medianVol), volatilityState:volatilityBucket(medianVol),
    btcRegime:meta.btcRegime || null, btcReturn1:round(btc?.r1), btcReturn3:round(btc?.r3),
    btcRealisedVol20:round(btc?.realisedVol20), btcShockZ:round(shockZ, 4), btcShockState:shock,
    symbolStateEncoding:'JSON_ARRAY_[symbol,close,r1,previousReturn,r3,r12,realisedVol20,trend]',
    symbolReturnState:JSON.stringify(alts.map(r => [r.symbol, round(r.close), round(r.r1),
      round(r.previousReturn), round(r.r3), round(r.r12), round(r.realisedVol20), r.trend])),
  };
  snapshots.push(snapshot);
  snapshots = snapshots.filter(x => x.barOpenAt >= barOpenAt - RETENTION_MS).slice(-MAX_SNAPSHOTS);
  schedule();
  return snapshot;
}
function project(s) {
  const m = s.marciIndependent || {}, l = s.locationResearch || {};
  return {
    id:s.id, marketSnapshotId:s.marketSnapshotId || null, symbol:s.symbol, side:s.side,
    signalSource:s.signalSource || 'ORAYAN', score:finite(s.score), rr:finite(s.rr),
    entry:finite(s.entry), sl:finite(s.sl), tp:finite(s.tp), passed:s.gates?.passed ?? null,
    failedGates:s.gates?.failed || [], btcRegime:s.btcRegime,
    structureEvent:s.structureEvent, structureTrend:s.structureTrend, timeframe:s.timeframe,
    locationBucket:l.locationBucket, retracementDepthEntry:finite(l.retracementDepthEntry),
    bbZ:finite(l.bbZ), trendLegNumber:finite(l.trendLegNumber), rizzySequence:l.rizzySequence,
    marciPatternKey:m.patternKey, marciRizzySequence:m.rizzySequence,
    marciTargetR:finite(m.targetR), marciDAtr:finite(m.dAtr),
    turnover24h:finite(s.market?.turnover24h), spreadPct:finite(s.market?.spreadPct),
  };
}
function recordEvents(signals, meta = {}) {
  const at = meta.scanAt || Date.now();
  const additions=[],signatures=[];
  for (const signal of Array.isArray(signals) ? signals : []) {
    if (!signal?.symbol || !signal?.side) continue;
    const row = project(signal);
    const candidateKey = [row.signalSource, signal.engine || '', row.symbol, row.side, row.marciPatternKey || row.structureEvent || ''].join('|');
    const signature = JSON.stringify([row.passed, [...row.failedGates].sort(), row.structureEvent,
      row.locationBucket, signal.entryPath || null]);
    if (lastEventSignature.get(candidateKey) === signature) continue;
    signatures.push([candidateKey,signature]);
    additions.push({ ...runtime.rowFields(), version:VERSION, key:`${candidateKey}|${at}`, candidateKey, signature, at,
      scanId:meta.scanId || null, marketSnapshotId:row.marketSnapshotId || meta.marketSnapshotId || null,
      configHash:meta.configHash || null, ...row });
  }
  if(!additions.length)return;
  try{
    fs.mkdirSync(eventDir,{recursive:true});
    const stamp=new Date(at).toISOString().slice(0,13).replace('T','-');
    fs.appendFileSync(path.join(eventDir,`events-${stamp}.jsonl`),
      additions.map(row=>JSON.stringify(row)).join('\n')+'\n');
    for(const [key,signature] of signatures){
      lastEventSignature.delete(key);lastEventSignature.set(key,signature);
    }
    while(lastEventSignature.size>MAX_SIGNATURES)lastEventSignature.delete(lastEventSignature.keys().next().value);
    recentEvents.push(...additions);
    if(recentEvents.length>MAX_RECENT)recentEvents.splice(0,recentEvents.length-MAX_RECENT);
    if(at-lastEventPrune>3600000){lastEventPrune=at;pruneEventFiles(at);}
  }catch(e){logger.warn('research','Could not append research events',{error:e.message});}
}
function clear() {
  snapshots = []; recentEvents.length=0; lastEventSignature.clear(); dirty = true; flush();
  store.write('researchEventsV1',[],false);
  for(const file of eventFiles())try{fs.unlinkSync(file);}catch(e){
    logger.warn('research','Could not clear research event file',{error:e.message});
  }
}
async function* legacyEventRows(file=legacyEventFile,size=null) {
  if(!fs.existsSync(file))return;
  if(size===0)return;
  const decoder=new StringDecoder('utf8');
  let depth=0,quoted=false,escaped=false,object='';
  function* scan(text) {
    for(const char of text) {
      if(depth===0){if(char==='{'){depth=1;object='{';}continue;}
      object+=char;
      if(escaped){escaped=false;continue;}
      if(char==='\\'&&quoted){escaped=true;continue;}
      if(char==='"'){quoted=!quoted;continue;}
      if(!quoted){
        if(char==='{')depth++;
        else if(char==='}'){
          depth--;
          if(depth===0){yield JSON.parse(object);object='';}
        }
      }
      if(object.length>1048576)throw Error('Legacy research event exceeds 1 MB');
    }
  }
  for await(const chunk of fs.createReadStream(file,{
    highWaterMark:65536,...(size===null?{}:{start:0,end:size-1})}))
    yield* scan(decoder.write(chunk));
  yield* scan(decoder.end());
  if(depth!==0)throw Error('Legacy research event JSON is incomplete');
}
async function* eventRows(plan) {
  const cutoff=plan.at-RETENTION_MS;
  for await(const row of legacyEventRows(legacyEventFile,plan.legacySize))
    if(Number(row.at)>=cutoff&&Number(row.at)<=plan.at)yield row;
  for(const {file,size} of plan.files){
    if(!size)continue;
    const decoder=new StringDecoder('utf8');
    let carry='';
    for await(const chunk of fs.createReadStream(file,{highWaterMark:65536,start:0,end:size-1})){
      carry+=decoder.write(chunk);
      let end;
      while((end=carry.indexOf('\n'))>=0){
        const line=carry.slice(0,end);carry=carry.slice(end+1);
        if(line.length>1048576)throw Error('Research event row exceeds 1 MB');
        if(!line)continue;
        let row;
        try{row=JSON.parse(line);}catch(e){
          logger.warn('research','Skipping malformed research event row',{file,error:e.message});
          continue;
        }
        if(Number(row.at)>=cutoff&&Number(row.at)<=plan.at)yield row;
      }
      if(carry.length>1048576)throw Error('Research event row exceeds 1 MB');
    }
    carry+=decoder.end();
    if(carry)try{
      const row=JSON.parse(carry);
      if(Number(row.at)>=cutoff&&Number(row.at)<=plan.at)yield row;
    }catch(e){logger.warn('research','Skipping incomplete final research event row',{file,error:e.message});}
  }
}
async function* environmentRows(){for(const row of snapshots)yield row;}
function csvCell(value) {
  if(value===null||value===undefined)return '';
  const s=typeof value==='object'?JSON.stringify(value):String(value);
  return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;
}
async function* serializedRows(factory,format) {
  if(format==='json'){
    yield '[';
    let first=true;
    for await(const row of factory()){yield (first?'':',')+JSON.stringify(row);first=false;}
    yield ']';
    return;
  }
  const keys=[],seen=new Set();
  for await(const row of factory())for(const key of Object.keys(row))
    if(!seen.has(key)){seen.add(key);keys.push(key);}
  if(!keys.length)return;
  yield keys.join(',')+'\n';
  for await(const row of factory())yield keys.map(key=>csvCell(row[key])).join(',')+'\n';
}
function exportStream(factory,format) {
  return {stream:Readable.from(serializedRows(factory,format)),
    contentType:format==='json'?'application/json; charset=utf-8':'text/csv; charset=utf-8'};
}
function exportEventStream(format) {
  const plan={at:Date.now(),legacySize:fs.existsSync(legacyEventFile)?fs.statSync(legacyEventFile).size:0,
    files:eventFiles().map(file=>({file,size:fs.statSync(file).size}))};
  return exportStream(()=>eventRows(plan),format);
}
// Rank the current, already-observed breadth against older snapshots of this same
// timeframe/configuration. Never include the current bar or a later observation.
function breadthPercentileAt(snapshot, decisionAt) {
  const value=finite(snapshot?.directionalBreadth);
  if (value===null || !Number.isFinite(decisionAt) || snapshot.observedAt>decisionAt ||
      !(snapshot.coveragePct>=80))
    return {value:null,category:'NOT_AVAILABLE',source:'PRIOR_MARKET_SNAPSHOTS',observedAt:null,historyCount:0};
  const prior=[];
  for (let i=snapshots.length-1;i>=0 && prior.length<192;i--) {
    const s=snapshots[i];
    if (s.timeframe!==snapshot.timeframe || s.configHash!==snapshot.configHash ||
        !(s.coveragePct>=80) ||
        s.barOpenAt>=snapshot.barOpenAt || s.observedAt>decisionAt) continue;
    const b=finite(s.directionalBreadth);
    if (b!==null) prior.push(b);
  }
  if (prior.length<24) return {value:null,category:'WARMUP',source:'PRIOR_MARKET_SNAPSHOTS',
    observedAt:snapshot.observedAt,historyCount:prior.length};
  const percentile=100*prior.filter(x=>x<=value).length/prior.length;
  return {value:round(percentile,4),category:percentile>=85?'TOP_>=85':
    percentile<=15?'BOTTOM_<=15':'MID_15_85',source:'PRIOR_MARKET_SNAPSHOTS_192_MAX',
    observedAt:snapshot.observedAt,historyCount:prior.length};
}
module.exports = {
  VERSION, observation, captureMarketSnapshot, recordEvents,
  getSnapshots:() => snapshots.slice(), getEvents:() => recentEvents.slice(),
  exportEventStream,
  exportEnvironmentStream:format=>exportStream(environmentRows,format),
  breadthPercentileAt, clear, flush,
  _test:{legacyEventRows,exportStream},
};
