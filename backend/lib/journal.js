'use strict';

const store = require('./store');
const logger = require('./logger');
const researchJournal = require('./researchJournal');

// V1 is read only after upgrade. Keep it available through ?schema=legacy.
const MAX_SIGNAL_HISTORY = 20000;
const COMPACT_VERSION = 'SIGNAL_EVENTS_COMPACT_V2';
const RETENTION_MS = 48 * 60 * 60 * 1000;
const MAX_COMPACT_EVENTS = 50000;

/**
 * Keep the research journal deliberately compact. The engine signal object contains several
 * nested UI/execution helpers that are useful for the current scan but are not needed for
 * offline research. Retaining 20,000 full signal objects became expensive once
 * LOCATION_RESEARCH_V1 was added and could push small Node containers into heap OOM during
 * JSON.stringify(). This projection preserves every field used by the CSV/JSON research
 * exports while dropping unrelated transient structure.
 */
function compactSignalForJournal(s) {
  if (!s || s.kind === 'bos_event') return s;
  return {
    kind: s.kind || 'signal_scan',
    signalSource: s.signalSource || null,
    scanId: s.scanId ?? null,
    scanAt: s.scanAt ?? null,
    marketSnapshotId: s.marketSnapshotId ?? null,
    id: s.id,
    createdAt: s.createdAt,
    symbol: s.symbol,
    side: s.side,
    score: s.score,
    rr: s.rr,
    slDistPct: s.slDistPct,
    price: s.price,
    entry: s.entry,
    sl: s.sl,
    tp: s.tp,
    structureEvent: s.structureEvent,
    structureTrend: s.structureTrend,
    entryPath: s.entryPath,
    btcRegime: s.btcRegime,
    regimeAligned: s.regimeAligned,
    timeframe: s.timeframe,
    market: s.market ? {
      turnover24h: s.market.turnover24h,
      spreadPct: s.market.spreadPct,
      fundingRate: s.market.fundingRate,
      volRatio: s.market.volRatio,
    } : null,
    gates: s.gates ? {
      passed: s.gates.passed,
      failed: Array.isArray(s.gates.failed) ? s.gates.failed.slice() : [],
    } : null,
    components: s.components ? { ...s.components } : null,
    locationResearch: s.locationResearch ? { ...s.locationResearch } : null,
    marciShadow: s.marciShadow ? { ...s.marciShadow } : null,
    marciIndependent: s.marciIndependent ? { ...s.marciIndependent } : null,
  };
}

// Compact legacy/full rows immediately on process start as well. This matters after an upgrade:
// otherwise an already-large persisted journal can OOM before enough new compact rows replace it.
let signalHistory = store.read('signalHistory', []);
if (!Array.isArray(signalHistory)) signalHistory = [];
signalHistory = signalHistory.map(compactSignalForJournal);
if (signalHistory.length > MAX_SIGNAL_HISTORY) {
  signalHistory = signalHistory.slice(-MAX_SIGNAL_HISTORY);
}
let signalEvents = store.read('signalEventsCompactV2', []);
if (!Array.isArray(signalEvents)) signalEvents = [];
signalEvents = signalEvents.filter(x => x?.version === COMPACT_VERSION).slice(-MAX_COMPACT_EVENTS);
const lastByKey = new Map();
for (const row of signalEvents) if (row.candidateKey && ['DETECTED','STATE_CHANGE','EXPIRED'].includes(row.event)) lastByKey.set(row.candidateKey, row);
const lastSeenAt = new Map([...lastByKey].map(([key, row]) => [key, row.at]));
const lastOutcomeByKey = new Map();
for (const row of signalEvents) if (row.candidateKey && row.changed === 'lifecycle') lastOutcomeByKey.set(row.candidateKey, row);
let currentCandidates = new Map();
for (const row of signalEvents) if (row.candidateId && row.candidateKey && row.event !== 'BOS_OUTCOME')
  currentCandidates.set(row.candidateId, {key:row.candidateKey, at:row.at,
    s:{symbol:row.symbol,side:row.side,signalSource:row.engine === 'MARCI' ? 'MARCI' : 'ORAYAN'}});

/*
 * WRITE BATCHING
 *
 * Every append used to call store.write() immediately, which serialises and rewrites the whole
 * array. At the 20,000-row cap that file is several megabytes, and recordBosEvent() can fire
 * many times per scan across the universe — so a single scan could trigger dozens of
 * multi-megabyte writes. Scan latency grew with history length, which is exactly backwards.
 *
 * Writes are now coalesced onto a short timer. The cost of a crash is at most a couple of
 * seconds of journal rows, which is an acceptable trade for a research log.
 */
let flushTimer = null;
let dirty = false;

function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (!dirty) return;
    dirty = false;
    store.write('signalEventsCompactV2', signalEvents, false);
  }, 3000);
  if (flushTimer.unref) flushTimer.unref();
}

/** Force an immediate write — used on shutdown so nothing in the buffer is lost. */
function flush() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!dirty) return;
  dirty = false;
  store.write('signalEventsCompactV2', signalEvents, false);
}

function trim() {
  const cutoff = Date.now() - RETENTION_MS;
  signalEvents = signalEvents.filter(x => x.at >= cutoff).slice(-MAX_COMPACT_EVENTS);
  for (const [key, row] of lastByKey) if ((lastSeenAt.get(key) || row.at) < cutoff) {
    lastByKey.delete(key); lastSeenAt.delete(key); lastOutcomeByKey.delete(key);
  }
}
trim();

function engineName(s) { return s.signalSource?.startsWith('MARCI') || s.kind === 'marci_signal' ? 'MARCI' : 'NEW_ORAYAN'; }
function candidateKey(s) {
  const identity = s.marciIndependent?.patternKey || [s.engine || s.entryPath || '', s.structureEvent || ''].join(':');
  return [engineName(s), s.symbol, s.side, identity].join('|');
}
function gateSummary(s) { return [...new Set(s.gates?.failed || [])].sort().join('|'); }
function classification(s) {
  return [s.locationResearch?.locationBucket || '', s.locationResearch?.rizzySequence || '',
    s.marciIndependent?.patternKey || '', Number.isFinite(s.score) ? Math.floor(s.score / 10) * 10 : ''].join('|');
}
function eventRow(s, scanMeta, event, changed) {
  return { version:COMPACT_VERSION, at:scanMeta.scanAt, scanId:scanMeta.scanId || null,
    marketSnapshotId:s.marketSnapshotId || scanMeta.marketSnapshotId || null,
    engine:engineName(s), engineVariant:s.engine || null, candidateKey:candidateKey(s), candidateId:s.id,
    symbol:s.symbol, side:s.side, event, state:s.gates?.passed ? 'PASSED' : 'REJECTED',
    score:s.score ?? null, passed:s.gates?.passed ?? null, failedGates:gateSummary(s),
    entryMode:s.entryPath || null, entry:s.entry ?? null, sl:s.sl ?? null, tp:s.tp ?? null,
    researchClass:classification(s), changed:changed || null, reason:null };
}
function recordSignals(signals, scanMeta) {
  const stamped = (signals || []).map(s => ({ ...s, marketSnapshotId:s.marketSnapshotId || scanMeta.marketSnapshotId }));
  researchJournal.recordEvents(stamped, scanMeta);
  for (const [id, candidate] of currentCandidates) if (scanMeta.scanAt - candidate.at > RETENTION_MS) currentCandidates.delete(id);
  const seen = new Set();
  for (const s of stamped) {
    if (!s?.id || !s.symbol || !s.side) continue;
    const key = candidateKey(s), previous = lastByKey.get(key);
    currentCandidates.set(s.id, { key, at:scanMeta.scanAt, marketSnapshotId:s.marketSnapshotId,
      s:{symbol:s.symbol,side:s.side,signalSource:s.signalSource,score:s.score,
        entryPath:s.entryPath,entry:s.entry,sl:s.sl,tp:s.tp} });
    lastSeenAt.set(key, scanMeta.scanAt);
    seen.add(key);
    const changes = [];
    if (!previous || previous.event === 'EXPIRED') changes.push('birth');
    else {
      if (previous.passed !== (s.gates?.passed ?? null) || previous.failedGates !== gateSummary(s)) changes.push('gates');
      if (previous.entryMode !== (s.entryPath || null)) changes.push('entryMode');
      if (previous.researchClass !== classification(s)) changes.push('researchClass');
    }
    if (!changes.length) continue;
    const row = eventRow(s, scanMeta, changes.includes('birth') ? 'DETECTED' : 'STATE_CHANGE', changes.join('|'));
    signalEvents.push(row);
    lastByKey.set(key, row);
  }
  // A missing setup is expired only after sustained absence, avoiding scan-to-scan flapping.
  for (const [key, previous] of lastByKey) {
    if (!seen.has(key) && previous.event !== 'EXPIRED' && scanMeta.scanAt - (lastSeenAt.get(key) || previous.at) >= 30 * 60000) {
      const row = { ...previous, at:scanMeta.scanAt, scanId:scanMeta.scanId, event:'EXPIRED',
        state:'EXPIRED', changed:'absent_30m', reason:'SETUP_NOT_DETECTED', score:null };
      signalEvents.push(row); lastByKey.set(key, row);
    }
  }
  trim();
  scheduleFlush();
}

function recordSignalOutcome(candidateId, event, trade, detail = {}) {
  let match = currentCandidates.get(candidateId);
  if (!match) {
    const old = signalEvents.findLast(row => row.candidateId === candidateId && row.candidateKey);
    if (old) match = {key:old.candidateKey, s:{symbol:old.symbol,side:old.side,
      signalSource:old.engine === 'MARCI' ? 'MARCI' : 'ORAYAN'}};
  }
  if (!match && !trade) return;
  if (event === 'NO_ORDER' && match) {
    const prior = lastOutcomeByKey.get(match.key);
    if (prior?.event === event && prior.reason === String(detail.reason || '').slice(0, 160)) return;
  }
  const previous = match ? lastByKey.get(match.key) : null;
  const at = Date.now();
  const row = { ...(previous || {}), version:COMPACT_VERSION, at, scanId:null,
    marketSnapshotId:trade?.marketSnapshotId || match?.marketSnapshotId || previous?.marketSnapshotId || null,
    engine:match ? engineName(match.s) : (trade?.researchEngine?.startsWith('MARCI') ? 'MARCI' : 'NEW_ORAYAN'),
    candidateKey:match?.key || previous?.candidateKey || null, candidateId,
    symbol:match?.s.symbol || trade?.symbol, side:match?.s.side || trade?.side,
    event, state:trade?.status || event, score:match?.s.score ?? previous?.score ?? null,
    tradeId:trade?.id || null, exchangeOrderId:trade?.exchangeOrderId || null,
    entryMode:match?.s.entryPath || trade?.entryPath || previous?.entryMode || null,
    orderMode:detail.mode || trade?.mode || null,
    entry:trade?.plannedEntry ?? match?.s.entry ?? previous?.entry ?? null,
    sl:trade?.sl ?? match?.s.sl ?? previous?.sl ?? null,
    tp:trade?.tp ?? match?.s.tp ?? previous?.tp ?? null,
    changed:'lifecycle', reason:String(detail.reason || '').slice(0, 160) || null };
  signalEvents.push(row);
  if (row.candidateKey) lastOutcomeByKey.set(row.candidateKey, row);
  trim(); scheduleFlush();
}

function getSignalHistory({ limit = 5000, legacy = false } = {}) {
  return (legacy ? signalHistory : signalEvents).slice(-limit);
}

function clearSignalHistory() {
  signalHistory = []; signalEvents = []; lastByKey.clear(); lastSeenAt.clear(); lastOutcomeByKey.clear(); currentCandidates.clear();
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  dirty = false;
  store.write('signalHistory', signalHistory);
  store.write('signalEventsCompactV2', signalEvents, false);
  logger.warn('journal', 'Signal history cleared by operator');
}

/**
 * Records a BOS held/fake outcome (see bosTracker.js) into the same signal journal —
 * no separate store, same export. Called once when a break is first detected (PENDING)
 * and once again when it resolves (HELD/FAKE/UNRESOLVED_STALE), so each break produces
 * at most 2 rows rather than one per scan.
 */
function recordBosEvent(ev) {
  if (!ev) return;
  const row = {
    kind: 'bos_event',
    scanId: null,
    scanAt: Date.now(),
    id: ev.key,
    symbol: ev.symbol,
    side: ev.side,
    bosLevel: ev.level,
    bosBreakTs: ev.breakTs,
    bosBreakIso: ev.breakIso,
    bosOutcome: ev.outcome,
    bosBarsChecked: ev.barsChecked,
  };
  signalEvents.push({version:COMPACT_VERSION, at:row.scanAt, event:'BOS_OUTCOME', state:row.bosOutcome,
    engine:'NEW_ORAYAN', candidateId:row.id, candidateKey:`BOS|${row.id}`, symbol:row.symbol,
    side:row.side, reason:row.bosOutcome, marketSnapshotId:null, bosLevel:row.bosLevel,
    bosBreakTs:row.bosBreakTs, bosBarsChecked:row.bosBarsChecked});
  trim();
  scheduleFlush();
}

// ── CSV ──────────────────────────────────────────────────────────────────────────────────

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows, columns) {
  const header = columns.map((c) => c.label).join(',');
  const lines = rows.map((row) => columns.map((c) => csvEscape(c.get(row))).join(','));
  return [header, ...lines].join('\n');
}

const TRADE_COLUMNS = [
  { label: 'marketSnapshotId', get: (t) => t.marketSnapshotId || '' },
  { label: 'id', get: (t) => t.id },
  { label: 'signalId', get: (t) => t.signalId },
  { label: 'symbol', get: (t) => t.symbol },
  { label: 'side', get: (t) => t.side },
  { label: 'status', get: (t) => t.status },
  { label: 'mode', get: (t) => t.mode },
  { label: 'createdAt', get: (t) => t.createdAt },
  { label: 'createdAtIso', get: (t) => new Date(t.createdAt).toISOString() },
  { label: 'filledAt', get: (t) => t.filledAt },
  { label: 'closedAt', get: (t) => t.closedAt },
  { label: 'score', get: (t) => t.score },
  { label: 'plannedRR', get: (t) => t.plannedRR },
  { label: 'plannedEntry', get: (t) => t.plannedEntry },
  { label: 'fillPrice', get: (t) => t.fillPrice },
  { label: 'sl', get: (t) => t.sl },
  { label: 'tp', get: (t) => t.tp },
  { label: 'exitPrice', get: (t) => t.exitPrice },
  { label: 'qty', get: (t) => t.qty },
  { label: 'notional', get: (t) => t.notional },
  { label: 'leverage', get: (t) => t.leverage },
  { label: 'plannedRisk', get: (t) => t.plannedRisk },
  { label: 'grossPnl', get: (t) => t.grossPnl },
  { label: 'fees', get: (t) => t.fees },
  { label: 'netPnl', get: (t) => t.netPnl },
  { label: 'realisedRR', get: (t) => t.realisedRR },
  { label: 'closeReason', get: (t) => t.closeReason },
  { label: 'btcRegime', get: (t) => t.btcRegime },
  { label: 'turnover24h', get: (t) => t.turnover24h },
  { label: 'timeframe', get: (t) => t.timeframe },
  { label: 'engine', get: (t) => t.engine || '' },
  { label: 'entryPath', get: (t) => t.entryPath || '' },
  { label: 'researchEngine', get: (t) => t.researchEngine || '' },
  { label: 'signalSource', get: (t) => t.signalSource || '' },
  { label: 'sourceSignalId', get: (t) => t.sourceSignalId || '' },
  { label: 'sourceScore', get: (t) => t.sourceScore },
  { label: 'marciShadowVersion', get: (t) => t.marciShadow?.version },
  { label: 'marciIndependentScore', get: (t) => t.marciShadow?.independentScore },
  { label: 'marciRizzySequence', get: (t) => t.marciShadow?.rizzySequence },
  { label: 'marciProjectedTarget', get: (t) => t.marciShadow?.projectedTarget },
  { label: 'marciTargetR', get: (t) => t.marciShadow?.targetR },
  { label: 'marciBbZ', get: (t) => t.marciShadow?.bbZ },
  { label: 'marciTrendLocation', get: (t) => t.marciShadow?.trendLocation },
  { label: 'marciPatternKey', get: (t) => t.marciPatternKey || t.marciIndependent?.patternKey || '' },
  { label: 'marciSignalMethod', get: (t) => t.marciIndependent?.signalMethod },
  { label: 'marciEntryMethod', get: (t) => t.marciIndependent?.entryMethod },
  { label: 'marciHardStopMethod', get: (t) => t.marciIndependent?.hardStopMethod },
  { label: 'marciInvalidationMethod', get: (t) => t.marciIndependent?.invalidationMethod },
  { label: 'marciPriorityScore', get: (t) => t.marciIndependent?.priorityScore },
  { label: 'marciD', get: (t) => t.marciIndependent?.d },
  { label: 'marciDAtr', get: (t) => t.marciIndependent?.dAtr },
  { label: 'marciTrendlineAtExit', get: (t) => t.marciTrendlineAtExit },
  { label: 'postInvalidationTracking', get: (t) => t.marciCounterfactual?.tracking },
  { label: 'postInvalidationMfeR', get: (t) => t.marciCounterfactual?.postInvalidationMfeR },
  { label: 'postInvalidationMaeR', get: (t) => t.marciCounterfactual?.postInvalidationMaeR },
  { label: 'counterfactualOutcome', get: (t) => t.marciCounterfactual?.outcome },
  { label: 'counterfactualOriginalPlanWouldWin', get: (t) => t.marciCounterfactual?.originalPlanWouldWin },
  { label: 'counterfactualResolvedAt', get: (t) => t.marciCounterfactual?.resolvedAt },
  // LOCATION_RESEARCH_V1 — frozen at signal creation and copied into the trade unchanged.
  { label: 'researchVersion', get: (t) => t.locationResearch?.version },
  { label: 'impulseMethod', get: (t) => t.locationResearch?.impulseMethod },
  { label: 'trendLegMethod', get: (t) => t.locationResearch?.trendLegMethod },
  { label: 'rizzyMethod', get: (t) => t.locationResearch?.rizzyMethod },
  { label: 'impulseLow', get: (t) => t.locationResearch?.impulseLow },
  { label: 'impulseHigh', get: (t) => t.locationResearch?.impulseHigh },
  { label: 'impulseRangePct', get: (t) => t.locationResearch?.impulseRangePct },
  { label: 'retracementDepthMark', get: (t) => t.locationResearch?.retracementDepthMark },
  { label: 'retracementDepthEntry', get: (t) => t.locationResearch?.retracementDepthEntry },
  { label: 'trendLocation', get: (t) => t.locationResearch?.trendLocation },
  { label: 'locationBucket', get: (t) => t.locationResearch?.locationBucket },
  { label: 'distanceFromExtremeAtr', get: (t) => t.locationResearch?.distanceFromExtremeAtr },
  { label: 'bbMid', get: (t) => t.locationResearch?.bbMid },
  { label: 'bbStd', get: (t) => t.locationResearch?.bbStd },
  { label: 'bbUpper', get: (t) => t.locationResearch?.bbUpper },
  { label: 'bbLower', get: (t) => t.locationResearch?.bbLower },
  { label: 'bbZ', get: (t) => t.locationResearch?.bbZ },
  { label: 'bbPercentB', get: (t) => t.locationResearch?.bbPercentB },
  { label: 'trendLegNumber', get: (t) => t.locationResearch?.trendLegNumber },
  { label: 'rizzyPresent', get: (t) => t.locationResearch?.rizzyPresent },
  { label: 'rizzySequence', get: (t) => t.locationResearch?.rizzySequence },
  { label: 'rizzyProjectedTarget', get: (t) => t.locationResearch?.rizzyProjectedTarget },
  { label: 'rizzyTargetR', get: (t) => t.locationResearch?.rizzyTargetR },
  { label: 'rizzyInvalidated', get: (t) => t.locationResearch?.rizzyInvalidated },
  { label: 'rizzyDistanceAtr', get: (t) => t.locationResearch?.rizzyDistanceAtr },
  { label: 'rizzyAnchor1Price', get: (t) => t.locationResearch?.rizzyAnchor1Price },
  { label: 'rizzyAnchor1Ts', get: (t) => t.locationResearch?.rizzyAnchor1Ts },
  { label: 'rizzyAnchor2Price', get: (t) => t.locationResearch?.rizzyAnchor2Price },
  { label: 'rizzyAnchor2Ts', get: (t) => t.locationResearch?.rizzyAnchor2Ts },
  { label: 'createdAtIso', get: (t) => t.createdAtIso || (t.createdAt ? new Date(t.createdAt).toISOString() : '') },
  { label: 'exchangeOrderId', get: (t) => t.exchangeOrderId },
];

const LEGACY_SIGNAL_COLUMNS = [
  { label: 'marketSnapshotId', get: (s) => s.marketSnapshotId || '' },
  { label: 'scanId', get: (s) => s.scanId },
  { label: 'scanAt', get: (s) => s.scanAt },
  { label: 'scanAtIso', get: (s) => new Date(s.scanAt).toISOString() },
  { label: 'kind', get: (s) => s.kind || 'signal_scan' },
  { label: 'signalSource', get: (s) => s.signalSource || ((s.kind === 'marci_signal') ? 'MARCI_INDEPENDENT_V2' : 'ORAYAN') },
  { label: 'id', get: (s) => s.id },
  { label: 'symbol', get: (s) => s.symbol },
  { label: 'side', get: (s) => s.side },
  { label: 'score', get: (s) => s.score },
  { label: 'rr', get: (s) => s.rr },
  { label: 'slDistPct', get: (s) => s.slDistPct },
  { label: 'entry', get: (s) => s.entry },
  { label: 'sl', get: (s) => s.sl },
  { label: 'tp', get: (s) => s.tp },
  { label: 'structureEvent', get: (s) => s.structureEvent },
  { label: 'structureTrend', get: (s) => s.structureTrend },
  { label: 'btcRegime', get: (s) => s.btcRegime },
  { label: 'regimeAligned', get: (s) => s.regimeAligned },
  { label: 'turnover24h', get: (s) => s.market?.turnover24h },
  { label: 'spreadPct', get: (s) => s.market?.spreadPct },
  { label: 'fundingRate', get: (s) => s.market?.fundingRate },
  { label: 'volRatio', get: (s) => s.market?.volRatio },
  // LOCATION_RESEARCH_V1. Observational only: exported for conditional-uplift / ablation work.
  { label: 'researchVersion', get: (s) => s.locationResearch?.version },
  { label: 'impulseMethod', get: (s) => s.locationResearch?.impulseMethod },
  { label: 'trendLegMethod', get: (s) => s.locationResearch?.trendLegMethod },
  { label: 'rizzyMethod', get: (s) => s.locationResearch?.rizzyMethod },
  { label: 'impulseLow', get: (s) => s.locationResearch?.impulseLow },
  { label: 'impulseHigh', get: (s) => s.locationResearch?.impulseHigh },
  { label: 'impulseRangePct', get: (s) => s.locationResearch?.impulseRangePct },
  { label: 'retracementDepthMark', get: (s) => s.locationResearch?.retracementDepthMark },
  { label: 'retracementDepthEntry', get: (s) => s.locationResearch?.retracementDepthEntry },
  { label: 'trendLocation', get: (s) => s.locationResearch?.trendLocation },
  { label: 'locationBucket', get: (s) => s.locationResearch?.locationBucket },
  { label: 'distanceFromExtremeAtr', get: (s) => s.locationResearch?.distanceFromExtremeAtr },
  { label: 'bbMid', get: (s) => s.locationResearch?.bbMid },
  { label: 'bbStd', get: (s) => s.locationResearch?.bbStd },
  { label: 'bbUpper', get: (s) => s.locationResearch?.bbUpper },
  { label: 'bbLower', get: (s) => s.locationResearch?.bbLower },
  { label: 'bbZ', get: (s) => s.locationResearch?.bbZ },
  { label: 'bbPercentB', get: (s) => s.locationResearch?.bbPercentB },
  { label: 'trendLegNumber', get: (s) => s.locationResearch?.trendLegNumber },
  { label: 'rizzyPresent', get: (s) => s.locationResearch?.rizzyPresent },
  { label: 'rizzySequence', get: (s) => s.locationResearch?.rizzySequence },
  { label: 'rizzyProjectedTarget', get: (s) => s.locationResearch?.rizzyProjectedTarget },
  { label: 'rizzyTargetR', get: (s) => s.locationResearch?.rizzyTargetR },
  { label: 'rizzyInvalidated', get: (s) => s.locationResearch?.rizzyInvalidated },
  { label: 'rizzyDistanceAtr', get: (s) => s.locationResearch?.rizzyDistanceAtr },
  { label: 'rizzyAnchor1Price', get: (s) => s.locationResearch?.rizzyAnchor1Price },
  { label: 'rizzyAnchor1Ts', get: (s) => s.locationResearch?.rizzyAnchor1Ts },
  { label: 'rizzyAnchor2Price', get: (s) => s.locationResearch?.rizzyAnchor2Price },
  { label: 'rizzyAnchor2Ts', get: (s) => s.locationResearch?.rizzyAnchor2Ts },
  // MARCI research fields. V2 rows are independently generated and no longer depend on Orayan signals.
  { label: 'marciShadowVersion', get: (s) => s.marciShadow?.version },
  { label: 'marciShadowPassed', get: (s) => s.marciShadow?.passed },
  { label: 'marciShadowFailed', get: (s) => (s.marciShadow?.failed || []).join('|') },
  { label: 'marciIndependentScore', get: (s) => s.marciShadow?.independentScore },
  { label: 'marciSourceScore', get: (s) => s.marciShadow?.sourceScore },
  { label: 'marciRizzySequence', get: (s) => s.marciShadow?.rizzySequence },
  { label: 'marciProjectedTarget', get: (s) => s.marciShadow?.projectedTarget },
  { label: 'marciTargetR', get: (s) => s.marciShadow?.targetR },
  { label: 'marciBbZ', get: (s) => s.marciShadow?.bbZ },
  { label: 'marciTrendLocation', get: (s) => s.marciShadow?.trendLocation },
  { label: 'marciPatternKey', get: (s) => s.marciIndependent?.patternKey || s.marciShadow?.patternKey },
  { label: 'marciSignalMethod', get: (s) => s.marciIndependent?.signalMethod },
  { label: 'marciEntryMethod', get: (s) => s.marciIndependent?.entryMethod },
  { label: 'marciHardStopMethod', get: (s) => s.marciIndependent?.hardStopMethod },
  { label: 'marciInvalidationMethod', get: (s) => s.marciIndependent?.invalidationMethod },
  { label: 'marciPriorityScore', get: (s) => s.marciIndependent?.priorityScore || s.marciShadow?.priorityScore },
  { label: 'marciD', get: (s) => s.marciIndependent?.d },
  { label: 'marciDAtr', get: (s) => s.marciIndependent?.dAtr },
  { label: 'marciEma21', get: (s) => s.marciIndependent?.ema21 },
  { label: 'marciEma55', get: (s) => s.marciIndependent?.ema55 },
  { label: 'marciEma21SlopePct', get: (s) => s.marciIndependent?.ema21SlopePct },
  { label: 'marciBbPercentB', get: (s) => s.marciIndependent?.bbPercentB },
  { label: 'passed', get: (s) => s.gates?.passed },
  { label: 'failedGates', get: (s) => (s.gates?.failed || []).join('|') },
  // Score factors. The score is multiplicative (BASE 50 x factors) — see signals_trend.js.
  // EVERY factor is exported. The previous additive schema silently omitted the TREND engine's
  // `pullback` component entirely, so the one component that actually varied was invisible in
  // the journal and nobody could see that 37 of every score was a constant. Never ship a score
  // component that has no column here.
  { label: 'base', get: (s) => s.components?.base },
  { label: 'trendMult', get: (s) => s.components?.trendMult },
  { label: 'entryMult', get: (s) => s.components?.entryMult },
  { label: 'breakMult', get: (s) => s.components?.breakMult },
  { label: 'locMult', get: (s) => s.components?.locMult },
  { label: 'regimeMult', get: (s) => s.components?.regimeMult },
  { label: 'momMult', get: (s) => s.components?.momMult },
  { label: 'entryDistAtr', get: (s) => s.components?.entryDistAtr ?? s.components?.locDistAtr },
  { label: 'trendStrength', get: (s) => s.components?.trendStrength },
  { label: 'emaAgree', get: (s) => s.components?.emaAgree },
  { label: 'rsi', get: (s) => s.components?.rsi },
  // kind:'bos_event' rows only (fake-BOS forward validation) — see bosTracker.js.
  // Blank on ordinary kind:'signal_scan' rows.
  { label: 'bosLevel', get: (s) => s.bosLevel },
  { label: 'bosBreakTs', get: (s) => s.bosBreakTs },
  { label: 'bosBreakIso', get: (s) => s.bosBreakIso },
  { label: 'bosOutcome', get: (s) => s.bosOutcome },
  { label: 'bosBarsChecked', get: (s) => s.bosBarsChecked },
];

const SIGNAL_COLUMNS = ['version','at','scanId','marketSnapshotId','engine','engineVariant',
  'candidateKey','candidateId','symbol','side','event','state','score','passed','failedGates',
  'entryMode','orderMode','entry','sl','tp','researchClass','changed','reason','tradeId','exchangeOrderId',
  'bosLevel','bosBreakTs','bosBarsChecked'].map(label => ({ label, get:s => s[label] }));

function exportTrades(trades, format) {
  if (format === 'csv') return { body: toCsv(trades, TRADE_COLUMNS), contentType: 'text/csv; charset=utf-8', ext: 'csv' };
  return { body: JSON.stringify({ exportedAt: Date.now(), count: trades.length, trades }, null, 2), contentType: 'application/json; charset=utf-8', ext: 'json' };
}

function exportSignals(signals, format, { legacy = false } = {}) {
  if (format === 'csv') return { body: toCsv(signals, legacy ? LEGACY_SIGNAL_COLUMNS : SIGNAL_COLUMNS), contentType: 'text/csv; charset=utf-8', ext: 'csv' };
  return { body: JSON.stringify({ schema:legacy ? 'SIGNAL_SCAN_LEGACY_V1' : COMPACT_VERSION,
    exportedAt: Date.now(), count: signals.length, signals }), contentType: 'application/json; charset=utf-8', ext: 'json' };
}

module.exports = {
  recordSignals, recordSignalOutcome, getSignalHistory, clearSignalHistory, recordBosEvent, flush,
  exportTrades, exportSignals,
  getResearchEnvironment: researchJournal.getSnapshots,
  getResearchEvents: researchJournal.getEvents,
  captureMarketSnapshot: researchJournal.captureMarketSnapshot,
  buildMarketObservation: researchJournal.observation,
  clearResearch: researchJournal.clear,
  exportResearchRows: (rows, format) => {
    if (format !== 'csv') return {body:JSON.stringify(rows),contentType:'application/json; charset=utf-8'};
    const keys = [...new Set(rows.flatMap(r => Object.keys(r)))];
    return {body:toCsv(rows,keys.map(k=>({label:k,get:r=>r[k]}))),contentType:'text/csv; charset=utf-8'};
  },
};
