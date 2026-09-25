'use strict';

// Dedicated, bounded append-only research stream. Nothing here is read by trading decisions.
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {StringDecoder}=require('string_decoder');
const store=require('./store');
const logger=require('./logger');
const runtime=require('./runtimeIdentity');
const capture=require('./researchCapture');
const {atr}=require('./indicators');
const {detectStructure}=require('./structure');
const VERSION='STRUCTURE_EVENT_RESEARCH_V1';
const STOP_VERSION='STOP_RECOVERY_LABEL_V1';
const RETENTION_MS=72*3600000;
const MAX_SEEN=20000,MAX_PENDING=1024;
const DIR=path.join(store.DATA_DIR,'research-supplement-v1');
const pendingStructure=new Map(),pendingStops=new Map(),seen=new Map();
let resolving=false,lastPrune=0;
const number=x=>x==null||x===''||!Number.isFinite(Number(x))?null:Number(x);
const round=x=>x==null||!Number.isFinite(x)?null:Math.round(x*1e8)/1e8;
const id=parts=>crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0,20);
function files(date='all') {
  if (date!=='all' && (!/^\d{4}-\d{2}-\d{2}$/.test(date)||new Date(`${date}T00:00:00Z`).toISOString().slice(0,10)!==date)) throw Error('Invalid UTC date');
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter(x=>/^supplement-\d{4}-\d{2}-\d{2}-\d{2}\.jsonl$/.test(x)&&
    (date==='all'||x.startsWith(`supplement-${date}-`))).sort().map(x=>path.join(DIR,x));
}
function prune(now=Date.now()) {
  if (!fs.existsSync(DIR)) return;
  const cutoff=now-RETENTION_MS;
  for (const file of files()) {
    const match=/supplement-(\d{4}-\d{2}-\d{2})-(\d{2})\.jsonl$/.exec(file);
    if (Date.parse(`${match[1]}T${match[2]}:00:00Z`)+3600000<cutoff) {
      try {fs.unlinkSync(file);}catch(e){logger.warn('research','Supplement prune failed',{error:e.message});}
    }
  }
  for (const [k,v] of pendingStructure) if (v.breakTs<cutoff) pendingStructure.delete(k);
  for (const [k,v] of pendingStops) if (v.stopCloseTime<cutoff) pendingStops.delete(k);
  for (const [k,at] of seen) if (at<cutoff) seen.delete(k);
}
function append(row,at=Date.now()) {
  if (seen.has(`${row.kind}|${row.eventId}`)) return false;
  try {
    fs.mkdirSync(DIR,{recursive:true});
    const hour=new Date(at).toISOString().slice(0,13).replace('T','-');
    fs.appendFileSync(path.join(DIR,`supplement-${hour}.jsonl`),
      JSON.stringify({...runtime.rowFields(),...row})+'\n');
    seen.set(`${row.kind}|${row.eventId}`,at);
    while (seen.size>MAX_SEEN) seen.delete(seen.keys().next().value);
    if (at-lastPrune>3600000) {lastPrune=at;prune(at);}
    return true;
  } catch(e) {logger.warn('research','Supplement append failed',{error:e.message});return false;}
}
function eachLine(file,visit) {
  const fd=fs.openSync(file,'r'),buffer=Buffer.allocUnsafe(65536),decoder=new StringDecoder('utf8');
  let carry='';
  try {
    let count;
    while ((count=fs.readSync(fd,buffer,0,buffer.length,null))>0) {
      carry+=decoder.write(buffer.subarray(0,count));
      let end;
      while ((end=carry.indexOf('\n'))>=0) {
        const line=carry.slice(0,end);carry=carry.slice(end+1);
        if (line) visit(line);
      }
      if (carry.length>1048576) throw Error('Supplement JSONL row exceeds 1 MB');
    }
    carry+=decoder.end();
    if (carry) visit(carry);
  } finally {fs.closeSync(fd);}
}
function trimPending() {
  for (const [map,kind] of [[pendingStructure,'structure_event_label'],[pendingStops,'stop_recovery_label']]) {
    while (map.size>MAX_PENDING) {
      const key=map.keys().next().value,row=map.get(key);
      map.delete(key);
      append({version:kind==='structure_event_label'?VERSION:STOP_VERSION,kind,eventId:key,
        at:Date.now(),symbol:row.symbol,candidateId:row.candidateId||null,
        episodeId:row.episodeId||null,status:'INCOMPLETE_CAP_EVICTION',incompleteData:true});
    }
  }
}
// Restore only bounded 72h hourly files, preserving dedupe and unfinished maturity across restart.
try {
  prune();
  for (const file of files()) eachLine(file,line=>{
    const row=JSON.parse(line);
    seen.set(`${row.kind}|${row.eventId}`,number(row.at)||Date.now());
    while (seen.size>MAX_SEEN) seen.delete(seen.keys().next().value);
    if (row.kind==='structure_event') pendingStructure.set(row.eventId,row);
    if (row.kind==='structure_event_label') pendingStructure.delete(row.eventId);
    if (row.kind==='stop_recovery_pending') pendingStops.set(row.eventId,row);
    if (row.kind==='stop_recovery_label') pendingStops.delete(row.eventId);
  });
  trimPending();
} catch(e) {logger.warn('research','Supplement restore failed',{error:e.message});}
function observeStructure({symbol,candles,ticker,tickerDynamic,settings,scanAt,configHash,marketSnapshotId,marketSnapshot,signals=[]}) {
  if (!Array.isArray(candles)||candles.length<10) return null;
  const tfMs=Math.max(60000,Number(settings.timeframe||15)*60000);
  const struct=detectStructure(candles,Math.max(2,Math.round(Number(settings.pivotWidth||2))));
  if (!/^(BOS|CHOCH)_(UP|DOWN)$/.test(struct.event)||struct.eventIndex==null) return null;
  const bar=candles[struct.eventIndex],breakTs=bar?.ts+tfMs,level=number(struct.brokenLevel);
  if (!(breakTs>0)||!(level>0)||breakTs>scanAt+1000||breakTs<scanAt-RETENTION_MS) return null;
  const side=struct.event.endsWith('UP')?'BUY':'SELL',type=struct.event.startsWith('BOS')?'BOS':'CHOCH';
  const eventId=id(['structure',symbol,settings.timeframe,side,breakTs,level]);
  if (seen.has(`structure_event|${eventId}`)) return eventId;
  const prior=candles.slice(0,struct.eventIndex+1),a=atr(prior,14);
  const priorTurn=prior.slice(-20,-1).map(x=>number(x.turnover)).filter(x=>x>0);
  const later=candles.slice(struct.eventIndex+1);
  const retestDepthATR=a>0&&later.length?round(Math.max(0,side==='BUY'
    ?level-Math.min(...later.map(x=>x.low)):Math.max(...later.map(x=>x.high))-level)/a):null;
  const pivot=side==='BUY'?struct.lastHigh:struct.lastLow;
  const matched=signals.find(s=>s.symbol===symbol&&s.structureEvent===struct.event&&s.engine==='STRUCTURE');
  const link=matched?capture.candidateLink(matched.id):null;
  const liquidationAtObservation=capture.liquidationWindows(symbol,breakTs,scanAt);
  const row={version:VERSION,kind:'structure_event',eventId,at:Date.now(),observedAt:scanAt,
    candidateKey:link?.key||null,episodeId:link?.episodeId||null,engine:'NEW_ORAYAN',engineVariant:'STRUCTURE',
    symbol,side,structureType:type,structureSide:side,breakTs,breakLevel:level,breakClose:number(bar.close),
    timeframeMin:Number(settings.timeframe||15),displacementATR:a>0?round(Math.abs(bar.close-bar.open)/a):null,
    closeBeyondLevelATR:a>0?round((side==='BUY'?bar.close-level:level-bar.close)/a):null,
    barsSincePivot:pivot?struct.eventIndex-pivot.i:null,retestDepthATR,
    oiChangePct:tickerDynamic?.openInterestChangePct??null,
    turnoverShock:priorTurn.length>=15&&number(bar.turnover)>0?
      round(number(bar.turnover)/(priorTurn.reduce((s,x)=>s+x,0)/priorTurn.length)):null,
    btcRegime:marketSnapshot?.btcRegime||null,breadth:marketSnapshot?.directionalBreadth??null,
    breadthMomentum:marketSnapshot?.breadthMomentum??null,
    contextObservedAt:scanAt,configHash,marketSnapshotId:marketSnapshotId||null,testnet:!!settings.testnet};
  row.liquidationPreAtObservation=liquidationAtObservation.coverage!=='GAP_OR_WARMUP' ? {
    pre5:liquidationAtObservation.pre5,pre1:liquidationAtObservation.pre1,
    baselineMean1m:liquidationAtObservation.baselineMean1m,
    baselineSd1m:liquidationAtObservation.baselineSd1m} : null;
  if (append(row)) {pendingStructure.set(eventId,row);trimPending();}
  return eventId;
}
function observeStop(trade,link={}) {
  if (!trade||trade.status!=='CLOSED'||trade.engine==='MARCI_SHADOW'||trade.researchEngine?.startsWith('MARCI')) return null;
  if (trade.mode!=='paper'||typeof trade.testnet!=='boolean'||
    !['Stop loss','Stop and target both inside one candle — resolved as a loss, order unknowable at this resolution'].includes(trade.closeReason)) return null;
  const at=number(trade.closedAt),entry=number(trade.fillPrice),sl=number(trade.sl),tp=number(trade.tp);
  if (!(at>0&&entry>0&&sl>0&&tp>0)||Date.now()-at>RETENTION_MS) return null;
  const eventId=id(['stop',trade.id,at]);
  if (seen.has(`stop_recovery_pending|${eventId}`)||seen.has(`stop_recovery_label|${eventId}`)) return eventId;
  const a=number(trade.atrAtBirth),risk=Math.abs(entry-sl),level=number(trade.structureBreakLevel);
  const row={version:STOP_VERSION,kind:'stop_recovery_pending',eventId,at:Date.now(),tradeId:trade.id,
    candidateId:trade.signalId||null,candidateKey:link.key||trade.candidateKey||null,
    episodeId:link.episodeId||trade.episodeId||null,
    engine:'NEW_ORAYAN',symbol:trade.symbol,side:trade.side,stopCloseTime:at,
    stopCloseTimePrecision:'ONE_MINUTE_BAR_OPEN',
    entry,sl,tp,stopExitPrice:number(trade.exitPrice),stopWidthPct:round(100*risk/entry),stopWidthATR:a>0?round(risk/a):null,
    structureRelativeDistanceATR:a>0&&level>0?round(Math.abs(sl-level)/a):null,
    firstMinuteAmbiguityFlag:true,
    stopAndTargetSameMinuteFlag:trade.closeReason!=='Stop loss',
    configHash:link.configHash||trade.configHash||null,
    marketSnapshotId:link.marketSnapshotId||trade.marketSnapshotId||null,testnet:!!trade.testnet};
  if (append(row)) {pendingStops.set(eventId,row);trimPending();}
  return eventId;
}
function directionalReturn(base,close,side) {return base>0&&close>0?round((side==='SELL'?-1:1)*(close/base-1)):null;}
function structureLabel(ev,bars,liq) {
  if (ev.liquidationPreAtObservation) {
    liq.pre5=liq.pre5||ev.liquidationPreAtObservation.pre5;
    liq.pre1=liq.pre1||ev.liquidationPreAtObservation.pre1;
    const mean=ev.liquidationPreAtObservation.baselineMean1m;
    const sigma=ev.liquidationPreAtObservation.baselineSd1m;
    liq.intensityZ=liq.post5&&mean!==null&&sigma>0?round((liq.post5.totalNotional/5-mean)/sigma):null;
    liq.coverage=liq.pre5&&liq.post5?'FULL':'GAP_OR_WARMUP';
  }
  const usable=bars.filter(x=>x.ts>=ev.breakTs&&x.ts<ev.breakTs+60*60000);
  const horizon=h=>usable.filter(x=>x.ts+60000<=ev.breakTs+h*60000);
  const covered=h=>horizon(h).length>=h;
  const close=h=>covered(h)?horizon(h).at(-1)?.close:null;
  const failed=h=>covered(h)?horizon(h).some(x=>ev.side==='BUY'?x.close<ev.breakLevel:x.close>ev.breakLevel):null;
  const f15=failed(15),f30=failed(30),f60=failed(60);
  return {version:VERSION,kind:'structure_event_label',eventId:ev.eventId,at:Date.now(),breakTs:ev.breakTs,
    symbol:ev.symbol,side:ev.side,candidateKey:ev.candidateKey,episodeId:ev.episodeId,
    configHash:ev.configHash,marketSnapshotId:ev.marketSnapshotId,
    directionalReturn15m:directionalReturn(ev.breakClose,close(15),ev.side),
    directionalReturn30m:directionalReturn(ev.breakClose,close(30),ev.side),
    directionalReturn60m:directionalReturn(ev.breakClose,close(60),ev.side),
    failedWithin15m:f15,failedWithin30m:f30,failedWithin60m:f60,
    held15m:f15===null?null:!f15,held30m:f30===null?null:!f30,held60m:f60===null?null:!f60,
    liquidation:liq,barsEvaluated:usable.length,
    holdFailRule:'NO_CLOSED_1M_CLOSE_BACK_THROUGH_BREAK_LEVEL',
    source:'Bybit closed 1m candles; in-memory Bybit allLiquidation'};
}
function stopLabel(ev,bars) {
  // The stop minute is excluded: OHLC cannot order the stop and subsequent movement.
  const usable=bars.filter(x=>x.ts>=ev.stopCloseTime+60000&&x.ts<ev.stopCloseTime+60*60000);
  const dir=ev.side==='SELL'?-1:1, risk=Math.abs(ev.entry-ev.sl);
  const result={version:STOP_VERSION,kind:'stop_recovery_label',eventId:ev.eventId,at:Date.now(),
    tradeId:ev.tradeId,candidateId:ev.candidateId,candidateKey:ev.candidateKey,episodeId:ev.episodeId,
    symbol:ev.symbol,side:ev.side,stopCloseTime:ev.stopCloseTime,entry:ev.entry,sl:ev.sl,tp:ev.tp,
    stopCloseTimePrecision:ev.stopCloseTimePrecision||'ONE_MINUTE_BAR_OPEN',
    stopWidthPct:ev.stopWidthPct,stopWidthATR:ev.stopWidthATR,structureRelativeDistanceATR:ev.structureRelativeDistanceATR,
    stopExitPrice:ev.stopExitPrice,
    firstMinuteAmbiguityFlag:ev.firstMinuteAmbiguityFlag,configHash:ev.configHash,
    marketSnapshotId:ev.marketSnapshotId,postStopMinuteExcluded:true,barsEvaluated:usable.length};
  for (const h of [15,30,60]) {
    const sub=usable.filter(x=>x.ts+60000<=ev.stopCloseTime+h*60000);
    const complete=sub.length>=h-1;
    result[`entryRecoveredWithin${h}m`]=complete?sub.some(x=>dir>0?x.high>=ev.entry:x.low<=ev.entry):null;
    result[`originalTpReachedWithin${h}m`]=complete?sub.some(x=>dir>0?x.high>=ev.tp:x.low<=ev.tp):null;
  }
  const rec=usable.find(x=>dir>0?x.high>=ev.entry:x.low<=ev.entry);
  const tp=usable.find(x=>dir>0?x.high>=ev.tp:x.low<=ev.tp);
  result.timeToRecoveryMin=rec?round((rec.ts-ev.stopCloseTime)/60000):null;
  result.timeToOriginalTpMin=tp?round((tp.ts-ev.stopCloseTime)/60000):null;
  const exit=ev.stopExitPrice>0?ev.stopExitPrice:ev.sl;
  result.postStopMfeR=risk>0?round(Math.max(0,...usable.map(x=>dir>0?(x.high-exit)/risk:(exit-x.low)/risk))):null;
  result.postStopMaeR=risk>0?round(Math.max(0,...usable.map(x=>dir>0?(exit-x.low)/risk:(x.high-exit)/risk))):null;
  result.maxOvershootBeyondSl=risk>0?round(Math.max(0,...usable.map(x=>dir>0?ev.sl-x.low:x.high-ev.sl))):null;
  result.maxOvershootBeyondSlR=risk>0?round(result.maxOvershootBeyondSl/risk):null;
  return result;
}
async function fetchBars(symbol,start,end,testnet) {
  const res=await capture.researchGet('/v5/market/kline',{category:'linear',symbol,interval:'1',start,end,limit:1000},testnet);
  return (res?.list||[]).map(x=>({ts:number(x[0]),high:number(x[2]),low:number(x[3]),close:number(x[4])}))
    .filter(x=>x.ts!==null&&x.high!==null&&x.low!==null&&x.close!==null).sort((a,b)=>a.ts-b.ts);
}
async function resolveDue(limit=8) {
  if (resolving) return;
  resolving=true;
  try {
    const now=Date.now();
    if (now-lastPrune>3600000) {lastPrune=now;prune(now);}
    const due=[...pendingStructure.values()].map(x=>({kind:'structure',x,time:x.breakTs}))
      .concat([...pendingStops.values()].map(x=>({kind:'stop',x,time:x.stopCloseTime})))
      .filter(v=>now>=v.time+62*60000&&now>=(v.x.nextAttemptAt||0)).sort((a,b)=>a.time-b.time).slice(0,limit);
    for (const v of due) try {
      const bars=await fetchBars(v.x.symbol,v.time,v.time+61*60000,v.x.testnet);
      if (bars.length<55) {v.x.nextAttemptAt=Date.now()+120000;continue;} // retry incomplete public history
      const row=v.kind==='structure'?structureLabel(v.x,bars,capture.liquidationWindows(v.x.symbol,v.time,Date.now())):stopLabel(v.x,bars);
      if (append(row)) (v.kind==='structure'?pendingStructure:pendingStops).delete(v.x.eventId);
    } catch(e) {
      v.x.nextAttemptAt=Date.now()+120000;
      logger.warn('research','Supplement label resolution failed',{symbol:v.x.symbol,error:e.message});
    }
  } finally {resolving=false;}
}
module.exports={VERSION,STOP_VERSION,observeStructure,observeStop,resolveDue,files,prune,structureLabel,stopLabel};
