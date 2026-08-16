'use strict';

const { num } = require('./util');

/**
 * Fractal swing pivots. A pivot high needs `width` lower highs on both sides.
 *
 * The right-hand side matters: a pivot is only confirmed once `width` candles have closed after
 * it. Detecting pivots without that confirmation lag is the classic repainting bug — the level
 * looks perfect in hindsight and does not exist when you are actually trading it.
 */
function findPivots(candles, width = 2) {
  const highs = [];
  const lows = [];
  if (!candles || candles.length < width * 2 + 1) return { highs, lows };

  for (let i = width; i < candles.length - width; i++) {
    const h = num(candles[i].high);
    const l = num(candles[i].low);
    let isHigh = true;
    let isLow = true;
    for (let j = i - width; j <= i + width; j++) {
      if (j === i) continue;
      if (num(candles[j].high) >= h) isHigh = false;
      if (num(candles[j].low) <= l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ i, price: h, ts: candles[i].ts });
    if (isLow) lows.push({ i, price: l, ts: candles[i].ts });
  }
  return { highs, lows };
}

/**
 * Classify the most recent structural event.
 *   BOS  — break of structure, trend continuing
 *   CHoCH— change of character, trend potentially flipping
 */
function detectStructure(candles, width = 2) {
  const { highs, lows } = findPivots(candles, width);
  const out = {
    trend: 'NONE',
    event: 'NONE',
    eventIndex: null,
    lastHigh: highs.length ? highs[highs.length - 1] : null,
    lastLow: lows.length ? lows[lows.length - 1] : null,
    prevHigh: highs.length > 1 ? highs[highs.length - 2] : null,
    prevLow: lows.length > 1 ? lows[lows.length - 2] : null,
    highs,
    lows,
  };
  if (highs.length < 2 || lows.length < 2) return out;

  const hh = out.lastHigh.price > out.prevHigh.price;
  const hl = out.lastLow.price > out.prevLow.price;
  const lh = out.lastHigh.price < out.prevHigh.price;
  const ll = out.lastLow.price < out.prevLow.price;

  if (hh && hl) out.trend = 'UP';
  else if (lh && ll) out.trend = 'DOWN';
  else out.trend = 'RANGE';

  // Has price closed beyond the last confirmed pivot since it formed?
  const last = candles[candles.length - 1];
  const close = num(last.close);
  const brokeUp = close > out.lastHigh.price;
  const brokeDown = close < out.lastLow.price;

  if (brokeUp) {
    out.event = out.trend === 'DOWN' ? 'CHOCH_UP' : 'BOS_UP';
    out.eventIndex = out.lastHigh.i;
  } else if (brokeDown) {
    out.event = out.trend === 'UP' ? 'CHOCH_DOWN' : 'BOS_DOWN';
    out.eventIndex = out.lastLow.i;
  }
  return out;
}

/**
 * Nearest support below and resistance above the current price, drawn from confirmed pivots.
 * Levels touched more than once are stronger, so pivots are clustered before being ranked.
 */
function keyLevels(candles, price, width = 2, tolerancePct = 0.15) {
  const { highs, lows } = findPivots(candles, width);
  const cluster = (pivots) => {
    const groups = [];
    for (const p of pivots) {
      const g = groups.find((x) => Math.abs(x.price - p.price) / p.price * 100 <= tolerancePct);
      if (g) {
        g.touches += 1;
        g.price = (g.price * (g.touches - 1) + p.price) / g.touches;
        g.lastTs = Math.max(g.lastTs, p.ts);
      } else {
        groups.push({ price: p.price, touches: 1, lastTs: p.ts });
      }
    }
    return groups;
  };

  const resistances = cluster(highs).filter((g) => g.price > price).sort((a, b) => a.price - b.price);
  const supports = cluster(lows).filter((g) => g.price < price).sort((a, b) => b.price - a.price);

  return {
    support: supports[0] || null,
    support2: supports[1] || null,
    resistance: resistances[0] || null,
    resistance2: resistances[1] || null,
    allSupports: supports,
    allResistances: resistances,
  };
}

module.exports = { findPivots, detectStructure, keyLevels };
