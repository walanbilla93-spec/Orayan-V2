'use strict';

/**
 * Orayan II — observational Location Research Layer
 *
 * PURPOSE
 * -------
 * Measure WHERE a setup occurs inside its active trend/impulse without changing whether the
 * setup is allowed, its score, its size, its stop, or its target. These fields are research
 * telemetry only. They are copied unchanged from signal -> trade so resolved-trade analysis can
 * test location hypotheses out of sample.
 *
 * All candle-derived values use CLOSED candles supplied by marketData.getCandles(). The live
 * mark/planned entry is used only for the two explicitly named location-at-price measurements.
 */

const { emaSeries, sma } = require('./indicators');
const { num } = require('./util');

function stddev(values, period = 20) {
  if (!values || values.length < period) return null;
  const xs = values.slice(-period).map((v) => num(v));
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

function pivots(candles, width = 2) {
  const highs = [];
  const lows = [];
  const end = candles.length;
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
    if (isH) highs.push({ i, price: h, ts: candles[i].ts });
    if (isL) lows.push({ i, price: l, ts: candles[i].ts });
  }
  return { highs, lows };
}

function lastTrendStart(closes, side) {
  const fast = emaSeries(closes, 21);
  const slow = emaSeries(closes, 55);
  let start = 54;
  for (let i = 55; i < closes.length; i++) {
    if (fast[i] == null || slow[i] == null || fast[i - 1] == null || slow[i - 1] == null) continue;
    const crossed = side === 'BUY'
      ? fast[i] > slow[i] && fast[i - 1] <= slow[i - 1]
      : fast[i] < slow[i] && fast[i - 1] >= slow[i - 1];
    if (crossed) start = i;
  }
  return start;
}

function activeImpulse(candles, side, ps, trendStart) {
  const lastIdx = candles.length - 1;
  if (side === 'BUY') {
    const candidates = ps.lows.filter((p) => p.i >= trendStart && p.i < lastIdx);
    const origin = candidates.length ? candidates[candidates.length - 1] : null;
    if (!origin) return null;
    let extreme = { i: origin.i, price: num(candles[origin.i].high), ts: candles[origin.i].ts };
    for (let i = origin.i; i <= lastIdx; i++) {
      if (num(candles[i].high) >= extreme.price) extreme = { i, price: num(candles[i].high), ts: candles[i].ts };
    }
    if (!(extreme.price > origin.price)) return null;
    return { origin, extreme, low: origin.price, high: extreme.price };
  }

  const candidates = ps.highs.filter((p) => p.i >= trendStart && p.i < lastIdx);
  const origin = candidates.length ? candidates[candidates.length - 1] : null;
  if (!origin) return null;
  let extreme = { i: origin.i, price: num(candles[origin.i].low), ts: candles[origin.i].ts };
  for (let i = origin.i; i <= lastIdx; i++) {
    if (num(candles[i].low) <= extreme.price) extreme = { i, price: num(candles[i].low), ts: candles[i].ts };
  }
  if (!(origin.price > extreme.price)) return null;
  return { origin, extreme, low: extreme.price, high: origin.price };
}

function retracementDepth(side, impulse, price) {
  if (!impulse || !(impulse.high > impulse.low) || !Number.isFinite(price)) return null;
  const range = impulse.high - impulse.low;
  return side === 'BUY'
    ? (impulse.high - price) / range
    : (price - impulse.low) / range;
}

function rizzyGeometry(candles, side, ps, trendStart, atrVal) {
  const lastIdx = candles.length - 1;
  const anchors = (side === 'BUY' ? ps.lows : ps.highs).filter((p) => p.i >= trendStart);
  if (anchors.length < 2) return { present: false, sequence: Math.max(0, anchors.length - 1) };

  const a1 = anchors[anchors.length - 2];
  const a2 = anchors[anchors.length - 1];
  if (a2.i <= a1.i) return { present: false, sequence: anchors.length - 1 };
  const slope = (a2.price - a1.price) / (a2.i - a1.i);
  const lineAt = (i) => a1.price + slope * (i - a1.i);

  // Little Rizzy requires the trendline to slope with the trend.
  if ((side === 'BUY' && slope <= 0) || (side === 'SELL' && slope >= 0)) {
    return { present: false, sequence: anchors.length - 1 };
  }

  let extreme = null;
  for (let i = a2.i; i <= lastIdx; i++) {
    const px = side === 'BUY' ? num(candles[i].high) : num(candles[i].low);
    if (!extreme || (side === 'BUY' ? px > extreme.price : px < extreme.price)) {
      extreme = { i, price: px, ts: candles[i].ts };
    }
  }
  if (!extreme || extreme.i <= a2.i) return { present: false, sequence: anchors.length - 1 };

  const trendlineAtExtreme = lineAt(extreme.i);
  const distance = side === 'BUY'
    ? extreme.price - trendlineAtExtreme
    : trendlineAtExtreme - extreme.price;
  if (!(distance > 0)) return { present: false, sequence: anchors.length - 1 };

  const currentLine = lineAt(lastIdx);
  const lastClose = num(candles[lastIdx].close);
  const invalidated = side === 'BUY' ? lastClose < currentLine : lastClose > currentLine;
  const projectedTarget = side === 'BUY' ? extreme.price + distance : extreme.price - distance;

  return {
    present: !invalidated,
    sequence: anchors.length - 1,
    anchor1Price: a1.price,
    anchor1Ts: a1.ts,
    anchor2Price: a2.price,
    anchor2Ts: a2.ts,
    trendlineSlopePerBar: slope,
    trendlineAtExtreme,
    extremePrice: extreme.price,
    extremeTs: extreme.ts,
    distance,
    distanceAtr: atrVal > 0 ? distance / atrVal : null,
    projectedTarget,
    invalidated,
  };
}

function classifyLocation(depth) {
  if (depth == null || !Number.isFinite(depth)) return 'UNKNOWN';
  if (depth < 0) return 'EXTENSION';
  if (depth < 0.20) return 'EXTREME_0_20';
  if (depth < 0.40) return 'SHALLOW_20_40';
  if (depth < 0.60) return 'EQUILIBRIUM_40_60';
  if (depth < 0.80) return 'DEEP_60_80';
  if (depth <= 1.0) return 'ORIGIN_80_100';
  return 'BEYOND_ORIGIN';
}

function measure({ candles, signal }) {
  if (!candles || candles.length < 60 || !signal) return null;
  const side = signal.side;
  if (side !== 'BUY' && side !== 'SELL') return null;

  const closes = candles.map((c) => num(c.close));
  const ps = pivots(candles, 2);
  const trendStart = lastTrendStart(closes, side);
  const impulse = activeImpulse(candles, side, ps, trendStart);
  const markPrice = num(signal.price) || closes[closes.length - 1];
  const plannedEntry = num(signal.entry) || markPrice;
  const atrVal = num(signal.atr);

  const depthAtMark = retracementDepth(side, impulse, markPrice);
  const depthAtEntry = retracementDepth(side, impulse, plannedEntry);

  const bbMid = sma(closes, 20);
  const bbStd = stddev(closes, 20);
  const bbUpper = bbMid != null && bbStd != null ? bbMid + 2 * bbStd : null;
  const bbLower = bbMid != null && bbStd != null ? bbMid - 2 * bbStd : null;
  const bbZ = bbStd > 0 ? (markPrice - bbMid) / bbStd : null;
  const bbPercentB = bbUpper != null && bbLower != null && bbUpper !== bbLower
    ? (markPrice - bbLower) / (bbUpper - bbLower)
    : null;

  const directionalPivots = (side === 'BUY' ? ps.highs : ps.lows).filter((p) => p.i >= trendStart);
  const trendLegNumber = Math.max(1, directionalPivots.length || 1);
  const rizzy = rizzyGeometry(candles, side, ps, trendStart, atrVal);

  const impulseRange = impulse ? impulse.high - impulse.low : null;
  const distanceFromExtreme = impulse
    ? (side === 'BUY' ? impulse.high - markPrice : markPrice - impulse.low)
    : null;

  let rizzyTargetR = null;
  if (rizzy.present && rizzy.projectedTarget != null && signal.sl != null) {
    const risk = Math.abs(plannedEntry - num(signal.sl));
    const reward = side === 'BUY'
      ? rizzy.projectedTarget - plannedEntry
      : plannedEntry - rizzy.projectedTarget;
    if (risk > 0) rizzyTargetR = reward / risk;
  }

  return {
    version: 'LOCATION_RESEARCH_V1',
    observationalOnly: true,
    impulseMethod: 'LAST_CONFIRMED_PIVOT2_TO_DIRECTIONAL_EXTREME',
    trendLegMethod: 'EMA21_55_CROSS_DIRECTIONAL_CONFIRMED_PIVOTS',
    rizzyMethod: 'LAST_TWO_CONFIRMED_TRENDLINE_PIVOTS',
    trendStartTs: candles[trendStart]?.ts ?? null,
    trendStartIndex: trendStart,
    impulseLow: impulse?.low ?? null,
    impulseHigh: impulse?.high ?? null,
    impulseOriginTs: impulse?.origin?.ts ?? null,
    impulseExtremeTs: impulse?.extreme?.ts ?? null,
    impulseRangePct: impulseRange != null && impulse.low > 0 ? (impulseRange / impulse.low) * 100 : null,
    retracementDepthMark: depthAtMark,
    retracementDepthEntry: depthAtEntry,
    trendLocation: depthAtEntry,
    locationBucket: classifyLocation(depthAtEntry),
    distanceFromExtremeAtr: atrVal > 0 && distanceFromExtreme != null ? distanceFromExtreme / atrVal : null,
    bbMid,
    bbStd,
    bbUpper,
    bbLower,
    bbZ,
    bbPercentB,
    trendLegNumber,
    rizzyPresent: rizzy.present,
    rizzySequence: rizzy.sequence,
    rizzyProjectedTarget: rizzy.projectedTarget ?? null,
    rizzyTargetR,
    rizzyInvalidated: rizzy.invalidated ?? null,
    rizzyDistanceAtr: rizzy.distanceAtr ?? null,
    rizzyAnchor1Price: rizzy.anchor1Price ?? null,
    rizzyAnchor1Ts: rizzy.anchor1Ts ?? null,
    rizzyAnchor2Price: rizzy.anchor2Price ?? null,
    rizzyAnchor2Ts: rizzy.anchor2Ts ?? null,
  };
}

module.exports = { measure, stddev, pivots, retracementDepth, classifyLocation };
