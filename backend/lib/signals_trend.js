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

function detectBtcRegime(candles) {
  if (!candles || candles.length < 60) return { regime: 'UNKNOWN', strength: 0 };
  const closes = candles.map((c) => c.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const price = closes[closes.length - 1];
  const a = atr(candles, 14);
  const atrPct = price ? (a / price) * 100 : 0;
  const above20 = price > e20;
  const above50 = price > e50;
  const stacked = e20 > e50;
  const slopePct = ((e20 - ema(closes.slice(0, -10), 20)) / e20) * 100;
  const trending = Math.abs(slopePct) > 0.25;

  let regime;
  if (above20 && above50 && stacked) regime = trending ? 'BULL_TREND' : 'BULL_RANGE';
  else if (!above20 && !above50 && !stacked) regime = trending ? 'BEAR_TREND' : 'BEAR_RANGE';
  else regime = 'CHOP';

  return { regime, strength: clamp(Math.abs(slopePct) * 40, 0, 100), atrPct, price };
}

function regimeAllows(regime, side) {
  switch (regime) {
    case 'BULL_TREND': return side === 'BUY';
    case 'BULL_RANGE': return side === 'BUY';
    case 'BEAR_TREND': return side === 'SELL';
    case 'BEAR_RANGE': return side === 'SELL';
    case 'CHOP': return false;
    default: return true;
  }
}

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
    return { ok: true, distFast, distSlow };
  }

  // SELL
  if (price > eSlow) return { ok: false, reason: 'ABOVE_SLOW_EMA' };
  if (distFast < -atrPct * 2.2) return { ok: false, reason: 'EXTENDED' };
  const nearFast = Math.abs(distFast) <= atrPct * 1.4;
  const mildPullback = distFast <= atrPct * 0.3 && distFast >= -atrPct * 1.6;
  if (!nearFast && !mildPullback) return { ok: false, reason: 'NOT_IN_PULLBACK' };
  return { ok: true, distFast, distSlow };
}

function scoreTrendSetup({ side, trendInfo, pb, r, vr, rr, btcRegime }) {
  const components = {};
  let trendPts = clamp(trendInfo.strength * 0.35, 0, 30);
  if (trendInfo.trend === (side === 'BUY' ? 'UP' : 'DOWN')) trendPts = Math.max(trendPts, 22);
  components.trend = Math.round(trendPts);

  let pbPts = 15;
  if (pb && pb.ok) {
    const d = Math.abs(pb.distFast || 0);
    if (d < 0.25) pbPts = 25;
    else if (d < 0.5) pbPts = 20;
    else pbPts = 14;
  } else pbPts = 0;
  components.pullback = pbPts;

  let momPts = 8;
  if (r != null) {
    if (side === 'BUY' && r >= 40 && r <= 62) momPts = 15;
    else if (side === 'SELL' && r >= 38 && r <= 60) momPts = 15;
    else if (side === 'BUY' && r > 70) momPts = 3;
    else if (side === 'SELL' && r < 30) momPts = 3;
  }
  components.momentum = momPts;

  // NOTE (Phase 3b, 2026-08-19): rr is always exactly targetR (fixed 2.0 by construction), so
  // rrPts always evaluates to the same constant 15 — dead weight, not a real signal. Confirmed
  // via Spearman correlation: constant input, correlation undefined. Left in place rather than
  // restructured here: it's a harmless constant offset (doesn't change relative ranking), and
  // removing it would shift the score's absolute scale, which could quietly interact with
  // SCORE_BAND gate thresholds that haven't been re-tested against a rescaled score. Worth a
  // dedicated pass later, not bundled in alongside the stop-distance fix.
  let rrPts = 0;
  if (rr >= 1.8 && rr <= 3.5) rrPts = 15;
  else if (rr >= 1.5 && rr < 1.8) rrPts = 10;
  else if (rr > 3.5 && rr <= 5) rrPts = 8;
  components.rr = rrPts;

  const aligned = regimeAllows(btcRegime.regime, side);
  const regimeMult = aligned ? 1.0 : 0.7;
  components.regimeMultiplier = regimeMult;
  components.volumeRatio = vr;
  components.rsi = r;

  const raw = components.trend + components.pullback + components.momentum + components.rr;
  const score = Math.round(clamp(raw * regimeMult, 0, 100));
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
    const maxSlPct = num(settings.maxSlDistPct, 3.5);
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
    const maxSlPct = num(settings.maxSlDistPct, 3.5);
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
};
