'use strict';

/**
 * Dual-engine facade.
 * STRUCTURE_RETEST  — causal BOS/CHoCH retest (signals_structure.js)
 * TREND_PULLBACK    — EMA trend pullback (signals_trend.js)
 */

const structure = require('./signals_structure');
const trend = require('./signals_trend');

function detectBtcRegime(candles) {
  // Prefer structure module's closed-bar aware regime if available
  return structure.detectBtcRegime(candles);
}

function buildSignalStructure(args) {
  const out = structure.buildSignal(args);
  if (out.ok && out.signal) {
    out.signal.engine = 'STRUCTURE';
    out.signal.entryPath = out.signal.entryPath || 'STRUCTURE_RETEST';
  }
  return out;
}

function buildSignalTrend(args) {
  const out = trend.buildSignal(args);
  if (out.ok && out.signal) {
    out.signal.engine = 'TREND';
    out.signal.entryPath = out.signal.entryPath || 'TREND_PULLBACK';
  }
  return out;
}

/** Single-engine helper (legacy callers). */
function buildSignal(args) {
  const mode = (args.settings && args.settings.activeEngine) || 'STRUCTURE';
  if (mode === 'TREND') return buildSignalTrend(args);
  return buildSignalStructure(args);
}

module.exports = {
  detectBtcRegime,
  buildSignal,
  buildSignalStructure,
  buildSignalTrend,
  regimeAllows: structure.regimeAllows,
};
