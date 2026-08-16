'use strict';

const { num, floorToStep, roundToTick } = require('./util');

/**
 * Size from risk, not from balance.
 *
 * qty = riskUSDT / stopDistance. The position is whatever size makes the stop cost exactly the
 * configured risk — so a wide stop gets a small position automatically, and one bad trade costs
 * the same as any other.
 */
function sizePosition({ entry, sl, settings, instrument }) {
  const risk = num(settings.riskUsdtPerTrade);
  const stopDist = Math.abs(num(entry) - num(sl));
  if (!(stopDist > 0)) return { ok: false, reason: 'ZERO_STOP_DISTANCE' };
  if (!(risk > 0)) return { ok: false, reason: 'ZERO_RISK' };

  let qty = risk / stopDist;

  if (instrument) {
    qty = floorToStep(qty, instrument.qtyStep);
    if (instrument.minOrderQty && qty < instrument.minOrderQty) {
      // Do NOT round up to the minimum — that would silently take more risk than configured.
      const impliedRisk = instrument.minOrderQty * stopDist;
      return {
        ok: false,
        reason: 'BELOW_MIN_QTY',
        detail: `Exchange minimum is ${instrument.minOrderQty}, which would risk ${impliedRisk.toFixed(4)} USDT instead of ${risk}.`,
      };
    }
    if (instrument.maxOrderQty && qty > instrument.maxOrderQty) qty = instrument.maxOrderQty;
  }

  if (!(qty > 0)) return { ok: false, reason: 'ZERO_QTY' };

  const notional = qty * num(entry);
  if (notional > num(settings.maxNotionalUsdt)) {
    const capped = floorToStep(num(settings.maxNotionalUsdt) / num(entry), instrument?.qtyStep);
    if (!(capped > 0) || (instrument?.minOrderQty && capped < instrument.minOrderQty)) {
      return { ok: false, reason: 'NOTIONAL_CAP_TOO_TIGHT', detail: `Notional cap ${settings.maxNotionalUsdt} USDT cannot fit one valid lot.` };
    }
    qty = capped;
  }

  const finalNotional = qty * num(entry);
  const margin = finalNotional / Math.max(1, num(settings.leverage, 1));
  const actualRisk = qty * stopDist;

  return {
    ok: true,
    qty,
    notional: finalNotional,
    margin,
    actualRisk,
    entry: instrument ? roundToTick(entry, instrument.tickSize) : entry,
    sl: instrument ? roundToTick(sl, instrument.tickSize) : sl,
  };
}

/** Round-trip fee estimate in USDT: maker in (resting limit), taker out (stop or target). */
function estimateFees({ notional, settings }) {
  const inFee = notional * (num(settings.makerFeePct) / 100);
  const outFee = notional * (num(settings.takerFeePct) / 100);
  return inFee + outFee;
}

/**
 * Circuit breakers. These are the difference between a losing day and a blown account, so they
 * are evaluated before anything else and halt entries entirely rather than degrading gracefully.
 */
function checkCircuitBreakers({ settings, state, closedTrades }) {
  if (!settings.cbEnabled) return { halted: false, reason: null };

  if (state.haltedUntil && Date.now() < state.haltedUntil) {
    return {
      halted: true,
      reason: state.haltReason || 'Cooling down after a circuit breaker',
      until: state.haltedUntil,
    };
  }

  const sorted = closedTrades.slice().sort((a, b) => b.closedAt - a.closedAt);

  let consec = 0;
  for (const t of sorted) {
    if (num(t.netPnl) < 0) consec += 1;
    else break;
  }
  if (consec >= settings.cbMaxConsecLosses) {
    return {
      halted: true,
      trigger: 'CONSECUTIVE_LOSSES',
      reason: `${consec} losses in a row reached the limit of ${settings.cbMaxConsecLosses}.`,
      cooldownMin: settings.cbCooldownMin,
    };
  }

  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const todayPnl = sorted
    .filter((t) => t.closedAt >= dayStart.getTime())
    .reduce((a, t) => a + num(t.netPnl), 0);
  if (todayPnl <= -Math.abs(settings.cbDailyLossUsdt)) {
    return {
      halted: true,
      trigger: 'DAILY_LOSS',
      reason: `Down ${todayPnl.toFixed(2)} USDT today, past the ${settings.cbDailyLossUsdt} USDT limit.`,
      cooldownMin: settings.cbCooldownMin,
    };
  }

  return { halted: false, reason: null };
}

module.exports = { sizePosition, estimateFees, checkCircuitBreakers };
