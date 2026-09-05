'use strict';

const store = require('./store');
const logger = require('./logger');

/*
 * SIGNAL HISTORY
 *
 * `engine.state.lastSignals` is overwritten every scan — by design, it's "what the dashboard
 * shows right now", not a log. But gate-tuning analysis (which is most of what this operator
 * does with exported data) needs to see what was rejected and why across many scans, not just
 * the most recent one. So every scan's signals are appended here, independently of what the UI
 * happens to be showing.
 */

const MAX_SIGNAL_HISTORY = 20000;

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
    scanId: s.scanId ?? null,
    scanAt: s.scanAt ?? null,
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
    store.write('signalHistory', signalHistory);
  }, 3000);
  if (flushTimer.unref) flushTimer.unref();
}

/** Force an immediate write — used on shutdown so nothing in the buffer is lost. */
function flush() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!dirty) return;
  dirty = false;
  store.write('signalHistory', signalHistory);
}

function trim() {
  if (signalHistory.length > MAX_SIGNAL_HISTORY) {
    signalHistory.splice(0, signalHistory.length - MAX_SIGNAL_HISTORY);
  }
}

function recordSignals(signals, scanMeta) {
  if (!signals || !signals.length) return;
  const stamped = signals.map((s) => compactSignalForJournal({
    ...s,
    scanId: scanMeta.scanId,
    scanAt: scanMeta.scanAt,
  }));
  signalHistory.push(...stamped);
  trim();
  scheduleFlush();
}

function getSignalHistory({ limit = 5000 } = {}) {
  return signalHistory.slice(-limit);
}

function clearSignalHistory() {
  signalHistory = [];
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  dirty = false;
  store.write('signalHistory', signalHistory);
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
  signalHistory.push(row);
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
  { label: 'sourceSignalId', get: (t) => t.sourceSignalId || '' },
  { label: 'sourceScore', get: (t) => t.sourceScore },
  { label: 'marciShadowVersion', get: (t) => t.marciShadow?.version },
  { label: 'marciIndependentScore', get: (t) => t.marciShadow?.independentScore },
  { label: 'marciRizzySequence', get: (t) => t.marciShadow?.rizzySequence },
  { label: 'marciProjectedTarget', get: (t) => t.marciShadow?.projectedTarget },
  { label: 'marciTargetR', get: (t) => t.marciShadow?.targetR },
  { label: 'marciBbZ', get: (t) => t.marciShadow?.bbZ },
  { label: 'marciTrendLocation', get: (t) => t.marciShadow?.trendLocation },
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

const SIGNAL_COLUMNS = [
  { label: 'scanId', get: (s) => s.scanId },
  { label: 'scanAt', get: (s) => s.scanAt },
  { label: 'scanAtIso', get: (s) => new Date(s.scanAt).toISOString() },
  { label: 'kind', get: (s) => s.kind || 'signal_scan' },
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
  // Parallel MARCI_SHADOW_V1 assessment of this exact same source signal.
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

function exportTrades(trades, format) {
  if (format === 'csv') return { body: toCsv(trades, TRADE_COLUMNS), contentType: 'text/csv; charset=utf-8', ext: 'csv' };
  return { body: JSON.stringify({ exportedAt: Date.now(), count: trades.length, trades }, null, 2), contentType: 'application/json; charset=utf-8', ext: 'json' };
}

function exportSignals(signals, format) {
  if (format === 'csv') return { body: toCsv(signals, SIGNAL_COLUMNS), contentType: 'text/csv; charset=utf-8', ext: 'csv' };
  return { body: JSON.stringify({ exportedAt: Date.now(), count: signals.length, signals }, null, 2), contentType: 'application/json; charset=utf-8', ext: 'json' };
}

module.exports = {
  recordSignals, getSignalHistory, clearSignalHistory, recordBosEvent, flush,
  exportTrades, exportSignals,
};
