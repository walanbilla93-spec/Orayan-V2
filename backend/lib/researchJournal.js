'use strict';
const store = require('./store');
const VERSION = 'MARKET_ENVIRONMENT_RESEARCH_V1';
// Research events are needed for rejected-candidate counterfactual work. Keep a time-based
// window large enough for multi-day analysis; the old 20k hard cap discarded ~7h in <2 days.
const RETENTION_MS = 4 * 86400000; // 96h, safely above the requested 72h minimum
const MAX_SNAPSHOTS = 2500;
const MAX_EVENTS = 100000; // safety ceiling; time retention is the primary policy
let snapshots = store.read('researchEnvironmentV1', []);
let events = store.read('researchEventsV1', []);
if (!Array.isArray(snapshots)) snapshots = [];
if (!Array.isArray(events)) events = [];
const bootNow = Date.now();
snapshots = snapshots.filter(x => Number(x?.barOpenAt || x?.observedAt || 0) >= bootNow - RETENTION_MS).slice(-MAX_SNAPSHOTS);
events = events.filter(x => Number(x?.at || 0) >= bootNow - RETENTION_MS).slice(-MAX_EVENTS);
let timer = null, dirty = false;
const lastEventSignature = new Map(events.filter(e => e?.candidateKey && e?.signature)
  .map(e => [e.candidateKey, e.signature]));
function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!dirty) return;
  dirty = false;
  store.write('researchEnvironmentV1', snapshots);
  store.write('researchEventsV1', events);
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
  for (const signal of Array.isArray(signals) ? signals : []) {
    if (!signal?.symbol || !signal?.side) continue;
    const row = project(signal);
    const candidateKey = [row.signalSource, signal.engine || '', row.symbol, row.side, row.marciPatternKey || row.structureEvent || ''].join('|');
    const signature = JSON.stringify([row.passed, [...row.failedGates].sort(), row.structureEvent,
      row.locationBucket, signal.entryPath || null]);
    if (lastEventSignature.get(candidateKey) === signature) continue;
    lastEventSignature.set(candidateKey, signature);
    events.push({ version:VERSION, key:`${candidateKey}|${at}`, candidateKey, signature, at,
      scanId:meta.scanId || null, marketSnapshotId:row.marketSnapshotId || meta.marketSnapshotId || null,
      configHash:meta.configHash || null, ...row });
  }
  events = events.filter(x => x.at >= at - RETENTION_MS).slice(-MAX_EVENTS);
  schedule();
}
function clear() {
  snapshots = []; events = []; lastEventSignature.clear(); dirty = true; flush();
}
module.exports = {
  VERSION, observation, captureMarketSnapshot, recordEvents,
  getSnapshots:() => snapshots.slice(), getEvents:() => events.slice(), clear, flush,
};
