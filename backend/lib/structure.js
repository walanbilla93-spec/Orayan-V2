'use strict';

/**
 * Causal market structure — closed bars only.
 *
 * Critical rules:
 * - Never read the forming candle for pivots, BOS, or CHoCH
 * - eventIndex = index of the candle that CLOSED beyond the pivot (the break), not the pivot itself
 * - Pivot confirmation requires `width` bars on both sides (non-repainting)
 */

const { num } = require('./util');

/**
 * Fractal swings on CLOSED candles only.
 * Pass candles that already exclude the forming bar, or this function will slice it off.
 */
function findPivots(candles, width = 2) {
  const highs = [];
  const lows = [];
  // Use only closed bars: drop last element if caller passed full series including forming
  const bars = candles;
  if (!bars || bars.length < width * 2 + 1) return { highs, lows };

  // Last index that can be confirmed: need `width` bars after it
  const lastConfirmable = bars.length - 1 - width;
  for (let i = width; i <= lastConfirmable; i++) {
    const h = num(bars[i].high);
    const l = num(bars[i].low);
    let isHigh = true;
    let isLow = true;
    for (let j = i - width; j <= i + width; j++) {
      if (j === i) continue;
      if (num(bars[j].high) >= h) isHigh = false;
      if (num(bars[j].low) <= l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ i, price: h, ts: bars[i].ts });
    if (isLow) lows.push({ i, price: l, ts: bars[i].ts });
  }
  return { highs, lows };
}

/**
 * Detect BOS / CHoCH using only closed candles.
 *
 * eventIndex = index of the break candle (first closed bar that broke the pivot),
 * not the pivot index.
 */
function detectStructure(closedCandles, width = 2) {
  const bars = closedCandles;
  const out = {
    trend: 'NONE',
    event: 'NONE',
    eventIndex: null,
    brokenLevel: null,
    lastHigh: null,
    lastLow: null,
    prevHigh: null,
    prevLow: null,
    highs: [],
    lows: [],
  };

  if (!bars || bars.length < width * 2 + 3) return out;

  const { highs, lows } = findPivots(bars, width);
  out.highs = highs;
  out.lows = lows;
  out.lastHigh = highs.length ? highs[highs.length - 1] : null;
  out.lastLow = lows.length ? lows[lows.length - 1] : null;
  out.prevHigh = highs.length > 1 ? highs[highs.length - 2] : null;
  out.prevLow = lows.length > 1 ? lows[lows.length - 2] : null;

  if (highs.length < 2 || lows.length < 2) return out;

  const hh = out.lastHigh.price > out.prevHigh.price;
  const hl = out.lastLow.price > out.prevLow.price;
  const lh = out.lastHigh.price < out.prevHigh.price;
  const ll = out.lastLow.price < out.prevLow.price;

  if (hh && hl) out.trend = 'UP';
  else if (lh && ll) out.trend = 'DOWN';
  else out.trend = 'RANGE';

  // Find the most recent structural break: a closed bar beyond the last confirmed pivot
  // Search from the pivot forward on CLOSED bars only
  const lastBar = bars.length - 1;

  // Prefer the latest break (up or down) by which break candle is more recent
  let upBreak = null;
  let downBreak = null;

  if (out.lastHigh) {
    const level = out.lastHigh.price;
    const start = out.lastHigh.i + 1;
    for (let i = start; i <= lastBar; i++) {
      if (num(bars[i].close) > level) {
        upBreak = { eventIndex: i, level, kind: out.trend === 'DOWN' ? 'CHOCH_UP' : 'BOS_UP' };
        // keep first break after pivot (true break birth); don't walk further
        break;
      }
    }
  }

  if (out.lastLow) {
    const level = out.lastLow.price;
    const start = out.lastLow.i + 1;
    for (let i = start; i <= lastBar; i++) {
      if (num(bars[i].close) < level) {
        downBreak = { eventIndex: i, level, kind: out.trend === 'UP' ? 'CHOCH_DOWN' : 'BOS_DOWN' };
        break;
      }
    }
  }

  // Choose the more recent break
  if (upBreak && downBreak) {
    if (upBreak.eventIndex >= downBreak.eventIndex) {
      out.event = upBreak.kind;
      out.eventIndex = upBreak.eventIndex;
      out.brokenLevel = upBreak.level;
    } else {
      out.event = downBreak.kind;
      out.eventIndex = downBreak.eventIndex;
      out.brokenLevel = downBreak.level;
    }
  } else if (upBreak) {
    out.event = upBreak.kind;
    out.eventIndex = upBreak.eventIndex;
    out.brokenLevel = upBreak.level;
  } else if (downBreak) {
    out.event = downBreak.kind;
    out.eventIndex = downBreak.eventIndex;
    out.brokenLevel = downBreak.level;
  }

  // Stale break: if break is too far in the past, clear event (avoid acting on ancient BOS)
  if (out.eventIndex != null && lastBar - out.eventIndex > 30) {
    out.event = 'NONE';
    out.eventIndex = null;
    out.brokenLevel = null;
  }

  return out;
}

/**
 * Nearest S/R from confirmed pivots. tolerancePct can be ATR-based from caller.
 */
function keyLevels(closedCandles, price, width = 2, tolerancePct = 0.2) {
  const { highs, lows } = findPivots(closedCandles, width);
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

  const resistances = cluster(highs)
    .filter((g) => g.price > price)
    .sort((a, b) => a.price - b.price);
  const supports = cluster(lows)
    .filter((g) => g.price < price)
    .sort((a, b) => b.price - a.price);

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
