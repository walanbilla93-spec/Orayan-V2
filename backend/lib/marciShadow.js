'use strict';

/**
 * MARCI_SHADOW_V1
 * ----------------
 * Research-only execution layer fed by the SAME Orayan signal source.
 *
 * It deliberately does not claim to reproduce Marci Silfrain's discretionary method exactly.
 * The parts we can make deterministic from the current 15m data are:
 *   - trendline geometry from the two most recent confirmed directional pivots;
 *   - early Little-Rizzy sequence preference (1st/2nd only);
 *   - full measured-move D target;
 *   - candle-CLOSE trendline invalidation;
 *   - fixed hard stop retained as a max-loss backstop.
 *
 * Bollinger state is recorded with the signal/trade but is not a hard gate in V1 because the
 * source material does not specify a deterministic numeric BB threshold for entry.
 */

const { clamp, num } = require('./util');

const VERSION = 'MARCI_SHADOW_V1';

function independentScore(signal) {
  const c = signal?.components || {};
  const base = num(c.base, 50);
  const trend = num(c.trendMult, 1);
  const entry = num(c.entryMult, 1);
  const mom = num(c.momMult, 1);
  // BTC regime multiplier is intentionally omitted. The shadow engine is the experiment that
  // tests whether a strong individual alt setup can earn permission while BTC is unhelpful.
  return Math.round(clamp(base * trend * entry * mom, 0, 100));
}

function evaluate(signal, baseVerdict, settings = {}) {
  const lr = signal?.locationResearch;
  const failed = [];
  const checks = [];
  const record = (name, pass, detail) => {
    checks.push({ name, pass, detail });
    if (!pass) failed.push(name);
  };

  record('COMMON_GATES_EX_BTC', Boolean(baseVerdict?.passed),
    baseVerdict?.passed ? 'all common gates passed with BTC disabled' : (baseVerdict?.failed || []).join('|'));

  record('RIZZY_PRESENT', Boolean(lr?.rizzyPresent),
    `present=${Boolean(lr?.rizzyPresent)} invalidated=${lr?.rizzyInvalidated}`);

  const seq = Number(lr?.rizzySequence);
  record('EARLY_RIZZY_1_2', Number.isFinite(seq) && seq >= 1 && seq <= 2,
    `sequence=${Number.isFinite(seq) ? seq : 'unknown'}`);

  const target = num(lr?.rizzyProjectedTarget, NaN);
  const entry = num(signal?.entry, NaN);
  const sl = num(signal?.sl, NaN);
  const side = signal?.side;
  const targetDirectional = Number.isFinite(target) && Number.isFinite(entry)
    && (side === 'BUY' ? target > entry : side === 'SELL' ? target < entry : false);
  record('D_TARGET_VALID', targetDirectional, `entry=${entry} D-target=${target}`);

  const risk = Number.isFinite(entry) && Number.isFinite(sl) ? Math.abs(entry - sl) : NaN;
  const reward = targetDirectional ? Math.abs(target - entry) : NaN;
  const targetR = risk > 0 && Number.isFinite(reward) ? reward / risk : null;
  record('POSITIVE_TARGET_R', targetR != null && targetR > 0, `D target R=${targetR}`);

  const targetMovePct = targetDirectional && entry > 0 ? (Math.abs(target - entry) / entry) * 100 : null;
  const roundTripPct = num(settings.takerFeePct) + num(settings.makerFeePct);
  const requiredCostMove = roundTripPct * num(settings.costFloorMultiple, 2.5);
  record('D_TARGET_COST_FLOOR', targetMovePct != null && targetMovePct >= requiredCostMove,
    `D move=${targetMovePct}%, required=${requiredCostMove}%`);

  return {
    version: VERSION,
    passed: failed.length === 0,
    failed,
    checks,
    independentScore: independentScore(signal),
    sourceScore: signal?.score ?? null,
    btcRegimeBypassed: true,
    rizzySequence: Number.isFinite(seq) ? seq : null,
    projectedTarget: Number.isFinite(target) ? target : null,
    targetR,
    bbZ: lr?.bbZ ?? null,
    bbPercentB: lr?.bbPercentB ?? null,
    trendLocation: lr?.trendLocation ?? null,
    locationBucket: lr?.locationBucket ?? null,
  };
}

function buildShadowSignal(signal, assessment) {
  return {
    ...signal,
    id: `${signal.id}_marci`,
    sourceSignalId: signal.id,
    engine: 'MARCI_SHADOW',
    score: assessment.independentScore,
    sourceScore: signal.score,
    tp: assessment.projectedTarget,
    rr: assessment.targetR,
    marciShadow: assessment,
  };
}

function trendlineAt(trade, ts) {
  const lr = trade?.locationResearch;
  const a1p = num(lr?.rizzyAnchor1Price, NaN);
  const a2p = num(lr?.rizzyAnchor2Price, NaN);
  const a1t = num(lr?.rizzyAnchor1Ts, NaN);
  const a2t = num(lr?.rizzyAnchor2Ts, NaN);
  if (![a1p, a2p, a1t, a2t, ts].every(Number.isFinite) || a2t <= a1t) return null;
  const slopePerMs = (a2p - a1p) / (a2t - a1t);
  return a1p + slopePerMs * (ts - a1t);
}

function invalidation(trade, candle) {
  if (!trade || !candle) return { invalidated: false };
  const line = trendlineAt(trade, num(candle.ts));
  if (!Number.isFinite(line)) return { invalidated: false, line: null };
  const close = num(candle.close, NaN);
  if (!Number.isFinite(close)) return { invalidated: false, line };
  const invalidated = trade.side === 'BUY' ? close < line : close > line;
  return { invalidated, line, close };
}

module.exports = { VERSION, independentScore, evaluate, buildShadowSignal, trendlineAt, invalidation };
