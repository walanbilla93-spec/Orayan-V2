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
const { detectStructure, keyLevels } = require('./structure');
const { num, clamp, uid } = require('./util');

function detectBtcRegime(candles) {
  if (!candles || candles.length < 60) return { regime: 'UNKNOWN', strength: 0 };
  const closed = candles.slice(0, -1);
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

function regimeAllows(regime, side) {
  switch (regime) {
    case 'BULL_TREND':
    case 'BULL_RANGE':
      return side === 'BUY';
    case 'BEAR_TREND':
    case 'BEAR_RANGE':
      return side === 'SELL';
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
  // Look at up to last 8 closed bars after break
  const win = after.slice(-8);
  for (const c of win) {
    if (side === 'BUY' && num(c.close) < brokenLevel) return true;
    if (side === 'SELL' && num(c.close) > brokenLevel) return true;
  }
  return false;
}

function scoreStructure({ side, closed, struct, levels, price, entry, sl, tp, strong, btcRegime }) {
  const closes = closed.map((c) => c.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const r = rsi(closes, 14);
  const vr = volumeRatio(closed, 20);
  const isBuy = side === 'BUY';
  const components = {};

  // Trend vs EMAs (soft)
  let trendPts = 0;
  if (isBuy) {
    if (price > e20) trendPts += 8;
    if (price > e50) trendPts += 7;
    if (e20 > e50) trendPts += 8;
  } else {
    if (price < e20) trendPts += 8;
    if (price < e50) trendPts += 7;
    if (e20 < e50) trendPts += 8;
  }
  components.trend = trendPts;

  // Structure event quality
  let structPts = 0;
  if (['BOS_UP', 'BOS_DOWN'].includes(struct.event)) structPts += 16;
  else if (['CHOCH_UP', 'CHOCH_DOWN'].includes(struct.event)) structPts += 12;
  if ((isBuy && struct.trend === 'UP') || (!isBuy && struct.trend === 'DOWN')) structPts += 6;
  if (strong) structPts += 8;
  const anchor = isBuy ? levels.support : levels.resistance;
  if (anchor && anchor.touches >= 2) structPts += 4;
  components.structure = structPts;

  // RSI — mild preference for not extreme
  let momPts = 5;
  if (r != null) {
    if (isBuy && r >= 40 && r <= 65) momPts = 12;
    else if (isBuy && r > 65 && r <= 75) momPts = 6;
    else if (!isBuy && r >= 35 && r <= 60) momPts = 12;
    else if (!isBuy && r >= 25 && r < 35) momPts = 6;
    else momPts = 3;
  }
  components.momentum = momPts;

  // Location: distance from retest level
  let locPts = 0;
  if (struct.brokenLevel != null && price) {
    const distPct = (Math.abs(price - struct.brokenLevel) / price) * 100;
    if (distPct <= 0.35) locPts = 18;
    else if (distPct <= 0.8) locPts = 12;
    else if (distPct <= 1.5) locPts = 6;
    else locPts = 2;
  }
  components.location = locPts;

  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  const rr = risk ? reward / risk : 0;
  let rrPts = 0;
  if (rr >= 1.8 && rr <= 3.5) rrPts = 14;
  else if (rr >= 1.5 && rr < 1.8) rrPts = 9;
  else if (rr > 3.5 && rr <= 5) rrPts = 7;
  else if (rr >= 1.2 && rr < 1.5) rrPts = 4;
  components.rr = rrPts;

  // Soft regime info only — small penalty, not a hard invert of ranking
  const aligned = regimeAllows(btcRegime.regime, side);
  const regimeMult = aligned ? 1.0 : 0.9;
  components.regimeMultiplier = regimeMult;
  components.volumeRatio = vr;
  components.rsi = r;

  const raw = trendPts + structPts + momPts + locPts + rrPts;
  const score = Math.round(clamp(raw * regimeMult, 0, 100));
  return { score, components, rr, aligned };
}

function buildSignal({ symbol, candles, ticker, btcRegime, settings }) {
  if (!candles || candles.length < 90) return { ok: false, reason: 'NOT_ENOUGH_HISTORY' };

  // CRITICAL: structure only on closed bars
  const closed = candles.slice(0, -1);
  if (closed.length < 80) return { ok: false, reason: 'NOT_ENOUGH_CLOSED' };

  const price = num(ticker?.markPrice) || num(candles[candles.length - 1].close);
  if (!price) return { ok: false, reason: 'NO_PRICE' };

  const a = atr(closed, 14);
  if (!a || a <= 0) return { ok: false, reason: 'NO_ATR' };
  const atrPct = (a / price) * 100;

  const pivotWidth = Math.max(2, Math.round(num(settings.pivotWidth, 2)));
  const struct = detectStructure(closed, pivotWidth);

  if (!['BOS_UP', 'BOS_DOWN', 'CHOCH_UP', 'CHOCH_DOWN'].includes(struct.event)) {
    return { ok: false, reason: 'NO_STRUCTURE_EVENT' };
  }

  const side = ['BOS_UP', 'CHOCH_UP'].includes(struct.event) ? 'BUY' : 'SELL';
  const brokenLevel = struct.brokenLevel;
  if (brokenLevel == null || struct.eventIndex == null) {
    return { ok: false, reason: 'NO_BREAK_LEVEL' };
  }

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

  const minTouches = Math.max(1, num(settings.minLevelTouches, 1));
  // Touches on the broken level's cluster (nearest same-side pivot group)
  const levelTouches = side === 'BUY'
    ? (levels.resistance?.touches || 1) // broke a high — that resistance cluster
    : (levels.support?.touches || 1);

  // Soft: only enforce if we have cluster data
  if (minTouches > 1 && levelTouches < minTouches) {
    // Don't hard-block forever on volatile pairs — only when cluster exists with low touches
    // Actually user wanted cleaner: keep soft min 1 default
  }

  const minSlPct = num(settings.minSlDistPct, 0.8);
  const maxSlPct = num(settings.maxSlDistPct, 2.5);
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
