'use strict';

/**
 * Orayan II — Single structure engine (clean)
 *
 * - Closed bars only (forming candle never used for structure)
 * - eventIndex = break candle, not pivot
 * - Single path: BOS/CHoCH → retest limit in break direction
 * - Strong-break filter measures the BREAK candle (causal)
 * - Failed break: price already closed back through level → reject
 * - Simple score (no inverted regime tricks; alignment is soft info only)
 */

const { ema, rsi, atr, volumeRatio } = require('./indicators');
const { detectStructure, keyLevels, findPivots } = require('./structure');
const { num, clamp, uid } = require('./util');
const bosTracker = require('./bosTracker');
const journal = require('./journal');
const { detectStructureV2 } = require('./structureV2');

/** See signals_trend.js — same validated curve, shared shape for both engines. */
function smoothPeak(x, lo, hi, peakLo, peakHi) {
  if (!(x > lo) || x >= hi) return 0;
  if (x >= peakLo && x <= peakHi) return 1;
  if (x < peakLo) return (x - lo) / (peakLo - lo);
  return (hi - x) / (hi - peakHi);
}

function detectBtcRegime(candles) {
  if (!candles || candles.length < 60) return { regime: 'UNKNOWN', strength: 0 };
  // marketData.getCandles() has already dropped the forming bar; do not slice again.
  const closed = candles;
  const closes = closed.map((c) => c.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const price = closes[closes.length - 1];
  const a = atr(closed, 14);
  const atrPct = price ? (a / price) * 100 : 0;
  const above20 = price > e20;
  const above50 = price > e50;
  const stacked = e20 > e50;
  const e20prev = ema(closes.slice(0, -10), 20);
  const slopePct = e20prev ? ((e20 - e20prev) / e20prev) * 100 : 0;
  const trending = Math.abs(slopePct) > 0.25;

  let regime;
  if (above20 && above50 && stacked) regime = trending ? 'BULL_TREND' : 'BULL_RANGE';
  else if (!above20 && !above50 && !stacked) regime = trending ? 'BEAR_TREND' : 'BEAR_RANGE';
  else regime = 'CHOP';

  return { regime, strength: clamp(Math.abs(slopePct) * 40, 0, 100), atrPct, price };
}

/*
 * Regime permission — the single canonical implementation. signals_trend.js imports this one;
 * do not reintroduce a second copy.
 *
 * BEAR_RANGE is blocked outright, not merely restricted to shorts. This is the only result in
 * the project that has survived every validation gate: live t = -4.89, independently reproduced
 * in backtest. Shorts taken in BEAR_RANGE lost money consistently and the effect did not come
 * from a handful of pairs. Treat this as settled unless new evidence overturns it.
 */
function regimeAllows(regime, side) {
  switch (regime) {
    case 'BULL_TREND':
    case 'BULL_RANGE':
      return side === 'BUY';
    case 'BEAR_TREND':
      return side === 'SELL';
    case 'BEAR_RANGE':
      return false; // validated block — see note above
    case 'CHOP':
      return false;
    default:
      return true;
  }
}

/**
 * Strong break = measured on the BREAK candle (eventIndex), not the pivot.
 * Prior body average uses only bars BEFORE the break.
 */
function isStrongBreak(closedCandles, eventIndex, side, atrVal) {
  if (eventIndex == null || eventIndex < 1 || eventIndex >= closedCandles.length) return false;
  const br = closedCandles[eventIndex];
  const body = Math.abs(num(br.close) - num(br.open));
  const range = num(br.high) - num(br.low);
  if (range <= 0 || !atrVal) return false;

  const start = Math.max(0, eventIndex - 20);
  const prior = closedCandles.slice(start, eventIndex);
  if (prior.length < 5) return false;

  let bodySum = 0;
  for (const c of prior) bodySum += Math.abs(num(c.close) - num(c.open));
  const avgBody = bodySum / prior.length;

  const strongBody = body > avgBody * 1.3;
  const strongRange = range > atrVal * 0.8;
  const closedDir = side === 'BUY'
    ? num(br.close) > num(br.open)
    : num(br.close) < num(br.open);

  return strongBody && strongRange && closedDir;
}

/**
 * Has price already closed back through the broken level after the break?
 * Uses only closed bars after eventIndex.
 */
function hasAlreadyFailed(closedCandles, eventIndex, brokenLevel, side) {
  if (eventIndex == null || brokenLevel == null) return true;
  const after = closedCandles.slice(eventIndex + 1);
  if (!after.length) return false;

  // Check EVERY closed bar since the break, not a trailing window.
  //
  // This previously looked at only the last 8 bars. Combined with the 30-bar staleness cutoff in
  // structure.js, that left a hole: a break that failed at bar 3 and then recovered by bar 25
  // passed the filter cleanly. It answered "is this break failed right now", when the validated
  // fake-BOS finding is about whether the break EVER reverted through the level. A break that
  // has already been rejected once is exactly the population the finding says to avoid.
  for (const c of after) {
    if (side === 'BUY' && num(c.close) < brokenLevel) return true;
    if (side === 'SELL' && num(c.close) > brokenLevel) return true;
  }
  return false;
}

/*
 * SCORING — multiplicative, BASE 50. Same architecture and same scale as signals_trend.js, so
 * one SCORE_BAND means the same thing for both engines. See the long note in that file for why
 * the additive version was replaced and why the U-shape requires multiplicative stacking.
 */
function scoreStructure({ side, closed, struct, levels, price, entry, sl, tp, strong, btcRegime }) {
  const closes = closed.map((c) => c.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const r = rsi(closes, 14);
  const vr = volumeRatio(closed, 20);
  const a = atr(closed, 14);
  const isBuy = side === 'BUY';
  const components = {};
  const BASE = 50;

  // FACTOR 1 — EMA agreement (0.80 .. 1.30). Three independent checks, each worth a third.
  let agree = 0;
  if (isBuy) {
    if (price > e20) agree++;
    if (price > e50) agree++;
    if (e20 > e50) agree++;
  } else {
    if (price < e20) agree++;
    if (price < e50) agree++;
    if (e20 < e50) agree++;
  }
  const trendMult = 0.80 + 0.50 * (agree / 3);
  components.trendMult = Number(trendMult.toFixed(4));
  components.emaAgree = agree;

  // FACTOR 2 — break quality (0.70 .. 1.25). BOS beats CHoCH, displacement beats a drift-through,
  // and a level that has been tested repeatedly beats one that has not.
  let q = 0.70;
  if (['BOS_UP', 'BOS_DOWN'].includes(struct.event)) q += 0.20;
  else if (['CHOCH_UP', 'CHOCH_DOWN'].includes(struct.event)) q += 0.12;
  if (strong) q += 0.20;
  const anchor = isBuy ? levels.support : levels.resistance;
  if (anchor && anchor.touches >= 2) q += 0.10;
  const breakMult = clamp(q, 0.70, 1.25);
  components.breakMult = Number(breakMult.toFixed(4));

  // FACTOR 3 — location (0.45 .. 1.15), distance from the retest level in ATR units. Same span
  // as the trend engine's entry factor: far from the level is a chase, on top of it is noise.
  const dAtr = (a > 0 && struct.brokenLevel != null)
    ? Math.abs(price - struct.brokenLevel) / a
    : 0;
  const locPeak = smoothPeak(dAtr, 0.0, 2.2, 0.10, 0.80);
  const locMult = 0.45 + 0.70 * locPeak;
  components.locMult = Number(locMult.toFixed(4));
  components.locDistAtr = Number(dAtr.toFixed(4));

  // FACTOR 4 — regime alignment scaled by strength (0.30 .. 1.20). Identical to the trend engine.
  const regimeStrength = clamp(num(btcRegime && btcRegime.strength) / 100, 0, 1);
  const aligned = regimeAllows(btcRegime.regime, side);
  const regimeMult = aligned
    ? 1.00 + 0.20 * regimeStrength
    : clamp(0.85 - 0.50 * regimeStrength, 0.30, 0.95);
  components.regimeMult = Number(regimeMult.toFixed(4));

  // FACTOR 5 — momentum (0.85 .. 1.10). Weakest factor, same as the trend engine.
  let momMult = 1.00;
  if (r != null) {
    if (isBuy && r >= 40 && r <= 65) momMult = 1.10;
    else if (!isBuy && r >= 35 && r <= 60) momMult = 1.10;
    else if (isBuy && r > 75) momMult = 0.85;
    else if (!isBuy && r < 25) momMult = 0.85;
  }
  components.momMult = Number(momMult.toFixed(4));

  // rrPts removed — RR is fixed at structureTargetR by construction, so it was a constant.
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  const rr = risk ? reward / risk : 0;

  components.rsi = r;
  components.volumeRatio = vr;
  components.regimeAligned = aligned;
  components.base = BASE;

  const score = Math.round(clamp(BASE * trendMult * breakMult * locMult * regimeMult * momMult, 0, 100));
  return { score, components, rr, aligned };
}

function buildSignal({ symbol, candles, ticker, btcRegime, settings }) {
  if (!candles || candles.length < 90) return { ok: false, reason: 'NOT_ENOUGH_HISTORY' };

  // Structure runs on closed bars only. marketData.getCandles() already removes the forming
  // candle for every caller (see the comment there), so slicing again here dropped a second,
  // genuinely-closed bar — leaving STRUCTURE permanently one bar staler than TREND. Not a
  // look-ahead bug, it erred safe, but it meant the two engines were never judging the same
  // data, which is another confound on any A/B between them.
  const closed = candles;
  if (closed.length < 80) return { ok: false, reason: 'NOT_ENOUGH_CLOSED' };

  const price = num(ticker?.markPrice) || num(candles[candles.length - 1].close);
  if (!price) return { ok: false, reason: 'NO_PRICE' };

  const a = atr(closed, 14);
  if (!a || a <= 0) return { ok: false, reason: 'NO_ATR' };
  const atrPct = (a / price) * 100;

  const pivotWidth = Math.max(2, Math.round(num(settings.pivotWidth, 2)));
  const struct = detectStructure(closed, pivotWidth);

  // SHADOW MODE ONLY — logging for comparison, does not affect struct/side/gating below.
  // Protected-swing CHoCH candidate (see structureV2.js). Once enough live data has
  // accumulated, pre-register a criterion for whether this outperforms the current
  // undifferentiated CHoCH before ever touching the gating logic above.
  try {
    const structV2 = detectStructureV2(closed, pivotWidth);
    if (structV2.event !== 'NONE') {
      const v2Side = ['BOS_UP', 'CHOCH_UP'].includes(structV2.event) ? 'BUY' : 'SELL';
      journal.recordBosEvent({
        key: `v2:${symbol}:${structV2.eventIndex}:${structV2.event}`,
        symbol,
        side: v2Side,
        level: structV2.brokenLevel,
        breakTs: closed[structV2.eventIndex]?.timestamp ?? null,
        breakIso: closed[structV2.eventIndex]?.timestampIso ?? null,
        outcome: structV2.event,
        barsChecked: null,
      });
    }
  } catch (err) {
    // Shadow logging must never break live signal generation.
    journal.recordBosEvent({
      key: `v2:${symbol}:error`,
      symbol,
      side: null,
      level: null,
      breakTs: Date.now(),
      breakIso: new Date().toISOString(),
      outcome: `V2_ERROR:${err.message}`,
      barsChecked: null,
    });
  }

  // Resolve any of this symbol's still-pending break outcomes against fresh candles —
  // do this every scan regardless of whether today's struct event even exists, so
  // resolution isn't gated on a new break happening. See bosTracker.js.
  for (const resolvedEv of bosTracker.resolvePendingForSymbol(symbol, closed)) {
    journal.recordBosEvent(resolvedEv);
  }

  if (!['BOS_UP', 'BOS_DOWN', 'CHOCH_UP', 'CHOCH_DOWN'].includes(struct.event)) {
    return { ok: false, reason: 'NO_STRUCTURE_EVENT' };
  }

  const side = ['BOS_UP', 'CHOCH_UP'].includes(struct.event) ? 'BUY' : 'SELL';
  const brokenLevel = struct.brokenLevel;
  if (brokenLevel == null || struct.eventIndex == null) {
    return { ok: false, reason: 'NO_BREAK_LEVEL' };
  }

  // Record this break for forward validation — BEFORE any WEAK_BREAK/FAILED_BREAK
  // rejection below, so the fake-BOS filter can be validated on the full population
  // of detected breaks, not just the ones that survived to become a trade.
  const bosEv = bosTracker.trackBreak({
    symbol,
    side,
    eventIndex: struct.eventIndex,
    brokenLevel,
    closedCandles: closed,
    timeframe: settings.timeframe,
  });
  if (bosEv) journal.recordBosEvent(bosEv);

  // Optional: only BOS (skip CHoCH) for stricter mode
  if (settings.bosOnly === true && !struct.event.startsWith('BOS')) {
    return { ok: false, reason: 'CHOCH_SKIPPED' };
  }

  // Strong break on the BREAK candle
  const requireStrong = settings.requireStrongBreak !== false;
  const strong = isStrongBreak(closed, struct.eventIndex, side, a);
  if (requireStrong && !strong) {
    return { ok: false, reason: 'WEAK_BREAK' };
  }

  // Reject if already failed
  if (settings.rejectFailedBreak !== false) {
    if (hasAlreadyFailed(closed, struct.eventIndex, brokenLevel, side)) {
      return { ok: false, reason: 'FAILED_BREAK' };
    }
  }

  // ATR-normalized cluster tolerance for touches
  const tolPct = Math.max(0.12, Math.min(0.45, atrPct * 0.35));
  const levels = keyLevels(closed, price, pivotWidth, tolPct);

  // Touches on the level the break actually went through. Enforced, not advisory — this block
  // was previously empty, so the UI presented an active-looking control that did nothing.
  //
  // Counted directly from the pivots rather than read off keyLevels(). Two reasons that matters:
  //
  //  1. keyLevels() splits clusters by CURRENT price. Once a high has been broken upward, price
  //     sits above it, so the broken level lands among the supports and levels.resistance is the
  //     next untouched level beyond it — the wrong level entirely.
  //  2. The clustering tolerance and the "is this pivot the same level" tolerance are not the
  //     same question. tolPct is deliberately tight (0.12–0.45%) to keep distinct levels apart;
  //     reusing it here matched nothing at all, so the gate silently never fired.
  //
  // A pivot counts as a touch of the broken level if it sits within half an ATR of it, which
  // scales with the instrument instead of assuming a fixed percentage.
  const minTouches = Math.max(1, num(settings.minLevelTouches, 1));
  if (minTouches > 1) {
    const touchBand = Math.max(a * 0.5, brokenLevel * 0.0015);
    const pv = findPivots(closed, pivotWidth);
    // A broken high was tested as resistance, a broken low as support.
    const relevant = side === 'BUY' ? pv.highs : pv.lows;
    const touches = relevant.filter((p) => Math.abs(p.price - brokenLevel) <= touchBand).length;
    if (touches < minTouches) {
      return { ok: false, reason: 'TOO_FEW_TOUCHES' };
    }
  }

  const minSlPct = num(settings.minSlDistPct, 3.0);
  const maxSlPct = num(settings.maxSlDistPct, 5.0);
  const minSlAbs = price * (minSlPct / 100);
  const cushion = Math.max(a * 0.55, minSlAbs * 0.85);

  let entry;
  let sl;
  let tp;

  if (side === 'BUY') {
    // Retest the broken level from above
    entry = Math.min(price, brokenLevel + a * 0.15);
    if (entry < brokenLevel) entry = brokenLevel + a * 0.05;
    sl = brokenLevel - cushion;
    if ((entry - sl) / entry * 100 < minSlPct) sl = entry * (1 - minSlPct / 100);
    if ((entry - sl) / entry * 100 > maxSlPct) sl = entry * (1 - maxSlPct / 100);

    const res = levels.resistance?.price;
    const risk = entry - sl;
    if (res != null && res > entry) {
      tp = res - a * 0.1;
      // if RR insane, fall back to R-multiple
      if ((tp - entry) / risk > 5 || tp <= entry) tp = entry + risk * num(settings.structureTargetR, 2.0);
    } else {
      tp = entry + risk * num(settings.structureTargetR, 2.0);
    }
  } else {
    entry = Math.max(price, brokenLevel - a * 0.15);
    if (entry > brokenLevel) entry = brokenLevel - a * 0.05;
    sl = brokenLevel + cushion;
    if ((sl - entry) / entry * 100 < minSlPct) sl = entry * (1 + minSlPct / 100);
    if ((sl - entry) / entry * 100 > maxSlPct) sl = entry * (1 + maxSlPct / 100);

    const sup = levels.support?.price;
    const risk = sl - entry;
    if (sup != null && sup < entry) {
      tp = sup + a * 0.1;
      if ((entry - tp) / risk > 5 || tp >= entry) tp = entry - risk * num(settings.structureTargetR, 2.0);
    } else {
      tp = entry - risk * num(settings.structureTargetR, 2.0);
    }
  }

  if (!(entry > 0) || !(sl > 0) || !(tp > 0)) return { ok: false, reason: 'INVALID_LEVELS' };
  if (side === 'BUY' && !(sl < entry && tp > entry)) return { ok: false, reason: 'INVERTED_PLAN' };
  if (side === 'SELL' && !(sl > entry && tp < entry)) return { ok: false, reason: 'INVERTED_PLAN' };

  // Price must still be on the break side of the level (not already deep through wrong way)
  if (side === 'BUY' && price < brokenLevel * 0.998) return { ok: false, reason: 'PRICE_WRONG_SIDE' };
  if (side === 'SELL' && price > brokenLevel * 1.002) return { ok: false, reason: 'PRICE_WRONG_SIDE' };

  const scored = scoreStructure({
    side,
    closed,
    struct,
    levels,
    price,
    entry,
    sl,
    tp,
    strong,
    btcRegime: btcRegime || { regime: 'UNKNOWN' },
  });

  const slDistPct = (Math.abs(entry - sl) / entry) * 100;

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
      rr: scored.rr,
      score: scored.score,
      components: scored.components,
      structureEvent: struct.event,
      structureTrend: struct.trend,
      entryPath: 'STRUCTURE_RETEST',
      entryPathReason: strong ? 'STRONG_BREAK_RETEST' : 'BREAK_RETEST',
      breakSide: side,
      retestLevel: brokenLevel,
      levels: {
        support: levels.support?.price ?? null,
        resistance: levels.resistance?.price ?? null,
        supportTouches: levels.support?.touches ?? 0,
        resistanceTouches: levels.resistance?.touches ?? 0,
        brokenLevel,
      },
      market: {
        turnover24h: num(ticker?.turnover24h),
        spreadPct: ticker?.spreadPct ?? null,
        fundingRate: num(ticker?.fundingRate),
        volRatio: scored.components.volumeRatio,
      },
      btcRegime: (btcRegime && btcRegime.regime) || 'UNKNOWN',
      regimeAligned: scored.aligned,
      timeframe: settings.timeframe,
      quality: {
        strongBreak: strong,
        eventIndex: struct.eventIndex,
        atrPct,
        path: 'STRUCTURE_RETEST',
      },
    },
  };
}

module.exports = {
  buildSignal,
  detectBtcRegime,
  regimeAllows,
  isStrongBreak,
  hasAlreadyFailed,
};
