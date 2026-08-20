'use strict';

const { num } = require('./util');
const { regimeAllows } = require('./signals');

/*
 * GATE PHILOSOPHY
 *
 * Every gate is a named predicate that either passes or fails with a stated reason, and can be
 * switched off independently. That structure exists so gates can be measured one at a time
 * against real outcomes — a stack of always-on gates that were never individually tested is
 * indistinguishable from superstition.
 *
 * Default-on gates are the ones that survived testing on real trade outcomes. Default-off gates
 * are kept because they are cheap to re-test, not because they are believed to work.
 */

function evaluate(signal, settings, ctx = {}) {
  const failed = [];
  const checks = [];

  const record = (name, enabled, pass, detail) => {
    checks.push({ name, enabled, pass: enabled ? pass : null, detail });
    if (enabled && !pass) failed.push(name);
  };

  // SCORE_BAND — strongest single gate in testing. The ceiling matters as much as the floor:
  // very high scores marked exhaustion, not conviction.
  {
    const s = num(signal.score);
    const pass = s >= settings.scoreBandLo && s < settings.scoreBandHi;
    record('SCORE_BAND', settings.gateScoreBandEnabled, pass,
      `score ${s} vs [${settings.scoreBandLo}, ${settings.scoreBandHi})`);
  }

  // TURNOVER_GATE — liquidity floor. Thin books tracked the live win-rate decay almost exactly.
  {
    const t = num(signal.market.turnover24h);
    const pass = t >= settings.minTurnover24h;
    record('TURNOVER_GATE', settings.gateTurnoverEnabled, pass,
      `24h turnover ${Math.round(t).toLocaleString()} vs min ${Math.round(settings.minTurnover24h).toLocaleString()}`);
  }

  // RR bounds
  {
    const rr = num(signal.rr);
    const pass = rr >= settings.minRR && rr <= settings.maxRR;
    record('RR_BOUNDS', settings.gateRREnabled, pass,
      `RR ${rr.toFixed(2)} vs [${settings.minRR}, ${settings.maxRR}]`);
  }

  // Cost floor — on a short timeframe, fees decide profitability more often than the signal does.
  {
    const roundTripPct = (num(settings.takerFeePct) + num(settings.makerFeePct));
    const tpMovePct = (Math.abs(signal.tp - signal.entry) / signal.entry) * 100;
    const required = roundTripPct * num(settings.costFloorMultiple);
    const pass = tpMovePct >= required;
    record('COST_FLOOR', settings.gateCostFloorEnabled, pass,
      `target move ${tpMovePct.toFixed(3)}% vs required ${required.toFixed(3)}%`);
  }

  // Stop distance bounds
  {
    const d = num(signal.slDistPct);
    const pass = d >= settings.minSlDistPct && d <= settings.maxSlDistPct;
    record('SL_DISTANCE', settings.gateSlDistEnabled, pass,
      `stop ${d.toFixed(3)}% vs [${settings.minSlDistPct}%, ${settings.maxSlDistPct}%]`);
  }

  // BTC regime alignment
  {
    const pass = regimeAllows(signal.btcRegime, signal.side);
    record('BTC_REGIME', settings.gateBtcRegimeEnabled, pass,
      `${signal.side} under ${signal.btcRegime}`);
  }

  // Spread ceiling
  {
    const sp = signal.market.spreadPct;
    const pass = sp == null ? true : sp <= settings.maxSpreadPct;
    record('SPREAD', settings.gateSpreadEnabled, pass,
      sp == null ? 'spread unknown — passed open' : `spread ${sp.toFixed(4)}% vs max ${settings.maxSpreadPct}%`);
  }

  // VOLUME_GATE — off by default; failed repeatedly on real outcomes.
  {
    const vr = signal.market.volRatio;
    const pass = vr == null ? true : vr >= settings.minVolRatio;
    record('VOLUME_GATE', settings.gateVolumeEnabled, pass,
      vr == null ? 'volume ratio unknown — passed open' : `volRatio ${vr.toFixed(2)} vs min ${settings.minVolRatio}`);
  }

  // FUNDING_GATE — off by default; evidence conflicts between live ledger and backtest.
  {
    const f = num(signal.market.fundingRate);
    let pass = true;
    if (signal.side === 'BUY' && f > settings.fundingBuyMax) pass = false;
    if (signal.side === 'SELL' && f < settings.fundingSellMin) pass = false;
    record('FUNDING_GATE', settings.gateFundingEnabled, pass,
      `funding ${f.toExponential(2)} for ${signal.side}`);
  }

  // Portfolio-level constraints. Not strategy opinions — hard exposure limits.
  {
    const open = ctx.openPositions || [];
    const dual = ctx.dualEngines === true || settings.dualEngines === true;
    const eng = signal.engine || 'STRUCTURE';
    if (dual) {
      const perEngine = Math.max(1, Number(settings.maxPerEngine) || 7);
      const engCount = open.filter((p) => (p.engine || 'STRUCTURE') === eng).length;
      const passEng = engCount < perEngine;
      record('MAX_PER_ENGINE', true, passEng, `${eng} ${engCount} open vs max ${perEngine} per engine`);
    }
    const pass = open.length < settings.maxOpenPositions;
    record('MAX_POSITIONS', true, pass, `${open.length} open vs max ${settings.maxOpenPositions} total`);
  }
  {
    const open = ctx.openPositions || [];
    const sameDir = open.filter((p) => p.side === signal.side).length;
    const pass = sameDir < settings.maxPerDirection;
    record('MAX_PER_DIRECTION', true, pass,
      `${sameDir} ${signal.side} open vs max ${settings.maxPerDirection}`);
  }
  {
    const open = ctx.openPositions || [];
    const dual = ctx.dualEngines === true || (signal.engine && settings.dualEngines === true);
    const eng = signal.engine || 'STRUCTURE';
    // Dual mode: allow same symbol if the other engine holds it; block same engine+symbol
    const pass = dual
      ? !open.some((p) => p.symbol === signal.symbol && (p.engine || 'STRUCTURE') === eng)
      : !open.some((p) => p.symbol === signal.symbol);
    record('NO_DUPLICATE_SYMBOL', true, pass,
      pass ? (dual ? `no ${eng} position on this symbol` : 'no open position on this symbol')
           : (dual ? `already have ${eng} on this symbol` : 'already holding this symbol'));
  }
  {
    const until = (ctx.symbolLockouts || {})[signal.symbol] || 0;
    const pass = Date.now() >= until;
    record('SYMBOL_LOCKOUT', true, pass,
      pass ? 'not locked out' : `locked out until ${new Date(until).toISOString()}`);
  }

  return { passed: failed.length === 0, failed, checks };
}

/** Names in the order the UI funnel should display them. */
const GATE_ORDER = [
  'SCORE_BAND', 'TURNOVER_GATE', 'RR_BOUNDS', 'COST_FLOOR', 'SL_DISTANCE',
  'BTC_REGIME', 'SPREAD', 'VOLUME_GATE', 'FUNDING_GATE',
  'MAX_POSITIONS', 'MAX_PER_DIRECTION', 'NO_DUPLICATE_SYMBOL', 'SYMBOL_LOCKOUT',
];

module.exports = { evaluate, GATE_ORDER };
