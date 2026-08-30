'use strict';

/**
 * Orayan II – Resilient Trend Pullback signal engine
 *
 * Design goals (vs previous fragile structure-retest):
 * - Trade WITH the trend only
 * - Enter on pullback, not on noise breaks
 * - Wider stops so normal 5m/15m noise does not kill every trade
 * - Few rules, all causal
 * - No dual-path complexity
 */

const { ema, rsi, atr, volumeRatio } = require('./indicators');
const { num, clamp, uid } = require('./util');

/*
 * Regime detection and permission live in signals_structure.js and are imported here rather
 * than duplicated.
 *
 * The previous local copies had diverged in two ways that mattered. detectBtcRegime here did
 * NOT drop the forming candle (the structure version does), so it silently repainted. And
 * regimeAllows here permitted shorts in BEAR_RANGE, which contradicts the validated block.
 * Two copies of one rule means every fix has to be made twice and eventually is not.
 */
const { detectBtcRegime, regimeAllows } = require('./signals_structure');

/** Recent swing low/high using simple fractal width=2 on closed bars only. */
function recentSwings(candles, width = 2) {
  const highs = [];
  const lows = [];
  const end = candles.length - 1; // exclude forming bar from confirmation side
  for (let i = width; i < end - width; i++) {
    const h = num(candles[i].high);
    const l = num(candles[i].low);
    let isH = true;
    let isL = true;
    for (let j = i - width; j <= i + width; j++) {
      if (j === i) continue;
      if (num(candles[j].high) >= h) isH = false;
      if (num(candles[j].low) <= l) isL = false;
    }
    if (isH) highs.push({ i, price: h });
    if (isL) lows.push({ i, price: l });
  }
  return {
    lastHigh: highs.length ? highs[highs.length - 1] : null,
    lastLow: lows.length ? lows[lows.length - 1] : null,
    prevHigh: highs.length > 1 ? highs[highs.length - 2] : null,
    prevLow: lows.length > 1 ? lows[lows.length - 2] : null,
  };
}

/**
 * Core trend state from slow EMAs — resilient, lagging on purpose.
 */
function detectTrend(candles) {
  const closes = candles.map((c) => c.close);
  if (closes.length < 80) return { trend: 'NONE', eFast: null, eSlow: null, strength: 0 };

  const eFast = ema(closes, 21);
  const eSlow = ema(closes, 55);
  const price = closes[closes.length - 1];
  const eFastPrev = ema(closes.slice(0, -5), 21);
  const slope = eFastPrev ? ((eFast - eFastPrev) / eFastPrev) * 100 : 0;

  let trend = 'NONE';
  if (price > eSlow && eFast > eSlow && slope > 0) trend = 'UP';
  else if (price < eSlow && eFast < eSlow && slope < 0) trend = 'DOWN';

  // Strength: separation of EMAs + slope magnitude
  const sep = eSlow ? (Math.abs(eFast - eSlow) / eSlow) * 100 : 0;
  const strength = clamp(sep * 25 + Math.abs(slope) * 30, 0, 100);

  return { trend, eFast, eSlow, slope, sep, strength, price };
}

/**
 * Is price in a pullback zone (not extended, not broken)?
 */
function pullbackQuality(side, price, eFast, eSlow, atrVal) {
  const distFast = ((price - eFast) / price) * 100;
  const distSlow = ((price - eSlow) / price) * 100;
  const atrPct = (atrVal / price) * 100;

  if (side === 'BUY') {
    // Want price above slow EMA, pulled back toward fast EMA (not far above)
    if (price < eSlow) return { ok: false, reason: 'BELOW_SLOW_EMA' };
    // Extended = more than ~2.5 ATR above fast EMA
    if (distFast > atrPct * 2.2) return { ok: false, reason: 'EXTENDED' };
    // Ideal: near or slightly above fast EMA
    const nearFast = Math.abs(distFast) <= atrPct * 1.4;
    const mildPullback = distFast >= -atrPct * 0.3 && distFast <= atrPct * 1.6;
    if (!nearFast && !mildPullback) return { ok: false, reason: 'NOT_IN_PULLBACK' };
    // atrPct is returned so the score's entry factor can express distance in ATR units.
    return { ok: true, distFast, distSlow, atrPct };
  }

  // SELL
  if (price > eSlow) return { ok: false, reason: 'ABOVE_SLOW_EMA' };
  if (distFast < -atrPct * 2.2) return { ok: false, reason: 'EXTENDED' };
  const nearFast = Math.abs(distFast) <= atrPct * 1.4;
  const mildPullback = distFast <= atrPct * 0.3 && distFast >= -atrPct * 1.6;
  if (!nearFast && !mildPullback) return { ok: false, reason: 'NOT_IN_PULLBACK' };
  return { ok: true, distFast, distSlow, atrPct };
}

/**
 * Returns 0..1: ramps 0→1 across [lo,peakLo], holds 1 across [peakLo,peakHi], ramps 1→0
 * across [peakHi,hi]. Ported verbatim from the previous system's convictionScore — the shape
 * that produced the validated entry-quality factor.
 */
function smoothPeak(x, lo, hi, peakLo, peakHi) {
  if (!(x > lo) || x >= hi) return 0;
  if (x >= peakLo && x <= peakHi) return 1;
  if (x < peakLo) return (x - lo) / (peakLo - lo);
  return (hi - x) / (hi - peakHi);
}

/*
 * SCORING — multiplicative, BASE 50. Rebuilt 2026-08-30 to restore the architecture SCORE_BAND
 * was actually validated against. Read this before changing any constant.
 *
 * WHY THE OLD ADDITIVE VERSION HAD TO GO. Measured on the live journal of 2026-08-29,
 * n=20,000 signals:
 *   - rrPts was 15 on every single signal. RR is fixed at targetR by construction, so this
 *     component is a constant offset carrying zero information.
 *   - trendPts was 22 on 94.9% of signals, because `Math.max(trendPts, 22)` pinned it to the
 *     floor whenever the trend agreed with the side — which, in a trend-pullback engine, is
 *     always.
 *   - That left 37 of every score constant and only two components — pullback and momentum —
 *     ever moving, one of which (pullback) had no journal column and was therefore unmeasurable.
 *   - Result: all 19 closed trades scored between 66 and 78. The 40/80 band had ZERO
 *     observations outside it. It was not failing; it was never tested.
 *
 * WHY MULTIPLICATIVE. SCORE_BAND's validated finding is that score is U-SHAPED, not linear:
 * bucketed on 167 resolved signals, <40 = 27% WR (n=41), 40-80 = 60% WR (n=119), 80+ = 0% WR
 * (n=7). Leave-one-day-out held 6/6 days; within-day stratified permutation gave a 36.7pp gap
 * at p=0.0032; the plateau was flat across floors 35-45 and ceilings 75-85, so it is not a
 * fitted knife-edge.
 *
 * A U-shape is what multiplicative stacking produces and additive points cannot. Reaching 80+
 * requires EVERY factor near its maximum simultaneously — which is the definition of a euphoric,
 * fully-extended setup, and that is the 0W/7L exhaustion end. An additive sum reaching 80 says
 * only "several things were somewhat good", which is not the same statement at all.
 *
 * Because this restores BASE 50 and the same multiplier ranges the band was defined on, the
 * 40/80 numbers become meaningful again. They are transferred, not re-fitted. The transfer is
 * still `[Likely]`, not `[Certain]` — same generator architecture, different signal source — and
 * must be re-checked by BUCKET, never by mean or linear correlation. See docs/EVIDENCE.md.
 */
function scoreTrendSetup({ side, trendInfo, pb, r, vr, rr, btcRegime }) {
  const components = {};
  const BASE = 50;

  // FACTOR 1 — trend quality (0.80 .. 1.30).
  // Replaces the old trendPts, whose Math.max floor destroyed 95% of its variance. Strength is
  // continuous by construction (EMA separation + slope), so it is used continuously.
  const st = clamp(num(trendInfo.strength) / 60, 0, 1);
  const trendMult = 0.80 + 0.50 * st;
  components.trendMult = Number(trendMult.toFixed(4));
  components.trendStrength = num(trendInfo.strength);

  // FACTOR 2 — entry quality (0.45 .. 1.15), measured in ATR units from the fast EMA.
  // Same shape and the same 0.45/0.70 span as the validated entry factor. The peak window is
  // this engine's own pullback zone rather than the old engine's zone-touch distance, because
  // the geometry differs; the curve is inherited, the window is this engine's definition.
  const atrPct = num(pb && pb.atrPct, 0) || (num(trendInfo.price) ? 0 : 0);
  const distFastPct = Math.abs(num(pb && pb.distFast));
  const dAtr = atrPct > 0 ? distFastPct / atrPct : 0;
  const entryPeak = smoothPeak(dAtr, 0.0, 2.2, 0.15, 0.90);
  const entryMult = 0.45 + 0.70 * entryPeak;
  components.entryMult = Number(entryMult.toFixed(4));
  components.entryDistAtr = Number(dAtr.toFixed(4));

  // FACTOR 3 — regime alignment scaled by strength (0.30 .. 1.20).
  // Aligned: strength helps. Opposed: strength HURTS, multiplicatively. This is the factor that
  // most directly produces the low end of the U.
  const regimeStrength = clamp(num(btcRegime && btcRegime.strength) / 100, 0, 1);
  const aligned = regimeAllows(btcRegime.regime, side);
  const regimeMult = aligned
    ? 1.00 + 0.20 * regimeStrength
    : clamp(0.85 - 0.50 * regimeStrength, 0.30, 0.95);
  components.regimeMult = Number(regimeMult.toFixed(4));

  // FACTOR 4 — momentum (0.85 .. 1.10). Deliberately the weakest factor: RSI zone was never
  // independently validated on this engine, so it nudges rather than decides.
  let momMult = 1.00;
  if (r != null) {
    if (side === 'BUY' && r >= 40 && r <= 62) momMult = 1.10;
    else if (side === 'SELL' && r >= 38 && r <= 60) momMult = 1.10;
    else if (side === 'BUY' && r > 72) momMult = 0.85;
    else if (side === 'SELL' && r < 28) momMult = 0.85;
  }
  components.momMult = Number(momMult.toFixed(4));

  // rrPts is GONE, not zeroed. RR is fixed at targetR by construction, so it was a constant
  // offset. Keeping it as a factor of 1.0 would be the same dead weight wearing a new name.

  components.rsi = r;
  components.volumeRatio = vr;
  components.regimeAligned = aligned;

  const score = Math.round(clamp(BASE * trendMult * entryMult * regimeMult * momMult, 0, 100));
  components.base = BASE;
  return { score, components, aligned };
}

/**
 * Resilient trend-pullback plan.
 */
function buildSignal({ symbol, candles, ticker, btcRegime, settings }) {
  if (!candles || candles.length < 90) return { ok: false, reason: 'NOT_ENOUGH_HISTORY' };

  const price = num(ticker?.markPrice) || num(candles[candles.length - 1].close);
  if (!price) return { ok: false, reason: 'NO_PRICE' };

  const a = atr(candles, 14);
  if (!a || a <= 0) return { ok: false, reason: 'NO_ATR' };

  const atrPct = (a / price) * 100;
  // Skip ultra-dead markets (stop would be pure noise)
  const minAtrPct = num(settings.minAtrPct, 0.25);
  if (atrPct < minAtrPct) return { ok: false, reason: 'ATR_TOO_SMALL' };

  const trendInfo = detectTrend(candles);
  if (trendInfo.trend === 'NONE') return { ok: false, reason: 'NO_TREND' };

  // Minimum trend strength — avoid flat EMA chop
  const minTrendStr = num(settings.minTrendStrength, 12);
  if (trendInfo.strength < minTrendStr) return { ok: false, reason: 'WEAK_TREND' };

  const side = trendInfo.trend === 'UP' ? 'BUY' : 'SELL';
  const pb = pullbackQuality(side, price, trendInfo.eFast, trendInfo.eSlow, a);
  if (!pb.ok) return { ok: false, reason: pb.reason };

  const swings = recentSwings(candles, 2);
  const minSlPct = num(settings.minSlDistPct, 3.0); // validated default (Phase 3b, 2026-08-19) — fallback kept in sync
  const minSlAbs = price * (minSlPct / 100);
  const cushion = Math.max(a * 0.8, minSlAbs * 0.9);

  let entry;
  let sl;
  let tp;

  if (side === 'BUY') {
    // Limit near fast EMA or slight discount to price
    entry = Math.min(price, trendInfo.eFast + a * 0.15);
    const swingLow = swings.lastLow?.price;
    sl = swingLow != null && swingLow < entry
      ? Math.min(swingLow - a * 0.2, entry - cushion)
      : entry - cushion;
    if ((entry - sl) / entry * 100 < minSlPct) sl = entry * (1 - minSlPct / 100);
    // Cap max stop so risk stays sane
    const maxSlPct = num(settings.maxSlDistPct, 5.0);
    if ((entry - sl) / entry * 100 > maxSlPct) sl = entry * (1 - maxSlPct / 100);
    const risk = entry - sl;
    const targetR = num(settings.trendTargetR, 2.0);
    tp = entry + risk * targetR;
  } else {
    entry = Math.max(price, trendInfo.eFast - a * 0.15);
    const swingHigh = swings.lastHigh?.price;
    sl = swingHigh != null && swingHigh > entry
      ? Math.max(swingHigh + a * 0.2, entry + cushion)
      : entry + cushion;
    if ((sl - entry) / entry * 100 < minSlPct) sl = entry * (1 + minSlPct / 100);
    const maxSlPct = num(settings.maxSlDistPct, 5.0);
    if ((sl - entry) / entry * 100 > maxSlPct) sl = entry * (1 + maxSlPct / 100);
    const risk = sl - entry;
    const targetR = num(settings.trendTargetR, 2.0);
    tp = entry - risk * targetR;
  }

  if (!(entry > 0) || !(sl > 0) || !(tp > 0)) return { ok: false, reason: 'INVALID_LEVELS' };
  if (side === 'BUY' && !(sl < entry && tp > entry)) return { ok: false, reason: 'INVERTED_PLAN' };
  if (side === 'SELL' && !(sl > entry && tp < entry)) return { ok: false, reason: 'INVERTED_PLAN' };

  const closes = candles.map((c) => c.close);
  const r = rsi(closes, 14);
  const vr = volumeRatio(candles, 20);
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  const rr = risk ? reward / risk : 0;

  const scored = scoreTrendSetup({
    side, trendInfo, pb, r, vr, rr, btcRegime: btcRegime || { regime: 'UNKNOWN' },
  });

  const slDistPct = (risk / entry) * 100;

  return {
    ok: true,
    signal: {
      id: uid('sig'),
      createdAt: Date.now(),
      symbol,
      side,
      price,
      entry,
      sl,
      tp,
      atr: a,
      slDistPct,
      rr: scored.rr || rr,
      score: scored.score,
      components: scored.components,
      structureEvent: 'TREND_PULLBACK',
      structureTrend: trendInfo.trend,
      entryPath: 'TREND_PULLBACK',
      entryPathReason: side === 'BUY' ? 'PULLBACK_IN_UPTREND' : 'PULLBACK_IN_DOWNTREND',
      breakSide: side,
      levels: {
        eFast: trendInfo.eFast,
        eSlow: trendInfo.eSlow,
        support: side === 'BUY' ? sl : null,
        resistance: side === 'SELL' ? sl : null,
        supportTouches: 0,
        resistanceTouches: 0,
      },
      market: {
        turnover24h: num(ticker?.turnover24h),
        spreadPct: ticker?.spreadPct ?? null,
        fundingRate: num(ticker?.fundingRate),
        volRatio: vr,
      },
      btcRegime: (btcRegime && btcRegime.regime) || 'UNKNOWN',
      regimeAligned: scored.aligned,
      timeframe: settings.timeframe,
      quality: {
        trendStrength: trendInfo.strength,
        atrPct,
        path: 'TREND_PULLBACK',
      },
    },
  };
}

// Keep exports compatible with engine
module.exports = {
  buildSignal,
  detectBtcRegime,
  regimeAllows,
  detectTrend,
  pullbackQuality,
  scoreTrendSetup, // exported for offline score-distribution / bucket analysis
};
