'use strict';

const { ema, rsi, atr, volumeRatio } = require('./indicators');
const { detectStructure, keyLevels } = require('./structure');
const { num, clamp, uid } = require('./util');

/**
 * BTC regime. Every alt is levered beta on BTC, so a long setup on a random alt during a BTC
 * breakdown is not really a long setup on that alt.
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

/**
 * Score a setup out of 100 from transparent, separable components.
 *
 * Deliberately NOT a black box: every component is inspectable in the UI, because a score you
 * cannot decompose is a score you cannot debug when it starts losing.
 */
function scoreSetup({ side, candles, struct, levels, price, entry, sl, tp, btcRegime }) {
  const closes = candles.map((c) => c.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const r = rsi(closes, 14);
  const vr = volumeRatio(candles, 20);
  const isBuy = side === 'BUY';

  const components = {};

  // Trend alignment (0-25)
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

  // Structure quality (0-25)
  let structPts = 0;
  const wantEvent = isBuy ? ['BOS_UP', 'CHOCH_UP'] : ['BOS_DOWN', 'CHOCH_DOWN'];
  if (wantEvent.includes(struct.event)) structPts += 14;
  if ((isBuy && struct.trend === 'UP') || (!isBuy && struct.trend === 'DOWN')) structPts += 7;
  const anchor = isBuy ? levels.support : levels.resistance;
  if (anchor && anchor.touches >= 2) structPts += 4;
  components.structure = structPts;

  // Momentum (0-15). Extremes are penalised — chasing an exhausted move is how the ceiling
  // half of SCORE_BAND earns its keep.
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

  // Entry location (0-20) — how close the plan sits to a real level rather than mid-air.
  let locPts = 0;
  if (anchor && price) {
    const distPct = (Math.abs(price - anchor.price) / price) * 100;
    if (distPct <= 0.25) locPts = 20;
    else if (distPct <= 0.6) locPts = 15;
    else if (distPct <= 1.2) locPts = 9;
    else if (distPct <= 2.5) locPts = 4;
  }
  components.location = locPts;

  // Reward:risk shape (0-15)
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  const rr = risk ? reward / risk : 0;
  let rrPts = 0;
  if (rr >= 2 && rr <= 3.5) rrPts = 15;
  else if (rr > 3.5 && rr <= 5) rrPts = 10;
  else if (rr >= 1.5 && rr < 2) rrPts = 6;
  else if (rr > 5) rrPts = 4;
  components.rr = rrPts;

  // BTC regime agreement — a modifier, not a component, so it cannot manufacture a score alone.
  const aligned = regimeAllows(btcRegime.regime, side);
  const regimeMult = aligned ? 1.0 : 0.75;
  components.regimeMultiplier = regimeMult;
  components.volumeRatio = vr;
  components.rsi = r;

  const raw = trendPts + structPts + momPts + locPts + rrPts;
  const score = Math.round(clamp(raw * regimeMult, 0, 100));

  return { score, components, rr, aligned };
}

/**
 * Build a trade plan for one symbol, or return null with a reason.
 *
 * Entry is placed at the structural level, not at the current price: the plan is "wait for price
 * to come back to the level", which is the fill path that actually preserved reward:risk.
 *
 * STOP GEOMETRY (updated):
 * The stop is placed beyond the structural level with an ATR cushion, but is forced to respect
 * settings.minSlDistPct. This prevents the common failure mode where natural ATR-based stops
 * were 0.4–0.7% and then got rejected by the SL_DISTANCE gate (or got noise-hunted live).
 */
function buildSignal({ symbol, candles, ticker, btcRegime, settings }) {
  if (!candles || candles.length < 80) return { ok: false, reason: 'NOT_ENOUGH_HISTORY' };

  const price = num(ticker?.markPrice) || num(candles[candles.length - 1].close);
  if (!price) return { ok: false, reason: 'NO_PRICE' };

  const a = atr(candles, 14);
  if (!a || a <= 0) return { ok: false, reason: 'NO_ATR' };

  const struct = detectStructure(candles, 2);
  const levels = keyLevels(candles, price, 2);

  // Direction comes from the structural event plus trend, never from price action alone.
  let side = null;
  if (['BOS_UP', 'CHOCH_UP'].includes(struct.event)) side = 'BUY';
  else if (['BOS_DOWN', 'CHOCH_DOWN'].includes(struct.event)) side = 'SELL';
  else if (struct.trend === 'UP') side = 'BUY';
  else if (struct.trend === 'DOWN') side = 'SELL';
  if (!side) return { ok: false, reason: 'NO_DIRECTION' };

  const isBuy = side === 'BUY';
  const support = levels.support?.price ?? null;
  const resistance = levels.resistance?.price ?? null;

  // Minimum stop distance the geometry must respect (from settings, default 0.8%)
  const minSlPct = num(settings.minSlDistPct, 0.8);
  const minSlAbs = price * (minSlPct / 100);

  // ATR cushion (original logic) vs forced minimum — take the larger one so the stop
  // is never tighter than the gate we are about to apply.
  const atrCushion = a * 0.5;
  const cushion = Math.max(atrCushion, minSlAbs * 0.85); // 0.85 leaves a little room for entry offset

  let entry;
  let sl;
  let tp;

  if (isBuy) {
    if (support == null) return { ok: false, reason: 'NO_SUPPORT_LEVEL' };

    // Entry slightly above the level (retest zone)
    entry = Math.min(price, support + a * 0.25);

    // Stop below the level, forced to clear the minimum distance
    sl = support - cushion;

    // Final safety: if even after the cushion the distance is still under min, push it further
    if ((entry - sl) / entry * 100 < minSlPct) {
      sl = entry * (1 - minSlPct / 100);
    }

    tp = resistance != null && resistance > entry
      ? resistance - a * 0.1
      : entry + Math.abs(entry - sl) * 2.5;
  } else {
    if (resistance == null) return { ok: false, reason: 'NO_RESISTANCE_LEVEL' };

    entry = Math.max(price, resistance - a * 0.25);
    sl = resistance + cushion;

    if ((sl - entry) / entry * 100 < minSlPct) {
      sl = entry * (1 + minSlPct / 100);
    }

    tp = support != null && support < entry
      ? support + a * 0.1
      : entry - Math.abs(entry - sl) * 2.5;
  }

  if (!(entry > 0) || !(sl > 0) || !(tp > 0)) return { ok: false, reason: 'INVALID_LEVELS' };
  if (isBuy && !(sl < entry && tp > entry)) return { ok: false, reason: 'INVERTED_PLAN' };
  if (!isBuy && !(sl > entry && tp < entry)) return { ok: false, reason: 'INVERTED_PLAN' };

  const scored = scoreSetup({ side, candles, struct, levels, price, entry, sl, tp, btcRegime });
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
    },
  };
}

module.exports = { buildSignal, detectBtcRegime, regimeAllows, scoreSetup };
