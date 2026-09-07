'use strict';

/**
 * MARCI_INDEPENDENT_V2
 * --------------------
 * Independent research signal generator inspired by Marci Silfrain's "Little Rizzy" process.
 *
 * It does NOT wait for an Orayan signal. It scans the same closed candles and ticker stream,
 * builds its own trend/rizzy candidate, and feeds the paper-only Marci portfolio.
 *
 * Deterministic formalisation used here:
 *   1) Overall trend: EMA21/EMA55 alignment + EMA21 slope.
 *   2) Little Rizzy geometry: last two confirmed directional pivots since the latest EMA cross.
 *   3) Early sequence only: 1st or 2nd valid Rizzy.
 *   4) Entry: current mark at scan (paper fill still obeys executor fill rules).
 *   5) Hard max-loss backstop: last Rizzy anchor beyond 0.20 ATR, clamped to global SL bounds.
 *   6) Target: full measured-move D projection.
 *   7) Structural invalidation after fill: candle CLOSE through the trendline (managed elsewhere).
 *
 * Bollinger state is recorded but remains observational because the source material does not
 * provide a deterministic numeric BB entry threshold.
 */

const { emaSeries, atr, sma, volumeRatio } = require('./indicators');
const { num, clamp, uid } = require('./util');

const VERSION = 'MARCI_INDEPENDENT_V2';

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
  for (let i = width; i < candles.length - width; i++) {
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

function trendState(candles) {
  const closes = candles.map((c) => num(c.close));
  if (closes.length < 60) return { side: null, reason: 'NOT_ENOUGH_HISTORY' };
  const fast = emaSeries(closes, 21);
  const slow = emaSeries(closes, 55);
  const i = closes.length - 1;
  const prevI = Math.max(55, i - 5);
  const eFast = fast[i];
  const eSlow = slow[i];
  const eFastPrev = fast[prevI];
  if (![eFast, eSlow, eFastPrev].every(Number.isFinite)) return { side: null, reason: 'NO_EMA' };
  const slopePct = eFastPrev ? ((eFast - eFastPrev) / eFastPrev) * 100 : 0;
  const price = closes[i];
  let side = null;
  if (price > eSlow && eFast > eSlow && slopePct > 0) side = 'BUY';
  else if (price < eSlow && eFast < eSlow && slopePct < 0) side = 'SELL';
  if (!side) return { side: null, reason: 'NO_DIRECTIONAL_TREND', eFast, eSlow, slopePct };
  const sepPct = Math.abs(eFast - eSlow) / eSlow * 100;
  const strength = clamp(sepPct * 25 + Math.abs(slopePct) * 30, 0, 100);
  return { side, eFast, eSlow, slopePct, sepPct, strength, fast, slow };
}

function lastTrendStart(candles, side, fast, slow) {
  let start = 54;
  for (let i = 55; i < candles.length; i++) {
    if (![fast[i], slow[i], fast[i - 1], slow[i - 1]].every(Number.isFinite)) continue;
    const crossed = side === 'BUY'
      ? fast[i] > slow[i] && fast[i - 1] <= slow[i - 1]
      : fast[i] < slow[i] && fast[i - 1] >= slow[i - 1];
    if (crossed) start = i;
  }
  return start;
}

function geometry(candles, side, trendStart, a) {
  const ps = pivots(candles, 2);
  const anchors = (side === 'BUY' ? ps.lows : ps.highs).filter((p) => p.i >= trendStart);
  const sequence = Math.max(0, anchors.length - 1);
  if (anchors.length < 2) return { ok: false, reason: 'NO_RIZZY', sequence };

  const a1 = anchors[anchors.length - 2];
  const a2 = anchors[anchors.length - 1];
  if (a2.i <= a1.i) return { ok: false, reason: 'BAD_ANCHORS', sequence };

  const slopePerBar = (a2.price - a1.price) / (a2.i - a1.i);
  if ((side === 'BUY' && slopePerBar <= 0) || (side === 'SELL' && slopePerBar >= 0)) {
    return { ok: false, reason: 'RIZZY_TRENDLINE_WRONG_SLOPE', sequence };
  }

  const lineAt = (i) => a1.price + slopePerBar * (i - a1.i);
  let extreme = null;
  for (let i = a2.i; i < candles.length; i++) {
    const px = side === 'BUY' ? num(candles[i].high) : num(candles[i].low);
    if (!extreme || (side === 'BUY' ? px > extreme.price : px < extreme.price)) {
      extreme = { i, price: px, ts: candles[i].ts };
    }
  }
  if (!extreme || extreme.i <= a2.i) return { ok: false, reason: 'NO_POST_BOUNCE_EXTREME', sequence };

  const lineAtExtreme = lineAt(extreme.i);
  const d = side === 'BUY' ? extreme.price - lineAtExtreme : lineAtExtreme - extreme.price;
  if (!(d > 0)) return { ok: false, reason: 'NON_POSITIVE_D', sequence };

  const lastIdx = candles.length - 1;
  const currentLine = lineAt(lastIdx);
  const close = num(candles[lastIdx].close);
  const invalidated = side === 'BUY' ? close < currentLine : close > currentLine;
  if (invalidated) return { ok: false, reason: 'RIZZY_ALREADY_INVALIDATED', sequence };

  const projectedTarget = side === 'BUY' ? extreme.price + d : extreme.price - d;
  // One Rizzy setup is defined by its trendline anchors. A fresh extension of the same
  // impulse must NOT create a new tradable setup; otherwise the engine can re-enter the same
  // Rizzy repeatedly just because a new extreme printed after an exit. A genuinely new pullback
  // changes anchor2 (and then the anchor pair), which naturally creates a new key.
  const patternKey = [side, a1.ts, a2.ts].join(':');

  return {
    ok: true,
    sequence,
    anchor1: a1,
    anchor2: a2,
    extreme,
    slopePerBar,
    currentLine,
    lineAtExtreme,
    d,
    dAtr: a > 0 ? d / a : null,
    projectedTarget,
    patternKey,
  };
}

function bbState(closes, price) {
  const mid = sma(closes, 20);
  const sd = stddev(closes, 20);
  const upper = mid != null && sd != null ? mid + 2 * sd : null;
  const lower = mid != null && sd != null ? mid - 2 * sd : null;
  return {
    mid,
    std: sd,
    upper,
    lower,
    z: sd > 0 ? (price - mid) / sd : null,
    percentB: upper != null && lower != null && upper !== lower ? (price - lower) / (upper - lower) : null,
  };
}

function buildSignal({ symbol, candles, ticker, btcRegime, settings }) {
  if (!candles || candles.length < 90) return { ok: false, reason: 'NOT_ENOUGH_HISTORY' };
  const price = num(ticker?.markPrice) || num(candles[candles.length - 1].close);
  if (!(price > 0)) return { ok: false, reason: 'NO_PRICE' };
  const a = atr(candles, 14);
  if (!(a > 0)) return { ok: false, reason: 'NO_ATR' };

  const trend = trendState(candles);
  if (!trend.side) return { ok: false, reason: trend.reason || 'NO_TREND' };
  const side = trend.side;
  const trendStart = lastTrendStart(candles, side, trend.fast, trend.slow);
  const g = geometry(candles, side, trendStart, a);
  if (!g.ok) return { ok: false, reason: g.reason, detail: { sequence: g.sequence } };
  if (!(g.sequence >= 1 && g.sequence <= 2)) {
    return { ok: false, reason: 'NOT_EARLY_RIZZY_1_2', detail: { sequence: g.sequence } };
  }

  const entry = price;
  const minSlPct = num(settings.minSlDistPct, 2.1);
  const maxSlPct = num(settings.maxSlDistPct, 4.1);
  const anchor = g.anchor2.price;
  let sl;
  if (side === 'BUY') {
    sl = Math.min(anchor - a * 0.20, entry * (1 - minSlPct / 100));
    if ((entry - sl) / entry * 100 > maxSlPct) sl = entry * (1 - maxSlPct / 100);
  } else {
    sl = Math.max(anchor + a * 0.20, entry * (1 + minSlPct / 100));
    if ((sl - entry) / entry * 100 > maxSlPct) sl = entry * (1 + maxSlPct / 100);
  }

  const tp = g.projectedTarget;
  if (!(sl > 0) || !(tp > 0)) return { ok: false, reason: 'INVALID_LEVELS' };
  if (side === 'BUY' && !(sl < entry && tp > entry)) return { ok: false, reason: 'D_TARGET_BEHIND_ENTRY' };
  if (side === 'SELL' && !(sl > entry && tp < entry)) return { ok: false, reason: 'D_TARGET_BEHIND_ENTRY' };

  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  const targetR = risk > 0 ? reward / risk : 0;
  const targetMovePct = reward / entry * 100;
  const roundTripPct = num(settings.takerFeePct) + num(settings.makerFeePct);
  const requiredCostMove = roundTripPct * num(settings.costFloorMultiple, 2.5);
  if (!(targetMovePct >= requiredCostMove)) {
    return { ok: false, reason: 'D_TARGET_COST_FLOOR', detail: { targetMovePct, requiredCostMove } };
  }

  const closes = candles.map((c) => num(c.close));
  const bb = bbState(closes, price);
  const vr = volumeRatio(candles, 20);
  const slDistPct = risk / entry * 100;

  // Ranking only — NOT a pass/fail score. Sequence 1 outranks sequence 2, then target efficiency
  // and clean directional separation. This exists solely to decide which candidates get scarce
  // portfolio slots when several arrive in one scan.
  const priorityScore = (g.sequence === 1 ? 1000 : 0)
    + Math.min(20, Math.max(0, targetR)) * 10
    + Math.min(10, Math.max(0, num(g.dAtr)))
    + Math.min(100, trend.strength) / 100;

  const createdAt = Date.now();
  const marci = {
    version: VERSION,
    independentSignal: true,
    signalMethod: 'EMA21_55_TREND_PLUS_CONFIRMED_LITTLE_RIZZY',
    entryMethod: 'MARK_AT_SCAN_PAPER_LIMIT',
    hardStopMethod: 'RIZZY_ANCHOR2_PLUS_0.20_ATR_CLAMPED_TO_GLOBAL_SL_BOUNDS',
    targetMethod: 'FULL_MEASURED_MOVE_D',
    invalidationMethod: 'CANDLE_CLOSE_THROUGH_RIZZY_TRENDLINE',
    btcRegimeBypassed: true,
    sequence: g.sequence,
    patternKey: `${symbol}:${g.patternKey}`,
    trendStartTs: candles[trendStart]?.ts ?? null,
    trendStrength: trend.strength,
    ema21: trend.eFast,
    ema55: trend.eSlow,
    ema21SlopePct: trend.slopePct,
    emaSeparationPct: trend.sepPct,
    anchor1Price: g.anchor1.price,
    anchor1Ts: g.anchor1.ts,
    anchor2Price: g.anchor2.price,
    anchor2Ts: g.anchor2.ts,
    extremePrice: g.extreme.price,
    extremeTs: g.extreme.ts,
    trendlineSlopePerBar: g.slopePerBar,
    trendlineAtSignal: g.currentLine,
    trendlineAtExtreme: g.lineAtExtreme,
    d: g.d,
    dAtr: g.dAtr,
    projectedTarget: tp,
    targetR,
    bbMid: bb.mid,
    bbStd: bb.std,
    bbUpper: bb.upper,
    bbLower: bb.lower,
    bbZ: bb.z,
    bbPercentB: bb.percentB,
    priorityScore,
  };

  return {
    ok: true,
    signal: {
      kind: 'marci_signal',
      id: uid('marci_sig'),
      createdAt,
      symbol,
      side,
      price,
      entry,
      sl,
      tp,
      atr: a,
      slDistPct,
      rr: targetR,
      score: Math.round(clamp(50 + Math.min(40, targetR * 5) + (g.sequence === 1 ? 5 : 0), 0, 99)),
      components: {
        base: 50,
        trendStrength: trend.strength,
        marciPriority: priorityScore,
        targetR,
        dAtr: g.dAtr,
      },
      structureEvent: 'LITTLE_RIZZY',
      structureTrend: side === 'BUY' ? 'UP' : 'DOWN',
      entryPath: 'MARCI_INDEPENDENT_RIZZY',
      entryPathReason: `RIZZY_SEQUENCE_${g.sequence}`,
      market: {
        turnover24h: num(ticker?.turnover24h),
        spreadPct: ticker?.spreadPct ?? null,
        fundingRate: num(ticker?.fundingRate),
        volRatio: vr,
      },
      btcRegime: (btcRegime && btcRegime.regime) || 'UNKNOWN',
      regimeAligned: null,
      timeframe: settings.timeframe,
      engine: 'MARCI_SHADOW',
      signalSource: VERSION,
      marciIndependent: marci,
      marciShadow: {
        version: VERSION,
        passed: true,
        independentSignal: true,
        btcRegimeBypassed: true,
        rizzySequence: g.sequence,
        projectedTarget: tp,
        targetR,
        bbZ: bb.z,
        bbPercentB: bb.percentB,
        trendLocation: null,
        patternKey: marci.patternKey,
        priorityScore,
      },
    },
  };
}

module.exports = { VERSION, buildSignal };
