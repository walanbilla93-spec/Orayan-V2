'use strict';

// Observational data only. No exports from this module feed builders, gates, ranking or orders.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const logger = require('./logger');
const journal = require('./journal');
const crypto = require('crypto');
const {StringDecoder}=require('string_decoder');
const retraceShadow = require('./retraceShadow');
const bybit = require('./bybit');
const runtime = require('./runtimeIdentity');
const VERSION = 'PROSPECTIVE_BIRTH_V2';
const COMPACT_VERSION = 'PROSPECTIVE_COMPACT_V4';
const dir = path.join(store.DATA_DIR, 'research-v2');
const RETENTION_MS = 48 * 60 * 60 * 1000;
const lastCandidate = new Map();
const lastOutcome = new Map();
const candidateKeysById = new Map();
const MAX_CANDIDATE_LINKS=20000,MAX_OUTCOME_KEYS=20000;
let lastPruneAt = 0;
const liquidations = new Map();
const seenLiquidation = new Map();
const priorTickers = new Map();
const pendingForward = new Map();
const MAX_PENDING_FORWARD = 2048;
const resolvedForward = new Map();
const flowCache = new Map();
const httpCache = new Map(); // at most 16 short-lived research responses/promises
const flowLabelled = new Set();
const flowScheduled = new Set();
const pendingOrderFlow = [];
const MAX_PENDING_ORDER_FLOW = 1024;
let orderFlowPumping = false;
let forwardTimer = null, forwardResolving = false;
let socket, reconnect, heartbeat, subscribed = new Set(), wanted = new Set(), testnetMode = null;
let confirmed = new Set(), pendingBatches = new Map(), requestNumber = 0;
let confirmedAt = new Map();
let connectedAt = null, lastMessageAt = null, lastSocketMessageAt = null, gapSince = Date.now();

const n = v => { const x = Number(v); return v == null || v === '' || !Number.isFinite(x) ? null : x; };
const r = v => v == null || !Number.isFinite(v) ? null : Math.round(v * 1e8) / 1e8;
const avg = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const sd = xs => xs.length > 1 ? Math.sqrt(avg(xs.map(x => (x - avg(xs)) ** 2))) : null;
function append(kind, row, at = Date.now()) {
  try {
    fs.mkdirSync(dir, { recursive:true });
    const stamp = new Date(at).toISOString().slice(0, kind === 'compact' ? 13 : 10).replace('T','-');
    fs.appendFileSync(path.join(dir, `${kind}-${stamp}.jsonl`),
      JSON.stringify({recordType:kind,...runtime.rowFields(),...row}) + '\n');
    if (at - lastPruneAt > 60 * 60000) { lastPruneAt = at; prune(at); }
    return true;
  } catch (e) { logger.warn('research', `Could not append ${kind}`, { error:e.message }); return false; }
}
bybit.setOperationalSink(event => append('compact',{version:COMPACT_VERSION,kind:'operational_event',
  eventId:digest(['bybit-operational',event.type,event.at,event.endpoint]),...event},event.at));
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
      if (carry.length>1048576) throw Error('Prospective JSONL row exceeds 1 MB');
    }
    carry+=decoder.end();
    if (carry) visit(carry);
  } finally {fs.closeSync(fd);}
}
function prune(now = Date.now()) {
  if (!fs.existsSync(dir)) return;
  const cutoff = now - RETENTION_MS;
  for (const name of fs.readdirSync(dir)) {
    const match = /^(compact|births|outcomes|liquidations|coverage)-(\d{4}-\d{2}-\d{2})(?:-(\d{2}))?\.jsonl$/.exec(name);
    if (!match) continue;
    const end = Date.parse(`${match[2]}T${match[3]||'00'}:00:00Z`) + (match[3] ? 3600000 : 86400000);
    if (end < cutoff) { try { fs.unlinkSync(path.join(dir,name)); } catch (_) {} }
  }
  for (const [key, value] of lastCandidate) if (value.at < cutoff) lastCandidate.delete(key);
  for (const [key, value] of lastOutcome) if (value.at < cutoff) lastOutcome.delete(key);
  for (const [key, value] of candidateKeysById) if (value.at < cutoff) candidateKeysById.delete(key);
  for (const [key, value] of pendingForward) if (value.at < cutoff) pendingForward.delete(key);
  for (const [key,at] of resolvedForward) if (at<cutoff) resolvedForward.delete(key);
  for (const [symbol, value] of flowCache) if (value.at < now - 5*60000) flowCache.delete(symbol);
}
function keyFor(signal) {
  const engine = signal.signalSource?.startsWith('MARCI') ? 'MARCI' : 'NEW_ORAYAN';
  const identity = signal.marciIndependent?.patternKey || [signal.engine || signal.entryPath || '',signal.structureEvent || ''].join(':');
  return [engine,signal.symbol,signal.side,identity].join('|');
}
function capMap(map,max) {while (map.size>max) map.delete(map.keys().next().value);}
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,16); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((o,k) => {
    if (value[k] !== undefined && typeof value[k] !== 'function') o[k] = stable(value[k]);
    return o;
  }, {});
  return value;
}
function settingsHash(settings) {
  // Settings contain no API credentials; hash the effective runtime configuration so research
  // cohorts can prove they came from the same frozen setup without repeating the whole object.
  return digest(stable(settings || {}));
}
function capPendingForward() {
  while (pendingForward.size>MAX_PENDING_FORWARD) {
    const oldest=pendingForward.keys().next().value, birth=pendingForward.get(oldest);
    pendingForward.delete(oldest);
    resolvedForward.set(oldest,Date.now());
    append('compact',{version:COMPACT_VERSION,kind:'forward_label',
      eventId:digest(['forward',oldest,birth.at]),at:Date.now(),episodeId:oldest,
      candidateId:birth.candidateId,candidateKey:birth.candidateKey,
      symbol:birth.symbol,side:birth.side,status:'INCOMPLETE_CAP_EVICTION',incompleteData:true});
  }
  capResearchIndexes();
}
function capResearchIndexes() {
  while (resolvedForward.size>50000) resolvedForward.delete(resolvedForward.keys().next().value);
  while (flowLabelled.size>4096) flowLabelled.delete(flowLabelled.values().next().value);
}
async function researchGet(pathname, params, testnet, {notBefore=0}={}) {
  const ttl=pathname==='/v5/market/kline' ? 300000 : pathname==='/v5/market/tickers' ? 2000 : 10000;
  const key=JSON.stringify([pathname,params,!!testnet]);
  const now=Date.now(), hit=httpCache.get(key);
  if (hit && hit.at>=notBefore && now-hit.at<ttl) return hit.promise;
  const promise=bybit.researchGet(pathname,params,testnet);
  httpCache.set(key,{at:now,promise});
  promise.catch(()=>{if(httpCache.get(key)?.promise===promise) httpCache.delete(key);});
  while (httpCache.size>16) httpCache.delete(httpCache.keys().next().value);
  return promise;
}
function geometryBucket(value) { return value > 0 ? Math.round(200*Math.log(value)) : null; }
function compactFiles(date = 'all') {
  if (date !== 'all' && (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0,10) !== date)) throw new Error('Invalid UTC date');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => /^compact-\d{4}-\d{2}-\d{2}-\d{2}\.jsonl$/.test(name) && (date === 'all' || name.startsWith(`compact-${date}-`)))
    .sort().map(name => path.join(dir,name));
}
// Restore the small semantic index after restart, so a restart does not re-emit every setup.
try {
  prune(Date.now());
  // Only recent compact rows are needed to rebuild the live semantic index. Candidate
  // continuity is 30m and forward labels mature after ~62m. Re-reading the entire 48h
  // prospective archive on every container restart temporarily materialises tens of MB of
  // JSON strings/arrays and was enough to tip small Northflank containers into heap OOM.
  // Keep the full files on disk for export; restore only the last 3h into process memory.
  const restoreCutoff = Date.now() - 3*3600000;
  const restoreFiles = compactFiles().filter(file => {
    const m=/compact-(\d{4}-\d{2}-\d{2})-(\d{2})\.jsonl$/.exec(file);
    return !m || Date.parse(`${m[1]}T${m[2]}:00:00Z`)+3600000 >= restoreCutoff;
  });
  // First discover completions, then restore only unresolved births. This avoids
  // evicting and mislabelling an old birth before its later forward label is read.
  for (const file of restoreFiles) eachLine(file,line=>{
    const row=JSON.parse(line);
    if (row.kind==='forward_label' && row.episodeId)
      resolvedForward.set(row.episodeId,row.at||Date.now());
    if (row.kind==='order_flow_label' && row.candidateId) flowLabelled.add(row.candidateId);
    if (row.kind==='order_outcome')
      lastOutcome.set(`${row.candidateId}|${row.event}|${row.tradeId||''}`,{at:row.at,signature:row.signature});
    capResearchIndexes();
    capMap(lastOutcome,MAX_OUTCOME_KEYS);
  });
  for (const file of restoreFiles) eachLine(file,line=>{
    const row = JSON.parse(line);
    if (row.kind === 'candidate_birth' || row.kind === 'candidate_update') {
      const prior=lastCandidate.get(row.candidateKey);
      lastCandidate.set(row.candidateKey,
        {at:row.at,signature:row.signature,episodeId:row.episodeId,
          originAt:row.kind==='candidate_birth'?row.at:(prior?.originAt??row.episodeOriginAt??row.at),
          originBtcRegime:row.kind==='candidate_birth'?(row.btcRegime||null):(prior?.originBtcRegime??row.originBtcRegime??null)});
    }
    if (row.candidateId && row.candidateKey) candidateKeysById.set(row.candidateId,
      {key:row.candidateKey,episodeId:row.episodeId,at:row.at,originAt:row.episodeOriginAt??row.at,
        originBtcRegime:row.originBtcRegime??row.btcRegime??null,isBirth:row.kind==='candidate_birth',
        engine:row.engine,configHash:row.configHash||null,
        retraceStateShadow:row.retraceStateShadow||null});
    capMap(candidateKeysById,MAX_CANDIDATE_LINKS);
    if (row.kind === 'candidate_birth' && row.episodeId && !resolvedForward.has(row.episodeId)) {
      pendingForward.set(row.episodeId,row);
      capPendingForward();
    }
  });
  // A process may stop after the durable birth append but before the asynchronous request
  // finishes. Such births cannot be reconstructed from a later recent-trade response without
  // backdating. Close them explicitly instead of leaving a permanently missing join.
  for (const file of restoreFiles) eachLine(file,line=>{
    const row=JSON.parse(line);
    if (row.kind==='candidate_birth' && row.candidateId && !flowLabelled.has(row.candidateId)) {
      appendOrderFlowTerminal(row,{status:'NOT_AVAILABLE',reasonCode:'RESTART_OR_RETENTION',
        detail:'Birth restored without a durable order-flow terminal row'});
    }
  });
  capPendingForward();
  capResearchIndexes();
} catch (e) { logger.warn('research','Could not restore compact research index',{error:e.message}); }
function cleanOld(now) {
  for (const [symbol, rows] of liquidations) {
    // The 60m forward structure label still needs the five minutes before the break.
    const kept = rows.filter(x => x.timestamp >= now - 90 * 60000);
    if (kept.length) liquidations.set(symbol, kept); else liquidations.delete(symbol);
  }
  for (const [key, at] of seenLiquidation) if (at < now - 60000) seenLiquidation.delete(key);
}
// A null window means the live stream did not continuously cover that interval. Bybit's
// liquidation side is the liquidated position side: Sell liquidates a long, Buy a short.
function liquidationWindows(symbol, breakTs, asOf = Date.now()) {
  const continuous = connectedAt !== null && socket?.readyState === 1 && lastSocketMessageAt !== null
    && asOf-lastSocketMessageAt<=60000 && confirmed.has(symbol)
    && confirmedAt.get(symbol) <= breakTs - 5*60000;
  const preCovered = continuous && asOf>=breakTs && asOf-breakTs<=80*60000;
  const postCovered = continuous && asOf>=breakTs+5*60000 && asOf-breakTs<=80*60000;
  const rows = (liquidations.get(symbol) || []).filter(x => x.receivedAt <= asOf);
  const window = (from, to, covered) => {
    if (!covered) return null;
    return liquidationWindowTotals(rows,breakTs,from,to);
  };
  const pre5=window(-5*60000,0,preCovered),pre1=window(-60000,0,preCovered);
  const post1=window(0,60000,postCovered),post5=window(0,5*60000,postCovered);
  const baseline=[];
  if (preCovered && confirmedAt.get(symbol)<=breakTs-50*60000 && asOf-breakTs<=30*60000) for (let i=0;i<45;i++) {
    const end=breakTs-(i+5)*60000;
    baseline.push(rows.filter(x=>x.timestamp>=end-60000&&x.timestamp<end).reduce((a,x)=>a+x.notional,0));
  }
  const sigma=sd(baseline);
  return {coverage:pre5&&post5?'FULL':pre5?'PRE_ONLY':'GAP_OR_WARMUP',pre5,pre1,post1,post5,
    baselineMean1m:baseline.length?roundOrNull(avg(baseline)):null,
    baselineSd1m:sigma>0?r(sigma):null,
    intensityZ:pre5&&post5&&sigma>0?r((post5.totalNotional/5-avg(baseline))/sigma):null,
    sideMeaning:'Sell=long liquidation; Buy=short liquidation',source:'in_memory_Bybit_allLiquidation'};
}
function roundOrNull(x) { return x==null?null:r(x); }
function liquidationWindowTotals(rows,breakTs,from,to) {
  const selected=(rows||[]).filter(x=>x.timestamp >= breakTs+from && x.timestamp < breakTs+to);
  const long=selected.filter(x=>x.side==='Sell').reduce((a,x)=>a+x.notional,0);
  const short=selected.filter(x=>x.side==='Buy').reduce((a,x)=>a+x.notional,0);
  return {longNotional:r(long),shortNotional:r(short),totalNotional:r(long+short)};
}
function candidateLink(candidateId) { return candidateKeysById.get(candidateId) || null; }
function ingest(message, receivedAt = Date.now()) {
  if (!message?.topic?.startsWith('allLiquidation.') || !Array.isArray(message.data)) return;
  lastMessageAt = receivedAt;
  for (const x of message.data) {
    const symbol = String(x.s || ''), side = x.S, size = n(x.v), price = n(x.p), timestamp = n(x.T);
    if (!/^[A-Z0-9]+USDT$/.test(symbol) || !['Buy','Sell'].includes(side) || !(size > 0) || !(price > 0)
      || !(timestamp > 0) || timestamp > receivedAt + 60000 || timestamp < receivedAt - 60000) continue;
    const key = [symbol, side, size, price, timestamp].join('|');
    if (seenLiquidation.has(key)) continue;
    seenLiquidation.set(key, receivedAt);
    const row = { version:VERSION, source:'Bybit allLiquidation', symbol, side, size, price,
      priceMeaning:'bankruptcy_price', timestamp, receivedAt, notional:size * price,
      testnet:testnetMode };
    if (!liquidations.has(symbol)) liquidations.set(symbol, []);
    liquidations.get(symbol).push(row);
    // Raw 500 ms stream stays in the bounded in-memory window. Candidate rows retain
    // compact rolling aggregates; the public stream is not duplicated on disk.
  }
  cleanOld(receivedAt);
}
function subscribe(symbols) {
  if (!socket || socket.readyState !== 1) return;
  const missing = [...symbols].filter(s => !subscribed.has(s));
  const removed = [...subscribed].filter(s => !symbols.has(s));
  for (const [op, list] of [['unsubscribe', removed], ['subscribe', missing]]) {
    for (let i = 0; i < list.length; i += 50) {
      const batch = list.slice(i, i+50), req_id = `research_${++requestNumber}`;
      pendingBatches.set(req_id, {op,batch});
      socket.send(JSON.stringify({ op, req_id, args:batch.map(s => `allLiquidation.${s}`) }));
    }
  }
  for (const s of removed) { subscribed.delete(s); confirmed.delete(s); confirmedAt.delete(s); }
  for (const s of missing) subscribed.add(s);
}
function connect() {
  if (!wanted.size || socket || testnetMode === null) return;
  let WS;
  try { WS = require('ws'); } catch (e) { logger.warn('research', 'ws package missing; liquidation capture unavailable', { error:e.message }); return; }
  const url = testnetMode ? 'wss://stream-testnet.bybit.com/v5/public/linear' : 'wss://stream.bybit.com/v5/public/linear';
  try { socket = new WS(url); } catch (e) { logger.warn('research', 'Liquidation socket failed', { error:e.message }); socket = null; return; }
  socket.on('open', () => {
    connectedAt = Date.now(); lastSocketMessageAt=connectedAt; gapSince = null; subscribed = new Set(); confirmed = new Set(); confirmedAt = new Map(); pendingBatches = new Map(); subscribe(wanted);
    heartbeat = setInterval(() => { if (socket?.readyState === 1) socket.send(JSON.stringify({ op:'ping' })); }, 20000);
    if (heartbeat.unref) heartbeat.unref();
  });
  socket.on('message', raw => { try {
    lastSocketMessageAt=Date.now();
    const msg = JSON.parse(String(raw));
    const pending = pendingBatches.get(msg.req_id);
    if (pending && msg.op === pending.op) {
      pendingBatches.delete(msg.req_id);
      if (msg.success === true && pending.op === 'subscribe') for (const s of pending.batch) { confirmed.add(s); confirmedAt.set(s,Date.now()); }
      if (msg.success !== true) logger.warn('research', 'Liquidation subscription rejected', { req_id:msg.req_id, ret_msg:msg.ret_msg });
    }
    ingest(msg);
  } catch (_e) { /* malformed public message */ } });
  socket.on('error', e => logger.warn('research', 'Liquidation stream error', { error:e.message }));
  socket.on('close', () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null; socket = null; subscribed = new Set(); confirmed = new Set(); confirmedAt = new Map(); pendingBatches = new Map(); connectedAt = null; lastSocketMessageAt=null; gapSince = Date.now();
    append('coverage', { version:VERSION, event:'stream_disconnected', at:gapSince, testnet:testnetMode });
    reconnect = setTimeout(connect, 5000);
    if (reconnect.unref) reconnect.unref();
  });
}
function watch(symbols, testnet) {
  const next = new Set([...symbols, 'BTCUSDT'].filter(s => /^[A-Z0-9]+USDT$/.test(s)));
  if (testnetMode !== null && testnetMode !== !!testnet) stop();
  startForwardResolver();
  testnetMode = !!testnet; wanted = next;
  if (socket?.readyState === 1) subscribe(wanted); else connect();
}
function stop() {
  if (reconnect) clearTimeout(reconnect);
  if (forwardTimer) clearInterval(forwardTimer);
  if (heartbeat) clearInterval(heartbeat);
  reconnect = heartbeat = forwardTimer = null; wanted = new Set();
  if (socket) { const old = socket; socket = null; old.removeAllListeners('close'); old.close(); }
  connectedAt = null; lastSocketMessageAt=null; gapSince = Date.now(); subscribed = new Set(); confirmed = new Set(); confirmedAt = new Map(); pendingBatches = new Map();
}
function liquidationFeatures(symbol, at, price, turnover24h) {
  const covered = connectedAt !== null && (!gapSince || gapSince > at) && confirmed.has(symbol);
  const rows = (liquidations.get(symbol) || []).filter(x => x.receivedAt <= at && x.timestamp <= at);
  const total = mins => rows.filter(x => x.timestamp > at - mins * 60000).reduce((s, x) => s + x.notional, 0);
  const buy = rows.filter(x => x.timestamp > at - 5*60000 && x.side === 'Buy').reduce((s,x) => s+x.notional,0);
  const sell = rows.filter(x => x.timestamp > at - 5*60000 && x.side === 'Sell').reduce((s,x) => s+x.notional,0);
  const minuteBins = Array.from({length:45}, (_,i) => rows.filter(x => x.timestamp > at-(i+16)*60000 && x.timestamp <= at-(i+15)*60000).reduce((s,x)=>s+x.notional,0));
  const baseSd = sd(minuteBins), total1 = total(1);
  const nearest = rows.length && price > 0 ? Math.min(...rows.filter(x=>x.timestamp > at-5*60000).map(x=>Math.abs(x.price/price-1)*100)) : null;
  return { coverage:covered ? (at-connectedAt >= 15*60000 ? 'FULL_15M' : 'WARMUP') : 'GAP',
    connectedAt, lastMessageAt, gapSince, notional1m:covered ? r(total1):null,
    notional5m:covered ? r(total(5)):null, notional15m:covered ? r(total(15)):null,
    buyNotional5m:covered ? r(buy):null, sellNotional5m:covered ? r(sell):null,
    imbalance5m:covered && buy+sell ? r((buy-sell)/(buy+sell)):null,
    intensity5mVs24hHourlyTurnover:covered && turnover24h>0 ? r(total(5)/(turnover24h/24)):null,
    nearestBankruptcyPriceDistancePct:r(nearest), shockZ1m:covered && baseSd>0 ? r((total1-avg(minuteBins))/baseSd):null };
}
function ema(xs, period) { if (!xs.length) return null; const a=2/(period+1); return xs.reduce((v,x,i)=>i?a*x+(1-a)*v:x,0); }
function features(candles, side, btc, universe) {
  const c = candles.filter(x => n(x.close)>0), closes=c.map(x=>Number(x.close)), last=closes.at(-1);
  if (closes.length<22) return { available:false };
  const returns=closes.slice(1).map((x,i)=>Math.log(x/closes[i]));
  const vol=sd(returns.slice(-20));
  const tr=c.slice(1).map((x,i)=>Math.max(x.high-x.low, Math.abs(x.high-c[i].close), Math.abs(x.low-c[i].close)));
  const atr=avg(tr.slice(-14));
  const dir=side==='BUY'?1:-1;
  const ret=h=>closes.length>h? Math.log(last/closes.at(-1-h)):null;
  const prevEma=ema(closes.slice(0,-3),20), currentEma=ema(closes,20);
  const persistence=returns.slice(-12).filter(x=>Math.sign(x)===dir).length/12;
  const btcReturn=btc?.r12, uniReturn=universe?.r12Median;
  const recent=c.slice(-20), extreme=dir>0?Math.max(...recent.map(x=>x.high)):Math.min(...recent.map(x=>x.low));
  const recentTurn=recent.map(x=>n(x.turnover)).filter(x=>x!==null);
  return { available:true, closedBarOpenAt:c.at(-1).ts, atr14:r(atr), realisedVol20:r(vol),
    return3:r(ret(3)), return12:r(ret(12)), return48:r(ret(48)),
    directionalReturn3Vol:r(vol>0?dir*ret(3)/(vol*Math.sqrt(3)):null),
    directionalReturn12Vol:r(vol>0?dir*ret(12)/(vol*Math.sqrt(12)):null),
    directionalReturn48Vol:r(vol>0&&ret(48)!==null?dir*ret(48)/(vol*Math.sqrt(48)):null),
    ema20Slope3Atr:r(atr>0?dir*(currentEma-prevEma)/atr:null),
    directionalPersistence12:r(persistence),
    acceleration3VsPrevious3:r(ret(3)!==null&&closes.length>6?dir*(ret(3)-Math.log(closes.at(-4)/closes.at(-7))):null),
    distanceFromRecentExtremeAtr:r(atr>0?dir*(extreme-last)/atr:null),
    relativeReturn12VsBtc:r(btcReturn==null?null:dir*(ret(12)-btcReturn)),
    relativeReturn12VsUniverse:r(uniReturn==null?null:dir*(ret(12)-uniReturn)),
    turnoverLast3VsPrior17:r(recentTurn.length>=20&&avg(recentTurn.slice(0,17))>0?avg(recentTurn.slice(-3))/avg(recentTurn.slice(0,17)):null) };
}
function tickerDynamics(tickers, at) {
  const out = new Map();
  const btcFunding = n(tickers.find(t => t.symbol === 'BTCUSDT')?.fundingRate);
  for (const t of tickers) {
    const prior = priorTickers.get(t.symbol), oi = n(t.openInterest), oldOi = n(prior?.openInterest);
    out.set(t.symbol, { openInterestChangePct:prior && oi>0 && oldOi>0 ? r(100*(oi/oldOi-1)):null,
      openInterestPriorAt:prior?.at||null,
      fundingDivergenceVsBtc:btcFunding!==null&&n(t.fundingRate)!==null ? r(n(t.fundingRate)-btcFunding):null });
    if (!prior || at > prior.at) priorTickers.set(t.symbol, {at,openInterest:oi});
  }
  return out;
}

async function recentTradeFlow(symbol, observedForAt, testnet) {
  const bucket = Math.floor(observedForAt / 10000) * 10000;
  const cacheKey = `${symbol}|${bucket}|${testnet ? 1 : 0}`;
  const hit = flowCache.get(cacheKey);
  if (hit) return hit.promise;
  const promise = (async () => {
    const res = await researchGet('/v5/market/recent-trade', {
      category:'linear', symbol, limit:1000,
    }, testnet);
    const start = observedForAt - 60000;
    const raw = (res?.list || []).map(x => ({
      at:n(x.time), side:String(x.side || ''), size:n(x.size), price:n(x.price),
    })).filter(x => x.at !== null && x.size > 0 && x.price > 0);
    const rows=raw.filter(x => x.at <= observedForAt && x.at > start);
    const rawOldest=raw.length?Math.min(...raw.map(x=>x.at)):null;
    if (!rows.length || (raw.length>=1000 && rawOldest!==null && rawOldest>start))
      return {status:'NOT_AVAILABLE',reasonCode:'INSUFFICIENT_TRADES',source:'Bybit /v5/market/recent-trade',
        windowMs:60000,tradeCountObserved:rows.length,oldestTradeAt:rows.length?Math.min(...rows.map(x=>x.at)):null,
        newestTradeAt:rows.length?Math.max(...rows.map(x=>x.at)):null,
        takerBuyNotional1m:null,takerSellNotional1m:null,takerImbalance1m:null,tradeCount1m:null,
        incompleteData:true};
    let buy=0, sell=0;
    for (const x of rows) {
      const notional=x.size*x.price;
      if (x.side === 'Buy') buy += notional;
      else if (x.side === 'Sell') sell += notional;
    }
    const total=buy+sell;
    const times=rows.map(x=>x.at);
    return {status:'OK',reasonCode:null,source:'Bybit /v5/market/recent-trade',windowMs:60000,
      takerBuyNotional1m:r(buy),takerSellNotional1m:r(sell),
      takerImbalance1m:r(total>0?(buy-sell)/total:null),tradeCount1m:rows.length,
      oldestTradeAt:times.length?Math.min(...times):null,newestTradeAt:times.length?Math.max(...times):null};
  })();
  flowCache.set(cacheKey,{at:Date.now(),promise});
  while (flowCache.size>256) flowCache.delete(flowCache.keys().next().value);
  return promise;
}
function orderFlowFailureReason(e) {
  if (['RATE_LIMIT_10006','RESEARCH_QUEUE_CAPACITY','COOLDOWN_ACTIVE','TIMEOUT','HTTP_ERROR',
      'PARSE_ERROR','INSUFFICIENT_TRADES','RESTART_OR_RETENTION','UNKNOWN'].includes(e?.reasonCode)) return e.reasonCode;
  if (e?.retCode===10006) return 'RATE_LIMIT_10006';
  if (/capacity/i.test(e?.message||'')) return 'RESEARCH_QUEUE_CAPACITY';
  if (/cooling down|cooldown/i.test(e?.message||'')) return 'COOLDOWN_ACTIVE';
  if (e?.name==='AbortError') return 'TIMEOUT';
  if (e?.reasonCode==='PARSE_ERROR'||/non-JSON|parse/i.test(e?.message||'')) return 'PARSE_ERROR';
  if (Number.isFinite(e?.status)) return 'HTTP_ERROR';
  return 'UNKNOWN';
}
function appendOrderFlowTerminal(compact,flow) {
  if (!compact?.candidateId || flowLabelled.has(compact.candidateId)) return false;
  const at=Date.now();
  const row={version:COMPACT_VERSION,kind:'order_flow_label',
    eventId:digest(['flow',compact.candidateId,compact.at]),at,observedForAt:compact.at,
    decisionAt:compact.at,candidateKey:compact.candidateKey,episodeId:compact.episodeId,
    candidateId:compact.candidateId,engine:compact.engine,symbol:compact.symbol,side:compact.side,
    configHash:compact.configHash||null,source:'Bybit /v5/market/recent-trade',
    takerBuyNotional1m:null,takerSellNotional1m:null,takerImbalance1m:null,tradeCount1m:null,
    incompleteData:flow.status!=='OK',...flow};
  if (!append('compact',row,at)) return false;
  flowLabelled.add(compact.candidateId);
  flowScheduled.delete(compact.candidateId);
  while (flowLabelled.size>4096) flowLabelled.delete(flowLabelled.values().next().value);
  return true;
}
async function pumpOrderFlow() {
  if (orderFlowPumping) return;
  orderFlowPumping=true;
  try {
    while (pendingOrderFlow.length) {
      const compact=pendingOrderFlow.shift();
      if (flowLabelled.has(compact.candidateId)) {flowScheduled.delete(compact.candidateId);continue;}
      try {
        const flow=await recentTradeFlow(compact.symbol,compact.at,!!compact.minutePathRef?.testnet);
        appendOrderFlowTerminal(compact,flow);
      } catch(e) {
        const reasonCode=orderFlowFailureReason(e);
        logger.warn('research','Recent public-trade capture unavailable',
          {symbol:compact.symbol,reasonCode,error:e.message});
        appendOrderFlowTerminal(compact,{status:'NOT_AVAILABLE',reasonCode,
          httpStatus:e.status||null,retCode:e.retCode||null,detail:String(e.message||'').slice(0,200)});
      }
    }
  } finally {orderFlowPumping=false;if(pendingOrderFlow.length)setImmediate(pumpOrderFlow);}
}
function scheduleOrderFlowLabel(compact) {
  if (!compact?.candidateId || flowLabelled.has(compact.candidateId)||flowScheduled.has(compact.candidateId)) return;
  if (pendingOrderFlow.length>=MAX_PENDING_ORDER_FLOW) {
    appendOrderFlowTerminal(compact,{status:'NOT_AVAILABLE',reasonCode:'RESEARCH_QUEUE_CAPACITY',
      detail:`Local order-flow queue capped at ${MAX_PENDING_ORDER_FLOW}`});
    return;
  }
  flowScheduled.add(compact.candidateId);
  pendingOrderFlow.push(compact);
  setImmediate(pumpOrderFlow);
}
function directionalReturn(reference, close, side) {
  if (!(reference > 0) || !(close > 0)) return null;
  const raw=close/reference-1;
  return r((side === 'SELL' ? -1 : 1) * raw);
}
function computeForwardLabel(birth, bars) {
  const start = Math.ceil(Number(birth.at)/60000)*60000; // exclude partial birth minute to prevent pre-birth contamination
  const usable=(bars||[]).filter(x => x.ts >= start && x.ts < birth.at + 61*60000);
  const ref=n(birth.market?.markPrice), entry=n(birth.plannedEntry), sl=n(birth.plannedSl), tp=n(birth.plannedTp);
  const risk=entry!==null&&sl!==null?Math.abs(entry-sl):null;
  const atr=n(birth.trendMomentum?.atr14), dir=birth.side === 'SELL' ? -1 : 1;
  const closeAt = mins => {
    const cutoff=birth.at + mins*60000;
    const rows=usable.filter(x => x.ts+60000 <= cutoff);
    return rows.length ? rows.at(-1).close : null;
  };
  let mfePx=null, maePx=null;
  if (ref>0 && usable.length) {
    if (dir>0) { mfePx=Math.max(...usable.map(x=>x.high))-ref; maePx=ref-Math.min(...usable.map(x=>x.low)); }
    else { mfePx=ref-Math.min(...usable.map(x=>x.low)); maePx=Math.max(...usable.map(x=>x.high))-ref; }
  }
  let touchIndex=-1, touchAt=null;
  if (entry>0) {
    touchIndex=usable.findIndex(x => x.low <= entry && x.high >= entry);
    if (touchIndex>=0) touchAt=usable[touchIndex].ts;
  }
  let outcome=touchIndex>=0?'NEITHER':'ENTRY_NOT_TOUCHED', resolvedAt=null, sameMinuteAmbiguity=false;
  let entryTouchBarAmbiguous=false, touchBarTpHit=false, touchBarSlHit=false;
  let postEntryMfeR=null, postEntryMaeR=null;
  if (touchIndex>=0 && risk>0) {
    const touchBar=usable[touchIndex];
    touchBarTpHit=tp>0 ? (dir>0 ? touchBar.high>=tp : touchBar.low<=tp) : false;
    touchBarSlHit=sl>0 ? (dir>0 ? touchBar.low<=sl : touchBar.high>=sl) : false;
    entryTouchBarAmbiguous=touchBarTpHit || touchBarSlHit;
    const after=usable.slice(touchIndex+1); // exclude touch minute: OHLC cannot order entry vs extremes within that bar
    if (entryTouchBarAmbiguous) { outcome='ENTRY_TOUCH_BAR_AMBIGUOUS'; sameMinuteAmbiguity=true; }
    else for (const x of after) {
      const tpHit=tp>0 ? (dir>0 ? x.high>=tp : x.low<=tp) : false;
      const slHit=sl>0 ? (dir>0 ? x.low<=sl : x.high>=sl) : false;
      if (tpHit || slHit) {
        resolvedAt=x.ts;
        if (tpHit && slHit) { sameMinuteAmbiguity=true; outcome='BOTH_SAME_MINUTE_STOP_FIRST'; }
        else outcome=tpHit?'TP_FIRST':'SL_FIRST';
        break;
      }
    }
    if (after.length) {
      let maxFav=0,maxAdv=0;
      if (dir>0) { maxFav=Math.max(...after.map(x=>x.high-entry)); maxAdv=Math.max(...after.map(x=>entry-x.low)); }
      else { maxFav=Math.max(...after.map(x=>entry-x.low)); maxAdv=Math.max(...after.map(x=>x.high-entry)); }
      postEntryMfeR=r(maxFav/risk); postEntryMaeR=r(maxAdv/risk);
    }
  }
  const bid=n(birth.market?.bid),ask=n(birth.market?.ask),mid=bid>0&&ask>0?(bid+ask)/2:ref;
  const marketableAtBirth=entry>0 ? (birth.side==='BUY' ? (ask>0?entry>=ask:null) : (bid>0?entry<=bid:null)) : null;
  return {version:COMPACT_VERSION,kind:'forward_label',at:Date.now(),evaluatedFromAt:start,
    partialBirthMinuteExcluded:true,source:'Bybit /v5/market/kline 1m',candidateKey:birth.candidateKey,
    episodeId:birth.episodeId,candidateId:birth.candidateId,engine:birth.engine,symbol:birth.symbol,side:birth.side,
    configHash:birth.configHash||null,birthAt:birth.at,birthMarkPrice:ref,
    directionalReturn15m:directionalReturn(ref,closeAt(15),birth.side),
    directionalReturn30m:directionalReturn(ref,closeAt(30),birth.side),
    directionalReturn60m:directionalReturn(ref,closeAt(60),birth.side),
    mfe60mR:r(risk>0&&mfePx!==null?mfePx/risk:null),mae60mR:r(risk>0&&maePx!==null?maePx/risk:null),
    mfe60mAtr:r(atr>0&&mfePx!==null?mfePx/atr:null),mae60mAtr:r(atr>0&&maePx!==null?maePx/atr:null),
    plannedEntryTouched:touchIndex>=0,plannedEntryTouchAt:touchAt,
    entryTouchedWithin15m:touchAt!==null?touchAt < birth.at+15*60000:false,
    entryTouchedWithin30m:touchAt!==null?touchAt < birth.at+30*60000:false,
    entryTouchedWithin60m:touchAt!==null?touchAt < birth.at+60*60000:false,
    plannedTpSlOutcome:outcome,plannedTpSlResolvedAt:resolvedAt,sameMinuteAmbiguity,
    entryTouchBarAmbiguous,touchBarTpHit,touchBarSlHit,touchBarExcludedFromPostEntryExcursions:true,
    postEntryMfeR,postEntryMaeR,marketableAtBirth,
    entryDistanceBpsFromMid:r(entry>0&&mid>0?10000*Math.abs(entry-mid)/mid:null),
    fillAuditMethod:'1M_OHLC_PRICE_CROSS_ONLY_NOT_QUEUE_OR_SPREAD_GUARANTEE',barsEvaluated:usable.length};
}
async function resolveDueForwardLabels(limit=8) {
  if (forwardResolving) return;
  forwardResolving=true;
  try {
    const now=Date.now();
    const due=[...pendingForward.values()].filter(x => now >= x.at + 62*60000 && now >= (x.nextAttemptAt||0))
      .sort((a,b)=>a.at-b.at).slice(0,limit);
    for (const birth of due) {
      try {
        const start=Math.ceil(birth.at/60000)*60000;
        const end=birth.at+61*60000;
        const res=await researchGet('/v5/market/kline',{category:'linear',symbol:birth.symbol,interval:'1',start,end,limit:1000},!!birth.minutePathRef?.testnet);
        const bars=(res?.list||[]).map(x=>({ts:n(x[0]),open:n(x[1]),high:n(x[2]),low:n(x[3]),close:n(x[4])}))
          .filter(x=>x.ts!==null&&x.high!==null&&x.low!==null&&x.close!==null).sort((a,b)=>a.ts-b.ts);
        const row=computeForwardLabel(birth,bars);
        row.eventId=digest(['forward',birth.episodeId,birth.at]);
        append('compact',row,row.at);
        resolvedForward.set(birth.episodeId,Date.now()); pendingForward.delete(birth.episodeId);
        capResearchIndexes();
      } catch (e) {
        birth.nextAttemptAt=Date.now()+120000;
        logger.warn('research','Forward label resolution failed',{symbol:birth.symbol,error:e.message});
      }
    }
  } finally { forwardResolving=false; }
}
function startForwardResolver() {
  if (forwardTimer) return;
  forwardTimer=setInterval(() => {
    resolveDueForwardLabels().catch(e => logger.warn('research','Forward resolver error',{error:e.message}));
    require('./researchSupplement').resolveDue().catch(e => logger.warn('research','Supplement resolver error',{error:e.message}));
  },30000);
  if (forwardTimer.unref) forwardTimer.unref();
}
function birth(signal, context) {
  const {scanId, scanAt, ticker, candles, settings, snapshot, btc, universe, tickerDynamic} = context;
  const entry=n(signal.entry), sl=n(signal.sl), tp=n(signal.tp), price=n(ticker?.markPrice);
  const risk=entry!=null&&sl!=null?Math.abs(entry-sl):null;
  const grossR=risk>0&&tp!=null?Math.abs(tp-entry)/risk:null;
  const roundTripCost=entry>0&&risk>0? (entry*(n(settings.makerFeePct)||0)+Math.abs(tp||entry)*(n(settings.takerFeePct)||0))/(100*risk):null;
  const slipR=entry>0&&risk>0?entry*(n(settings.slSlipBps)||0)/(10000*risk):null;
  const engine=signal.signalSource?.startsWith('MARCI')?'Marci':'New Orayan';
  const configHash=settingsHash(settings);
  const capturedAt=Date.now();
  const row={ version:VERSION, kind:'candidate_birth', candidateId:signal.id, scanId,
    decisionAt:Math.max(scanAt,n(signal.createdAt)||scanAt),signalTime:n(signal.createdAt)||scanAt,
    capturedAt, configHash, captureLagMs:capturedAt-scanAt, signalToCaptureLagMs:capturedAt-(n(signal.createdAt)||scanAt), engine, engineVariant:signal.engine||null, signalSource:signal.signalSource||null,
    symbol:signal.symbol, side:signal.side, plannedEntry:entry, plannedSl:sl, plannedTp:tp,
    entryModeDecision:signal.gates?.passed && signal.marciShadow?.passed !== false
      ? (signal.entryPath||'ORIGINAL_PULLBACK'):'NO_TRADE',
    existingEntryPath:signal.entryPath||null, hypotheticalContinuationCandidate:null, score:n(signal.score),
    gates:signal.gates||null, btcRegime:signal.btcRegime||null,
    marketSnapshotId:snapshot?.marketSnapshotId||null,
    breadth:snapshot?.directionalBreadth??null, breadthMomentum:snapshot?.breadthMomentum??null,
    trendParticipationUpPct:snapshot?.trendUpPct??null, trendParticipationDownPct:snapshot?.trendDownPct??null,
    crossSectionalDispersion:snapshot?.crossSectionalDispersion??null,
    directionalCoherence:snapshot?.directionalCoherence??null,
    btcReturn1:snapshot?.btcReturn1??null, btcReturn3:snapshot?.btcReturn3??null,
    btcVol20:snapshot?.btcRealisedVol20??null, btcShockZ:snapshot?.btcShockZ??null,
    trendMomentum:features(candles, signal.side, btc, universe),
    structureEvent:signal.structureEvent||null, structureTrend:signal.structureTrend||null,
    structureLocation:signal.locationResearch||null,
    market:{ bid:n(ticker?.bid), ask:n(ticker?.ask), bidSize:n(ticker?.bidSize), askSize:n(ticker?.askSize),
      tickerObservedAt:n(ticker?.observedAt),
      topOfBookImbalance:ticker?.bidSize>0&&ticker?.askSize>0?r((ticker.bidSize-ticker.askSize)/(ticker.bidSize+ticker.askSize)):null,
      spreadPct:n(ticker?.spreadPct), markPrice:price, indexPrice:n(ticker?.indexPrice),
      markIndexBasisPct:price>0&&ticker?.indexPrice>0?r(100*(price/ticker.indexPrice-1)):null,
      openInterest:n(ticker?.openInterest), openInterestValue:n(ticker?.openInterestValue),
      openInterestChangePct:tickerDynamic?.openInterestChangePct??null,
      openInterestPriorAt:tickerDynamic?.openInterestPriorAt??null,
      fundingRate:n(ticker?.fundingRate), nextFundingTime:n(ticker?.nextFundingTime),
      fundingDivergenceVsBtc:tickerDynamic?.fundingDivergenceVsBtc??null,
      turnover24h:n(ticker?.turnover24h), volume24h:n(ticker?.volume24h),
      change24hPct:n(ticker?.change24hPct) },
    liquidations:liquidationFeatures(signal.symbol, scanAt, price, n(ticker?.turnover24h)),
    costs:{makerFeePct:n(settings.makerFeePct),takerFeePct:n(settings.takerFeePct),stopSlippageBps:n(settings.slSlipBps),
      targetThroughBps:n(settings.tpThroughBps),estimatedRoundTripCostR:r(roundTripCost),assumedStopSlipR:r(slipR)},
    grossTargetR:r(grossR), availableTargetRAfterFees:r(grossR!=null&&roundTripCost!=null?grossR-roundTripCost:null),
    minutePath:{ source:'Bybit /v5/market/kline', category:'linear', interval:'1', symbol:signal.symbol,
      fromMs:Math.floor(scanAt/60000)*60000, candidateId:signal.id,
      testnet:!!settings.testnet, status:'LINK_ONLY' },
    utcHour:new Date(scanAt).getUTCHours(), utcDayOfWeek:new Date(scanAt).getUTCDay(),
    orderIntent:null, orderAck:null, fill:null };
  const candidateKey = keyFor(signal);
  const passed = !!signal.gates?.passed && signal.marciShadow?.passed !== false;
  const compact = {version:COMPACT_VERSION, at:scanAt, decisionAt:row.decisionAt,
    capturedAt:row.capturedAt, configHash,
    captureLagMs:row.captureLagMs, signalToCaptureLagMs:row.signalToCaptureLagMs,
    candidateKey, candidateId:signal.id, signalTime:row.signalTime, scanId,
    marketSnapshotId:row.marketSnapshotId, engine:engine === 'Marci' ? 'MARCI' : 'NEW_ORAYAN',
    engineVariant:row.engineVariant, signalSource:row.signalSource,
    symbol:row.symbol, side:row.side, passed, failedGates:[...new Set([...(signal.gates?.failed||[]),...(signal.marciShadow?.failed||[])])].sort(),
    entryModeDecision:row.entryModeDecision, score:row.score,
    plannedEntry:entry, plannedSl:sl, plannedTp:tp, grossTargetR:row.grossTargetR,
    availableTargetRAfterFees:row.availableTargetRAfterFees,
    estimatedRoundTripCostR:row.costs.estimatedRoundTripCostR, assumedStopSlipR:row.costs.assumedStopSlipR,
    btcRegime:row.btcRegime, breadth:row.breadth, breadthMomentum:row.breadthMomentum,
    trendParticipationUpPct:row.trendParticipationUpPct, trendParticipationDownPct:row.trendParticipationDownPct,
    crossSectionalDispersion:row.crossSectionalDispersion, directionalCoherence:row.directionalCoherence,
    btcReturn1:row.btcReturn1, btcReturn3:row.btcReturn3, btcVol20:row.btcVol20, btcShockZ:row.btcShockZ,
    trendMomentum:row.trendMomentum, structureEvent:row.structureEvent, structureTrend:row.structureTrend,
    locationBucket:signal.locationResearch?.locationBucket||null,
    retracementDepthEntry:signal.locationResearch?.retracementDepthEntry??null,
    trendLegNumber:signal.locationResearch?.trendLegNumber??null,
    rizzySequence:signal.locationResearch?.rizzySequence??signal.marciIndependent?.sequence??null,
    marciPatternKey:signal.marciIndependent?.patternKey||null,
    marciTrendStrength:signal.marciIndependent?.trendStrength??null,
    market:row.market,
    orderFlow:{coverage:'ASYNC_PUBLIC_TRADE_LABEL',bidAskSizeImbalance:row.market.topOfBookImbalance,
      takerBuyNotional1m:null,takerSellNotional1m:null,takerFlowJoinKey:signal.id},
    liquidations:row.liquidations,
    minutePathRef:{symbol:signal.symbol,fromMs:row.minutePath.fromMs,interval:'1',testnet:!!settings.testnet} };
  if (compact.engine === 'NEW_ORAYAN') compact.retraceStateShadow=retraceShadow.classify(compact);
  // Price and fast market features change every scan. A setup update is material only when
  // gate/entry state or the planned geometry changes, not when a ticker twitches.
  const signature = digest([passed,compact.failedGates,compact.entryModeDecision,
    geometryBucket(entry),geometryBucket(sl),geometryBucket(tp),compact.locationBucket,compact.rizzySequence,
    compact.retraceStateShadow?.state]);
  const previous = lastCandidate.get(candidateKey);
  const continuing = previous && scanAt - previous.at <= 30*60000;
  const episodeId = continuing ? previous.episodeId : digest([candidateKey,scanAt]);
  const originAt=continuing?(previous.originAt??previous.at):scanAt;
  const originBtcRegime=continuing?(previous.originBtcRegime??row.btcRegime??null):(row.btcRegime??null);
  candidateKeysById.set(signal.id,{key:candidateKey,episodeId,at:scanAt,originAt,originBtcRegime,
    isBirth:!continuing,
    engine:engine === 'Marci' ? 'MARCI' : 'NEW_ORAYAN',configHash,
    retraceStateShadow:compact.retraceStateShadow||null});
  capMap(candidateKeysById,MAX_CANDIDATE_LINKS);
  if (continuing && previous.signature === signature) { previous.at=scanAt; return; }
  compact.kind = continuing ? 'candidate_update' : 'candidate_birth';
  compact.episodeId = episodeId;
  compact.episodeOriginAt = originAt;
  compact.episodeAgeMs = Math.max(0,scanAt-originAt);
  compact.originBtcRegime = originBtcRegime;
  compact.signature = signature;
  compact.eventId = digest([candidateKey,compact.kind,signature,scanAt]);
  lastCandidate.set(candidateKey,{at:scanAt,signature,episodeId,originAt,originBtcRegime});
  const update = continuing ? {version:COMPACT_VERSION,kind:compact.kind,eventId:compact.eventId,
    at:scanAt,candidateKey,episodeId,candidateId:signal.id,scanId,marketSnapshotId:compact.marketSnapshotId,
    engine:compact.engine,symbol:compact.symbol,side:compact.side,signature,configHash,
    captureLagMs:compact.captureLagMs,signalToCaptureLagMs:compact.signalToCaptureLagMs,
    passed,failedGates:compact.failedGates,entryModeDecision:compact.entryModeDecision,
    plannedEntry:entry,plannedSl:sl,plannedTp:tp,
    grossTargetR:compact.grossTargetR,availableTargetRAfterFees:compact.availableTargetRAfterFees,
    locationBucket:compact.locationBucket,rizzySequence:compact.rizzySequence,
    retraceStateShadow:compact.retraceStateShadow||null} : compact;
  append('compact',update,scanAt);
  if (compact.kind === 'candidate_birth') {
    pendingForward.set(episodeId,compact);
    capPendingForward();
    scheduleOrderFlowLabel(compact);
  }
}
function outcome(candidateId, event, trade, detail={}) {
  try { journal.recordSignalOutcome(candidateId, event, trade, detail); }
  catch (e) { logger.warn('research', 'Could not record compact signal outcome', {error:e.message}); }
  const at=Date.now(), tradeId=trade?.id||null;
  const match=candidateKeysById.get(candidateId);
  const row={version:COMPACT_VERSION,kind:'order_outcome',candidateId,
    candidateKey:match?.key||trade?.candidateKey||(trade?.symbol&&trade?.side?keyFor(trade):null),
    episodeId:match?.episodeId||trade?.episodeId||null,engine:match?.engine||
      (trade?.researchEngine?.startsWith('MARCI')?'MARCI':'NEW_ORAYAN'),
    configHash:match?.configHash||trade?.configHash||null,
    symbol:trade?.symbol||null,side:trade?.side||null,event,at,
    tradeId,exchangeOrderId:trade?.exchangeOrderId||null,status:trade?.status||null,
    marketSnapshotId:trade?.marketSnapshotId||null, intendedEntry:trade?.plannedEntry??null,
    filledAt:trade?.filledAt??null,fillPrice:trade?.fillPrice??null,
    closedAt:trade?.closedAt??null,exitPrice:trade?.exitPrice??null,
    realisedRR:trade?.realisedRR??null,netPnl:trade?.netPnl??null,
    reason:String(detail.reason||'').slice(0,160)||null,mode:detail.mode||trade?.mode||null};
  if (event === 'ORDER_INTENT' && match?.engine === 'NEW_ORAYAN')
    row.retraceStateShadow=match.retraceStateShadow||null;
  row.signature=digest([row.event,row.tradeId,row.exchangeOrderId,row.status,row.filledAt,
    row.fillPrice,row.closedAt,row.exitPrice,row.realisedRR,row.reason,row.mode]);
  const key=`${candidateId}|${event}|${tradeId||''}`;
  if (event === 'CLOSED' && trade?.engine !== 'MARCI_SHADOW') {
    try { require('./researchSupplement').observeStop(trade,{...match,marketSnapshotId:row.marketSnapshotId}); }
    catch (e) { logger.warn('research','Stop research capture failed',{error:e.message}); }
  }
  if (lastOutcome.get(key)?.signature === row.signature) return;
  row.eventId=digest([key,row.signature,at]);
  lastOutcome.set(key,{at,signature:row.signature});
  capMap(lastOutcome,MAX_OUTCOME_KEYS);
  append('compact',row,at);
}
function exportFiles(date = 'all', raw = false) {
  prune(Date.now());
  if (!raw) return compactFiles(date);
  if (date !== 'all' && (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0,10) !== date))
    throw new Error('Invalid UTC date');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => /^(births|outcomes|liquidations|coverage)-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)
    && (date === 'all' || name.endsWith(`-${date}.jsonl`)))
    .sort((a,b) => a.slice(-16).localeCompare(b.slice(-16)) || a.localeCompare(b))
    .map(name => path.join(dir, name));
}
module.exports={VERSION,COMPACT_VERSION,watch,stop,birth,outcome,features,ingest,liquidationFeatures,tickerDynamics,
  settingsHash,computeForwardLabel,resolveDueForwardLabels,exportFiles,prune,
  liquidationWindows,liquidationWindowTotals,candidateLink,researchGet,
  _test:{orderFlowFailureReason,appendOrderFlowTerminal,scheduleOrderFlowLabel,pumpOrderFlow,
    pendingOrderFlow,flowLabelled,flowScheduled}};
