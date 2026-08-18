'use strict';

const { ema, rsi, atr, volumeRatio } = require('./indicators');
const { detectStructure, keyLevels } = require('./structure');
const { num, clamp, uid } = require('./util');

/**
 * BTC regime.
 */
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

  return {
    regime,
    strength: clamp(Math.abs(slopePct) * 40, 0, 100),
    atrPct,
    price,
  };
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

function scoreSetup({ side, candles, struct, levels, price, entry, sl, tp, btcRegime }) {
  const closes = candles.map((c) => c.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const r = rsi(closes, 14);
  const vr = volumeRatio(candles, 20);
  const isBuy = side === 'BUY';

  const components = {};

  let trendPts = 0;
  if (isBuy) {
    if (price > e20) trendPts += 8;
    if (price > e50) trendPts += 7;
    if (e20 > e50) trendPts += 10;
  } else {
    if (price < e20) trendPts += 8;
    if (price < e50) trendPts += 7;
    if (e20 < e50) trendPts += 10;
  }
  components.trend = trendPts;

  let structPts = 0;
  const wantEvent = isBuy ? ['BOS_UP', 'CHOCH_UP'] : ['BOS_DOWN', 'CHOCH_DOWN'];
  if (wantEvent.includes(struct.event)) structPts += 14;
  if ((isBuy && struct.trend === 'UP') || (!isBuy && struct.trend === 'DOWN')) structPts += 7;
  const anchor = isBuy ? levels.support : levels.resistance;
  if (anchor && anchor.touches >= 2) structPts += 4;
  components.structure = structPts;

  let momPts = 0;
  if (r != null) {
    if (isBuy) {
      if (r >= 45 && r <= 65) momPts = 15;
      else if (r > 65 && r <= 72) momPts = 8;
      else if (r >= 35 && r < 45) momPts = 10;
      else momPts = 2;
    } else {
      if (r >= 35 && r <= 55) momPts = 15;
      else if (r >= 28 && r < 35) momPts = 8;
      else if (r > 55 && r <= 65) momPts = 10;
      else momPts = 2;
    }
  }
  components.momentum = momPts;

  let locPts = 0;
  if (anchor && price) {
    const distPct = (Math.abs(price - anchor.price) / price) * 100;
    if (distPct <= 0.25) locPts = 20;
    else if (distPct <= 0.6) locPts = 15;
    else if (distPct <= 1.2) locPts = 9;
    else if (distPct <= 2.5) locPts = 4;
  }
  components.location = locPts;

  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  const rr = risk ? reward / risk : 0;
  let rrPts = 0;
  if (rr >= 2 && rr <= 3.5) rrPts = 15;
  else if (rr > 3.5 && rr <= 5) rrPts = 10;
  else if (rr >= 1.5 && rr < 2) rrPts = 6;
  else if (rr > 5) rrPts = 4;
  components.rr = rrPts;

  const aligned = regimeAllows(btcRegime.regime, side);
  const regimeMult = aligned ? 1.0 : 0.75;
  components.regimeMultiplier = regimeMult;
  components.volumeRatio = vr;
  components.rsi = r;

  const raw = trendPts + structPts + momPts + locPts + rrPts;
  const score = Math.round(clamp(raw * regimeMult, 0, 100));

  return { score, components, rr, aligned };
}

function isStrongBreak(candles, eventIndex, side, atrVal) {
  if (eventIndex == null || eventIndex < 1 || eventIndex >= candles.length) return false;
  const breakCandle = candles[eventIndex];
  const body = Math.abs(num(breakCandle.close) - num(breakCandle.open));
  const range = num(breakCandle.high) - num(breakCandle.low);
  if (range <= 0) return false;

  const start = Math.max(0, eventIndex - 20);
  const prior = candles.slice(start, eventIndex);
  if (prior.length < 5) return false;

  let bodySum = 0;
  for (const c of prior) bodySum += Math.abs(num(c.close) - num(c.open));
  const avgBody = bodySum / prior.length;

  const strongBody = body > avgBody * 1.35;
  const strongRange = range > atrVal * 0.85;
  const closedInDirection = side === 'BUY'
    ? num(breakCandle.close) > num(breakCandle.open)
    : num(breakCandle.close) < num(breakCandle.open);

  return strongBody && strongRange && closedInDirection;
}

function hasAlreadyFailed(candles, struct, side) {
  const brokenLevel = side === 'BUY' ? struct.lastHigh?.price : struct.lastLow?.price;
  if (brokenLevel == null || struct.eventIndex == null) return true;

  const afterBreak = candles.slice(struct.eventIndex + 1, -1);
  if (afterBreak.length === 0) return false;

  const lookback = afterBreak.slice(-5);
  for (const c of lookback) {
    if (side === 'BUY' && num(c.close) < brokenLevel) return true;
    if (side === 'SELL' && num(c.close) > brokenLevel) return true;
  }
  return false;
}

/**
 * Dual-path decision at the retest level (causal).
 *
 * breakSide = direction of the original BOS/CHoCH
 * level     = the structural level being retested
 *
 * Returns:
 *   { path: 'CONTINUATION', side }  — retest held / rejected in favour of the break
 *   { path: 'REVERSAL', side }      — retest failed (closed through the level)
 *   null                            — no clear decision yet
 */
function decideRetestPath(candles, breakSide, level, atrVal) {
  if (!candles || candles.length < 5 || level == null || !atrVal) return null;

  // Use only closed candles (exclude the forming bar)
  const closed = candles.slice(0, -1);
  if (closed.length < 3) return null;

  const zone = Math.max(atrVal * 0.35, level * 0.0015); // proximity zone
  const recent = closed.slice(-8);

  // Did price actually interact with the level recently?
  let touched = false;
  for (const c of recent) {
    if (num(c.low) <= level + zone && num(c.high) >= level - zone) {
      touched = true;
      break;
    }
  }
  if (!touched) return null;

  const last = recent[recent.length - 1];
  const prev = recent[recent.length - 2];
  const lastClose = num(last.close);
  const lastOpen = num(last.open);
  const lastHigh = num(last.high);
  const lastLow = num(last.low);
  const body = Math.abs(lastClose - lastOpen);
  const range = lastHigh - lastLow || 1e-12;
  const upperWick = lastHigh - Math.max(lastClose, lastOpen);
  const lowerWick = Math.min(lastClose, lastOpen) - lastLow;

  // ── REVERSAL path: close through the level against the break ──────────────
  // Original break was UP → failed retest = close back below level
  // Original break was DOWN → failed retest = close back above level
  if (breakSide === 'BUY' && lastClose < level - zone * 0.25) {
    return { path: 'REVERSAL', side: 'SELL', reason: 'CLOSED_THROUGH_SUPPORT' };
  }
  if (breakSide === 'SELL' && lastClose > level + zone * 0.25) {
    return { path: 'REVERSAL', side: 'BUY', reason: 'CLOSED_THROUGH_RESISTANCE' };
  }

  // ── CONTINUATION path: rejection at the level in break direction ──────────
  // BUY break: bullish rejection (lower wick, close back above level)
  if (breakSide === 'BUY') {
    const nearLevel = lastLow <= level + zone && lastLow >= level - zone * 2;
    const rejected = lowerWick > body * 0.6 && lastClose > level - zone * 0.5;
    const closedUp = lastClose >= lastOpen;
    if (nearLevel && rejected && (closedUp || lastClose > level)) {
      return { path: 'CONTINUATION', side: 'BUY', reason: 'BULLISH_REJECTION' };
    }
  }

  // SELL break: bearish rejection (upper wick, close back below level)
  if (breakSide === 'SELL') {
    const nearLevel = lastHigh >= level - zone && lastHigh <= level + zone * 2;
    const rejected = upperWick > body * 0.6 && lastClose < level + zone * 0.5;
    const closedDown = lastClose <= lastOpen;
    if (nearLevel && rejected && (closedDown || lastClose < level)) {
      return { path: 'CONTINUATION', side: 'SELL', reason: 'BEARISH_REJECTION' };
    }
  }

  // Also allow a slightly slower confirmation: previous bar touched, current bar closes in break direction away from level
  if (breakSide === 'BUY') {
    const prevTouched = num(prev.low) <= level + zone && num(prev.high) >= level - zone;
    if (prevTouched && lastClose > level + zone * 0.5 && lastClose > lastOpen) {
      return { path: 'CONTINUATION', side: 'BUY', reason: 'BOUNCE_CONFIRM' };
    }
  }
  if (breakSide === 'SELL') {
    const prevTouched = num(prev.high) >= level - zone && num(prev.low) <= level + zone;
    if (prevTouched && lastClose < level - zone * 0.5 && lastClose < lastOpen) {
      return { path: 'CONTINUATION', side: 'SELL', reason: 'REJECT_CONFIRM' };
    }
  }

  return null;
}

function buildPlan(side, price, support, resistance, a, minSlPct) {
  const isBuy = side === 'BUY';
  const minSlAbs = price * (minSlPct / 100);
  const atrCushion = a * 0.5;
  const cushion = Math.max(atrCushion, minSlAbs * 0.85);

  let entry;
  let sl;
  let tp;

  if (isBuy) {
    if (support == null) return null;
    entry = Math.min(price, support + a * 0.25);
    // For reversal entries price may already be through — use marketable limit near price
    if (price < support - a * 0.1) entry = price; // already through, enter near market
    sl = Math.min(support, entry) - cushion;
    if ((entry - sl) / entry * 100 < minSlPct) sl = entry * (1 - minSlPct / 100);
    tp = resistance != null && resistance > entry
      ? resistance - a * 0.1
      : entry + Math.abs(entry - sl) * 2.5;
  } else {
    if (resistance == null) return null;
    entry = Math.max(price, resistance - a * 0.25);
    if (price > resistance + a * 0.1) entry = price;
    sl = Math.max(resistance, entry) + cushion;
    if ((sl - entry) / entry * 100 < minSlPct) sl = entry * (1 + minSlPct / 100);
    tp = support != null && support < entry
      ? support + a * 0.1
      : entry - Math.abs(entry - sl) * 2.5;
  }

  if (!(entry > 0) || !(sl > 0) || !(tp > 0)) return null;
  if (isBuy && !(sl < entry && tp > entry)) return null;
  if (!isBuy && !(sl > entry && tp < entry)) return null;

  return { entry, sl, tp };
}

/**
 * Build a trade plan.
 *
 * entryMode:
 *   'CONTINUATION'   — original behaviour (retest with the break)
 *   'RETEST_OR_FADE' — if retest confirms → continuation; if retest fails → reversal
 */
function buildSignal({ symbol, candles, ticker, btcRegime, settings }) {
  if (!candles || candles.length < 80) return { ok: false, reason: 'NOT_ENOUGH_HISTORY' };

  const price = num(ticker?.markPrice) || num(candles[candles.length - 1].close);
  if (!price) return { ok: false, reason: 'NO_PRICE' };

  const a = atr(candles, 14);
  if (!a || a <= 0) return { ok: false, reason: 'NO_ATR' };

  const struct = detectStructure(candles, 2);
  const levels = keyLevels(candles, price, 2);

  // Original break direction
  let breakSide = null;
  if (['BOS_UP', 'CHOCH_UP'].includes(struct.event)) breakSide = 'BUY';
  else if (['BOS_DOWN', 'CHOCH_DOWN'].includes(struct.event)) breakSide = 'SELL';
  else if (struct.trend === 'UP') breakSide = 'BUY';
  else if (struct.trend === 'DOWN') breakSide = 'SELL';
  if (!breakSide) return { ok: false, reason: 'NO_DIRECTION' };

  const support = levels.support?.price ?? null;
  const resistance = levels.resistance?.price ?? null;
  // Level that should be retested after the break
  const retestLevel = breakSide === 'BUY'
    ? (struct.lastHigh?.price ?? resistance)
    : (struct.lastLow?.price ?? support);
  const anchor = breakSide === 'BUY' ? levels.support : levels.resistance;

  const minTouches = Math.max(1, num(settings.minLevelTouches, 1));
  if (settings.minLevelTouches > 0 && anchor && (anchor.touches || 0) < minTouches) {
    // soft: only enforce when we have an anchor with known touches
    if ((anchor.touches || 0) > 0 && (anchor.touches || 0) < minTouches) {
      return { ok: false, reason: 'WEAK_LEVEL' };
    }
  }

  if (settings.requireStrongBreak === true) {
    if (!isStrongBreak(candles, struct.eventIndex, breakSide, a)) {
      return { ok: false, reason: 'WEAK_BREAK' };
    }
  }

  const entryMode = settings.entryMode || 'RETEST_OR_FADE';
  const minSlPct = num(settings.minSlDistPct, 0.5);

  let side = breakSide;
  let path = 'CONTINUATION';
  let pathReason = 'DEFAULT';

  if (entryMode === 'RETEST_OR_FADE') {
    // In dual mode we do NOT reject failed breaks — failure is a valid path
    const decision = decideRetestPath(candles, breakSide, retestLevel, a);
    if (!decision) {
      return { ok: false, reason: 'WAITING_RETEST_DECISION' };
    }
    side = decision.side;
    path = decision.path;
    pathReason = decision.reason;
  } else {
    // Classic continuation only — reject already-failed breaks
    if (settings.rejectFailedBreak !== false) {
      if (hasAlreadyFailed(candles, struct, breakSide)) {
        return { ok: false, reason: 'FAILED_BREAK' };
      }
    }
  }

  // For reversal, the structural anchor flips
  const planSupport = side === 'BUY' ? support : support;
  const planResistance = side === 'SELL' ? resistance : resistance;
  // Use nearest opposite level relative to chosen side
  let useSupport = support;
  let useResistance = resistance;
  if (path === 'REVERSAL') {
    // After a failed retest, place stop beyond the level that just failed
    if (side === 'SELL') {
      // was BUY break that failed → short, stop above failed level
      useResistance = retestLevel;
      useSupport = support;
    } else {
      useSupport = retestLevel;
      useResistance = resistance;
    }
  }

  const plan = buildPlan(side, price, useSupport, useResistance, a, minSlPct);
  if (!plan) return { ok: false, reason: 'INVALID_LEVELS' };

  const { entry, sl, tp } = plan;
  const scored = scoreSetup({
    side, candles, struct, levels, price, entry, sl, tp, btcRegime,
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
      entryPath: path,
      entryPathReason: pathReason,
      breakSide,
      retestLevel,
      levels: {
        support,
        resistance,
        supportTouches: levels.support?.touches ?? 0,
        resistanceTouches: levels.resistance?.touches ?? 0,
      },
      market: {
        turnover24h: num(ticker?.turnover24h),
        spreadPct: ticker?.spreadPct ?? null,
        fundingRate: num(ticker?.fundingRate),
        volRatio: scored.components.volumeRatio,
      },
      btcRegime: btcRegime.regime,
      regimeAligned: scored.aligned,
      timeframe: settings.timeframe,
      quality: {
        touches: anchor?.touches ?? 0,
        path,
        pathReason,
      },
    },
  };
}

module.exports = {
  buildSignal,
  detectBtcRegime,
  regimeAllows,
  scoreSetup,
  isStrongBreak,
  hasAlreadyFailed,
  decideRetestPath,
};
