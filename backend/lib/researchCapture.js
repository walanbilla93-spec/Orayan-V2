'use strict';

// Observational data only. No exports from this module feed builders, gates, ranking or orders.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const logger = require('./logger');
const journal = require('./journal');
const crypto = require('crypto');
const VERSION = 'PROSPECTIVE_BIRTH_V2';
const COMPACT_VERSION = 'PROSPECTIVE_COMPACT_V3';
const dir = path.join(store.DATA_DIR, 'research-v2');
const RETENTION_MS = 48 * 60 * 60 * 1000;
const lastCandidate = new Map();
const lastOutcome = new Map();
const candidateKeysById = new Map();
let lastPruneAt = 0;
const liquidations = new Map();
const seenLiquidation = new Map();
const priorTickers = new Map();
let socket, reconnect, heartbeat, subscribed = new Set(), wanted = new Set(), testnetMode = null;
let confirmed = new Set(), pendingBatches = new Map(), requestNumber = 0;
let connectedAt = null, lastMessageAt = null, gapSince = Date.now();

const n = v => { const x = Number(v); return v == null || v === '' || !Number.isFinite(x) ? null : x; };
const r = v => v == null || !Number.isFinite(v) ? null : Math.round(v * 1e8) / 1e8;
const avg = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const sd = xs => xs.length > 1 ? Math.sqrt(avg(xs.map(x => (x - avg(xs)) ** 2))) : null;
function append(kind, row, at = Date.now()) {
  try {
    fs.mkdirSync(dir, { recursive:true });
    const stamp = new Date(at).toISOString().slice(0, kind === 'compact' ? 13 : 10).replace('T','-');
    fs.appendFileSync(path.join(dir, `${kind}-${stamp}.jsonl`), JSON.stringify({recordType:kind,...row}) + '\n');
    if (at - lastPruneAt > 60 * 60000) { lastPruneAt = at; prune(at); }
  } catch (e) { logger.warn('research', `Could not append ${kind}`, { error:e.message }); }
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
}
function keyFor(signal) {
  const engine = signal.signalSource?.startsWith('MARCI') ? 'MARCI' : 'NEW_ORAYAN';
  const identity = signal.marciIndependent?.patternKey || [signal.engine || signal.entryPath || '',signal.structureEvent || ''].join(':');
  return [engine,signal.symbol,signal.side,identity].join('|');
}
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,16); }
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
  for (const file of compactFiles()) for (const line of fs.readFileSync(file,'utf8').split('\n')) {
    if (!line) continue;
    const row = JSON.parse(line);
    if (row.kind === 'candidate_birth' || row.kind === 'candidate_update') lastCandidate.set(row.candidateKey,
      {at:row.at,signature:row.signature,episodeId:row.episodeId});
    if (row.candidateId && row.candidateKey) candidateKeysById.set(row.candidateId,
      {key:row.candidateKey,episodeId:row.episodeId,at:row.at,engine:row.engine});
    if (row.kind === 'order_outcome') lastOutcome.set(`${row.candidateId}|${row.event}|${row.tradeId||''}`,{at:row.at,signature:row.signature});
  }
} catch (e) { logger.warn('research','Could not restore compact research index',{error:e.message}); }
function cleanOld(now) {
  for (const [symbol, rows] of liquidations) {
    const kept = rows.filter(x => x.timestamp >= now - 60 * 60000);
    if (kept.length) liquidations.set(symbol, kept); else liquidations.delete(symbol);
  }
  for (const [key, at] of seenLiquidation) if (at < now - 60000) seenLiquidation.delete(key);
}
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
  for (const s of removed) { subscribed.delete(s); confirmed.delete(s); }
  for (const s of missing) subscribed.add(s);
}
function connect() {
  if (!wanted.size || socket || testnetMode === null) return;
  let WS;
  try { WS = require('ws'); } catch (e) { logger.warn('research', 'ws package missing; liquidation capture unavailable', { error:e.message }); return; }
  const url = testnetMode ? 'wss://stream-testnet.bybit.com/v5/public/linear' : 'wss://stream.bybit.com/v5/public/linear';
  try { socket = new WS(url); } catch (e) { logger.warn('research', 'Liquidation socket failed', { error:e.message }); socket = null; return; }
  socket.on('open', () => {
    connectedAt = Date.now(); gapSince = null; subscribed = new Set(); confirmed = new Set(); pendingBatches = new Map(); subscribe(wanted);
    heartbeat = setInterval(() => { if (socket?.readyState === 1) socket.send(JSON.stringify({ op:'ping' })); }, 20000);
    if (heartbeat.unref) heartbeat.unref();
  });
  socket.on('message', raw => { try {
    const msg = JSON.parse(String(raw));
    const pending = pendingBatches.get(msg.req_id);
    if (pending && msg.op === pending.op) {
      pendingBatches.delete(msg.req_id);
      if (msg.success === true && pending.op === 'subscribe') for (const s of pending.batch) confirmed.add(s);
      if (msg.success !== true) logger.warn('research', 'Liquidation subscription rejected', { req_id:msg.req_id, ret_msg:msg.ret_msg });
    }
    ingest(msg);
  } catch (_e) { /* malformed public message */ } });
  socket.on('error', e => logger.warn('research', 'Liquidation stream error', { error:e.message }));
  socket.on('close', () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null; socket = null; subscribed = new Set(); confirmed = new Set(); pendingBatches = new Map(); connectedAt = null; gapSince = Date.now();
    append('coverage', { version:VERSION, event:'stream_disconnected', at:gapSince, testnet:testnetMode });
    reconnect = setTimeout(connect, 5000);
    if (reconnect.unref) reconnect.unref();
  });
}
function watch(symbols, testnet) {
  const next = new Set([...symbols, 'BTCUSDT'].filter(s => /^[A-Z0-9]+USDT$/.test(s)));
  if (testnetMode !== null && testnetMode !== !!testnet) stop();
  testnetMode = !!testnet; wanted = next;
  if (socket?.readyState === 1) subscribe(wanted); else connect();
}
function stop() {
  if (reconnect) clearTimeout(reconnect);
  if (heartbeat) clearInterval(heartbeat);
  reconnect = heartbeat = null; wanted = new Set();
  if (socket) { const old = socket; socket = null; old.removeAllListeners('close'); old.close(); }
  connectedAt = null; gapSince = Date.now(); subscribed = new Set(); confirmed = new Set(); pendingBatches = new Map();
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
function birth(signal, context) {
  const {scanId, scanAt, ticker, candles, settings, snapshot, btc, universe, tickerDynamic} = context;
  const entry=n(signal.entry), sl=n(signal.sl), tp=n(signal.tp), price=n(ticker?.markPrice);
  const risk=entry!=null&&sl!=null?Math.abs(entry-sl):null;
  const grossR=risk>0&&tp!=null?Math.abs(tp-entry)/risk:null;
  const roundTripCost=entry>0&&risk>0? (entry*(n(settings.makerFeePct)||0)+Math.abs(tp||entry)*(n(settings.takerFeePct)||0))/(100*risk):null;
  const slipR=entry>0&&risk>0?entry*(n(settings.slSlipBps)||0)/(10000*risk):null;
  const engine=signal.signalSource?.startsWith('MARCI')?'Marci':'New Orayan';
  const row={ version:VERSION, kind:'candidate_birth', candidateId:signal.id, scanId, signalTime:n(signal.createdAt)||scanAt,
    capturedAt:Date.now(), engine, engineVariant:signal.engine||null, signalSource:signal.signalSource||null,
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
  const compact = {version:COMPACT_VERSION, at:scanAt, capturedAt:row.capturedAt,
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
    orderFlow:{coverage:'TOP_OF_BOOK_ONLY',bidAskSizeImbalance:row.market.topOfBookImbalance,
      takerBuyNotional1m:null,takerSellNotional1m:null},
    liquidations:row.liquidations,
    minutePathRef:{symbol:signal.symbol,fromMs:row.minutePath.fromMs,interval:'1',testnet:!!settings.testnet} };
  // Price and fast market features change every scan. A setup update is material only when
  // gate/entry state or the planned geometry changes, not when a ticker twitches.
  const signature = digest([passed,compact.failedGates,compact.entryModeDecision,
    geometryBucket(entry),geometryBucket(sl),geometryBucket(tp),compact.locationBucket,compact.rizzySequence]);
  const previous = lastCandidate.get(candidateKey);
  const continuing = previous && scanAt - previous.at <= 30*60000;
  const episodeId = continuing ? previous.episodeId : digest([candidateKey,scanAt]);
  candidateKeysById.set(signal.id,{key:candidateKey,episodeId,at:scanAt,
    engine:engine === 'Marci' ? 'MARCI' : 'NEW_ORAYAN'});
  if (continuing && previous.signature === signature) { previous.at=scanAt; return; }
  compact.kind = continuing ? 'candidate_update' : 'candidate_birth';
  compact.episodeId = episodeId;
  compact.signature = signature;
  compact.eventId = digest([candidateKey,compact.kind,signature,scanAt]);
  lastCandidate.set(candidateKey,{at:scanAt,signature,episodeId});
  const update = continuing ? {version:COMPACT_VERSION,kind:compact.kind,eventId:compact.eventId,
    at:scanAt,candidateKey,episodeId,candidateId:signal.id,scanId,marketSnapshotId:compact.marketSnapshotId,
    engine:compact.engine,symbol:compact.symbol,side:compact.side,signature,
    passed,failedGates:compact.failedGates,entryModeDecision:compact.entryModeDecision,
    plannedEntry:entry,plannedSl:sl,plannedTp:tp,
    grossTargetR:compact.grossTargetR,availableTargetRAfterFees:compact.availableTargetRAfterFees,
    locationBucket:compact.locationBucket,rizzySequence:compact.rizzySequence} : compact;
  append('compact',update,scanAt);
}
function outcome(candidateId, event, trade, detail={}) {
  try { journal.recordSignalOutcome(candidateId, event, trade, detail); }
  catch (e) { logger.warn('research', 'Could not record compact signal outcome', {error:e.message}); }
  const at=Date.now(), tradeId=trade?.id||null;
  const match=candidateKeysById.get(candidateId);
  const row={version:COMPACT_VERSION,kind:'order_outcome',candidateId,
    candidateKey:match?.key||(trade?.symbol&&trade?.side?keyFor(trade):null),
    episodeId:match?.episodeId||null,engine:match?.engine||
      (trade?.researchEngine?.startsWith('MARCI')?'MARCI':'NEW_ORAYAN'),
    symbol:trade?.symbol||null,side:trade?.side||null,event,at,
    tradeId,exchangeOrderId:trade?.exchangeOrderId||null,status:trade?.status||null,
    marketSnapshotId:trade?.marketSnapshotId||null, intendedEntry:trade?.plannedEntry??null,
    filledAt:trade?.filledAt??null,fillPrice:trade?.fillPrice??null,
    closedAt:trade?.closedAt??null,exitPrice:trade?.exitPrice??null,
    realisedRR:trade?.realisedRR??null,netPnl:trade?.netPnl??null,
    reason:String(detail.reason||'').slice(0,160)||null,mode:detail.mode||trade?.mode||null};
  row.signature=digest([row.event,row.tradeId,row.exchangeOrderId,row.status,row.filledAt,
    row.fillPrice,row.closedAt,row.exitPrice,row.realisedRR,row.reason,row.mode]);
  const key=`${candidateId}|${event}|${tradeId||''}`;
  if (lastOutcome.get(key)?.signature === row.signature) return;
  row.eventId=digest([key,row.signature,at]);
  lastOutcome.set(key,{at,signature:row.signature});
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
module.exports={VERSION,COMPACT_VERSION,watch,stop,birth,outcome,features,ingest,liquidationFeatures,tickerDynamics,exportFiles,prune};
