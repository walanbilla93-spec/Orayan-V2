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
let signalHistory = store.read('signalHistory', []);

function recordSignals(signals, scanMeta) {
  if (!signals || !signals.length) return;
  const stamped = signals.map((s) => ({ ...s, scanId: scanMeta.scanId, scanAt: scanMeta.scanAt }));
  signalHistory.push(...stamped);
  if (signalHistory.length > MAX_SIGNAL_HISTORY) {
    signalHistory.splice(0, signalHistory.length - MAX_SIGNAL_HISTORY);
  }
  store.write('signalHistory', signalHistory);
}

function getSignalHistory({ limit = 5000 } = {}) {
  return signalHistory.slice(-limit);
}

function clearSignalHistory() {
  signalHistory = [];
  store.write('signalHistory', signalHistory);
  logger.warn('journal', 'Signal history cleared by operator');
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
  { label: 'createdAtIso', get: (t) => t.createdAtIso || (t.createdAt ? new Date(t.createdAt).toISOString() : '') },
  { label: 'exchangeOrderId', get: (t) => t.exchangeOrderId },
];

const SIGNAL_COLUMNS = [
  { label: 'scanId', get: (s) => s.scanId },
  { label: 'scanAt', get: (s) => s.scanAt },
  { label: 'scanAtIso', get: (s) => new Date(s.scanAt).toISOString() },
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
  { label: 'passed', get: (s) => s.gates?.passed },
  { label: 'failedGates', get: (s) => (s.gates?.failed || []).join('|') },
  { label: 'trendPts', get: (s) => s.components?.trend },
  { label: 'structurePts', get: (s) => s.components?.structure },
  { label: 'momentumPts', get: (s) => s.components?.momentum },
  { label: 'locationPts', get: (s) => s.components?.location },
  { label: 'rrPts', get: (s) => s.components?.rr },
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
  recordSignals, getSignalHistory, clearSignalHistory,
  exportTrades, exportSignals,
};
