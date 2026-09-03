'use strict';
const { findPivots } = require('./structure');

// Protected-swing structure detector (SHADOW MODE — not wired into gating).
// Difference from the original detectStructure(): CHoCH only fires on a break of the
// swing that ANCHORS the current leg (the low/high that preceded the first BOS of this
// run), not the most recent pivot. Continuation BOS events do not move that anchor.
// Minor pivot breaks that don't reach the anchor are reported separately as "internal" —
// informational only, never gates a trade on their own.
function detectStructureV2(closedCandles, width = 2) {
  const out = {
    trend: 'NONE', event: 'NONE', eventIndex: null, brokenLevel: null,
    legOriginLow: null, legOriginHigh: null,
    internalEvent: null, internalEventIndex: null, internalBrokenLevel: null,
  };
  if (!closedCandles || closedCandles.length < width * 2 + 3) return out;

  const { highs, lows } = findPivots(closedCandles, width);
  if (!highs.length || !lows.length) return out;

  let hi = 0, lo = 0;
  let activeHigh = null, activeLow = null;
  let trend = 'NONE';
  let legOriginLow = null, legOriginHigh = null;
  let firedHighRef = null, firedLowRef = null; // stops an event re-firing every bar it stays true
  let lastEvent = null, lastInternal = null;
  const lastBar = closedCandles.length - 1;

  for (let i = 0; i <= lastBar; i++) {
    // Reveal a pivot only once it is actually confirmable as-of bar i (needs `width` bars
    // after it) — avoids look-ahead bias in this offline/causal simulation.
    while (hi < highs.length && highs[hi].i + width <= i) { activeHigh = highs[hi]; hi++; }
    while (lo < lows.length && lows[lo].i + width <= i) { activeLow = lows[lo]; lo++; }

    const close = Number(closedCandles[i].close);

    if (trend === 'UP') {
      if (legOriginLow && close < legOriginLow.price) {
        legOriginHigh = activeHigh;
        lastEvent = { event: 'CHOCH_DOWN', eventIndex: i, brokenLevel: legOriginLow.price };
        trend = 'DOWN'; legOriginLow = null; firedHighRef = null;
      } else if (activeHigh && close > activeHigh.price && activeHigh !== firedHighRef) {
        lastEvent = { event: 'BOS_UP', eventIndex: i, brokenLevel: activeHigh.price };
        firedHighRef = activeHigh;
      } else if (activeLow && close < activeLow.price && activeLow !== legOriginLow && activeLow !== firedLowRef) {
        lastInternal = { event: 'INTERNAL_DOWN', eventIndex: i, brokenLevel: activeLow.price };
        firedLowRef = activeLow;
      }
    } else if (trend === 'DOWN') {
      if (legOriginHigh && close > legOriginHigh.price) {
        legOriginLow = activeLow;
        lastEvent = { event: 'CHOCH_UP', eventIndex: i, brokenLevel: legOriginHigh.price };
        trend = 'UP'; legOriginHigh = null; firedLowRef = null;
      } else if (activeLow && close < activeLow.price && activeLow !== firedLowRef) {
        lastEvent = { event: 'BOS_DOWN', eventIndex: i, brokenLevel: activeLow.price };
        firedLowRef = activeLow;
      } else if (activeHigh && close > activeHigh.price && activeHigh !== legOriginHigh && activeHigh !== firedHighRef) {
        lastInternal = { event: 'INTERNAL_UP', eventIndex: i, brokenLevel: activeHigh.price };
        firedHighRef = activeHigh;
      }
    } else {
      if (activeHigh && close > activeHigh.price) {
        legOriginLow = activeLow;
        lastEvent = { event: 'BOS_UP', eventIndex: i, brokenLevel: activeHigh.price };
        trend = 'UP'; firedHighRef = activeHigh;
      } else if (activeLow && close < activeLow.price) {
        legOriginHigh = activeHigh;
        lastEvent = { event: 'BOS_DOWN', eventIndex: i, brokenLevel: activeLow.price };
        trend = 'DOWN'; firedLowRef = activeLow;
      }
    }
  }

  out.trend = trend;
  out.legOriginLow = legOriginLow;
  out.legOriginHigh = legOriginHigh;
  if (lastEvent && lastBar - lastEvent.eventIndex <= 30) {
    out.event = lastEvent.event; out.eventIndex = lastEvent.eventIndex; out.brokenLevel = lastEvent.brokenLevel;
  }
  if (lastInternal && lastBar - lastInternal.eventIndex <= 30) {
    out.internalEvent = lastInternal.event; out.internalEventIndex = lastInternal.eventIndex;
    out.internalBrokenLevel = lastInternal.brokenLevel;
  }
  return out;
}

module.exports = { detectStructureV2 };
