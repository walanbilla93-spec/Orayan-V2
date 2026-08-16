'use strict';

const settingsMod = require('./settings');
const marketData = require('./marketData');
const bybit = require('./bybit');
const logger = require('./logger');
const store = require('./store');
const { buildSignal, detectBtcRegime } = require('./signals');
const gates = require('./gates');
const risk = require('./risk');
const executor = require('./executor');
const { num, uid } = require('./util');

const state = {
  running: false,
  scanning: false,
  lastScanAt: null,
  lastScanMs: null,
  nextScanAt: null,
  scanCount: 0,
  btcRegime: { regime: 'UNKNOWN', strength: 0 },
  universe: [],
  universeBuiltAt: 0,
  funnel: {},
  lastSignals: [],
  haltedUntil: 0,
  haltReason: null,
  symbolLockouts: {},
  killSwitch: false,
  lastError: null,
  startedAt: null,
};

let trades = store.read('trades', []);
let timer = null;

function persistTrades() {
  store.write('trades', trades.slice(-5000));
}

function openTrades() {
  return trades.filter((t) => t.status === 'OPEN');
}
function pendingTrades() {
  return trades.filter((t) => t.status === 'PENDING');
}
function closedTrades() {
  return trades.filter((t) => t.status === 'CLOSED');
}

/** Symbols worth scanning: liquid, tradable, not excluded by the operator. */
async function buildUniverse(settings) {
  const tickers = await marketData.getTickers({ testnet: settings.testnet });
  const instruments = await marketData.getInstruments({ testnet: settings.testnet });

  const whitelist = settings.symbolWhitelist
    ? new Set(settings.symbolWhitelist.split(',').filter(Boolean))
    : null;
  const blacklist = new Set((settings.symbolBlacklist || '').split(',').filter(Boolean));

  const universe = tickers
    .filter((t) => instruments.has(t.symbol))
    .filter((t) => !blacklist.has(t.symbol))
    .filter((t) => (whitelist ? whitelist.has(t.symbol) : true))
    .filter((t) => t.turnover24h >= settings.minTurnover24h * 0.5) // pre-filter; the gate is authoritative
    .sort((a, b) => b.turnover24h - a.turnover24h)
    .slice(0, settings.universeSize);

  state.universe = universe.map((t) => t.symbol);
  state.universeBuiltAt = Date.now();
  logger.info('engine', `Universe rebuilt: ${universe.length} symbols`);
  return universe;
}

async function getBtcRegime(settings) {
  try {
    const candles = await marketData.getCandles('BTCUSDT', settings.timeframe, 200, { testnet: settings.testnet });
    const regime = detectBtcRegime(candles);
    state.btcRegime = regime;
    return regime;
  } catch (e) {
    logger.warn('engine', 'Could not determine BTC regime', { error: e.message });
    return { regime: 'UNKNOWN', strength: 0 };
  }
}

function recordLockout(trade, settings) {
  if (num(trade.netPnl) < 0 && settings.cbSymbolLossLockoutMin > 0) {
    state.symbolLockouts[trade.symbol] = Date.now() + settings.cbSymbolLossLockoutMin * 60000;
  }
}

/** Move every open and pending trade forward. Runs even when trading is disabled. */
async function manageOpenTrades(settings) {
  let changed = false;

  if (settings.mode === 'live') {
    const r = await executor.syncLiveTrades(trades, settings);
    if (r.changed) changed = true;
  }

  const active = trades.filter((t) => ['PENDING', 'OPEN'].includes(t.status) && t.mode === 'paper');
  for (const t of active) {
    try {
      const before = t.status;
      const did = await executor.stepPaperTrade(t, settings);
      if (did) changed = true;
      if (before !== 'CLOSED' && t.status === 'CLOSED') recordLockout(t, settings);
    } catch (e) {
      logger.error('engine', `Error advancing trade on ${t.symbol}`, { error: e.message });
    }
  }

  if (changed) persistTrades();
  return changed;
}

async function scanOnce() {
  if (state.scanning) {
    logger.debug('engine', 'Scan already in progress, skipping this tick');
    return;
  }
  state.scanning = true;
  const t0 = Date.now();
  const settings = settingsMod.effective();

  try {
    await manageOpenTrades(settings);

    if (Date.now() - state.universeBuiltAt > settings.universeRefreshMin * 60000 || !state.universe.length) {
      await buildUniverse(settings);
    }
    const tickers = await marketData.getTickers({ testnet: settings.testnet });
    const tickerBySymbol = new Map(tickers.map((t) => [t.symbol, t]));
    const instruments = await marketData.getInstruments({ testnet: settings.testnet });
    const btcRegime = await getBtcRegime(settings);

    const funnel = { evaluated: 0, noSignal: 0, gated: {}, passed: 0, sized: 0, placed: 0 };
    const candidates = [];
    const signalsForUi = [];

    const cb = risk.checkCircuitBreakers({ settings, state, closedTrades: closedTrades() });
    if (cb.halted && !state.haltedUntil) {
      state.haltedUntil = Date.now() + (cb.cooldownMin || settings.cbCooldownMin) * 60000;
      state.haltReason = cb.reason;
      logger.warn('engine', `Circuit breaker tripped: ${cb.reason}`);
    }
    if (state.haltedUntil && Date.now() >= state.haltedUntil) {
      state.haltedUntil = 0;
      state.haltReason = null;
      logger.info('engine', 'Circuit breaker cooldown finished — entries allowed again');
    }

    for (const symbol of state.universe) {
      const ticker = tickerBySymbol.get(symbol);
      if (!ticker) continue;
      funnel.evaluated++;

      let candles;
      try {
        candles = await marketData.getCandles(symbol, settings.timeframe, 200, { testnet: settings.testnet });
      } catch (e) {
        logger.debug('engine', `No candles for ${symbol}`, { error: e.message });
        continue;
      }

      const built = buildSignal({ symbol, candles, ticker, btcRegime, settings });
      if (!built.ok) {
        funnel.noSignal++;
        funnel.gated[built.reason] = (funnel.gated[built.reason] || 0) + 1;
        continue;
      }

      const signal = built.signal;
      const verdict = gates.evaluate(signal, settings, {
        openPositions: [...openTrades(), ...pendingTrades()],
        symbolLockouts: state.symbolLockouts,
      });
      signal.gates = verdict;

      signalsForUi.push(signal);

      if (!verdict.passed) {
        for (const f of verdict.failed) funnel.gated[f] = (funnel.gated[f] || 0) + 1;
        continue;
      }
      funnel.passed++;
      candidates.push(signal);
    }

    // Best-first: the slot limit means ranking decides what actually gets traded.
    candidates.sort((a, b) => b.score - a.score);

    state.funnel = funnel;
    state.lastSignals = signalsForUi
      .sort((a, b) => b.score - a.score)
      .slice(0, 100);

    const blockReason = !settings.tradingEnabled ? 'Trading is switched off'
      : state.killSwitch ? 'Kill switch is engaged'
      : state.haltedUntil ? `Halted: ${state.haltReason}`
      : null;

    if (blockReason) {
      if (candidates.length) {
        logger.info('engine', `${candidates.length} setup(s) passed all gates but nothing was placed — ${blockReason}`);
      }
    } else {
      for (const signal of candidates) {
        const openNow = [...openTrades(), ...pendingTrades()];
        if (openNow.length >= settings.maxOpenPositions) break;
        if (openNow.some((t) => t.symbol === signal.symbol)) continue;
        if (openNow.filter((t) => t.side === signal.side).length >= settings.maxPerDirection) continue;

        const instrument = instruments.get(signal.symbol);
        const sizing = risk.sizePosition({ entry: signal.entry, sl: signal.sl, settings, instrument });
        if (!sizing.ok) {
          funnel.gated[sizing.reason] = (funnel.gated[sizing.reason] || 0) + 1;
          logger.debug('engine', `Cannot size ${signal.symbol}: ${sizing.reason}`, { detail: sizing.detail });
          continue;
        }
        funnel.sized++;

        const trade = executor.createPendingOrder({ signal, sizing, settings });

        if (settings.mode === 'live') {
          try {
            await executor.placeLiveOrder({ trade, settings, instrument });
          } catch (e) {
            logger.error('engine', `Live order rejected for ${signal.symbol}`, { error: e.message });
            continue;
          }
        }

        trades.push(trade);
        funnel.placed++;
        logger.info('engine',
          `${settings.mode === 'live' ? 'Live' : 'Paper'} order queued: ${signal.symbol} ${signal.side} score ${signal.score} qty ${sizing.qty}`);
      }
      if (funnel.placed) persistTrades();
    }

    state.lastScanAt = Date.now();
    state.lastScanMs = Date.now() - t0;
    state.scanCount++;
    state.lastError = null;
    logger.info('engine',
      `Scan ${state.scanCount}: ${funnel.evaluated} symbols, ${funnel.passed} passed gates, ${funnel.placed} placed (${state.lastScanMs}ms)`);
  } catch (e) {
    state.lastError = e.message;
    logger.error('engine', 'Scan failed', { error: e.message, stack: e.stack });
  } finally {
    state.scanning = false;
  }
}

function scheduleNext() {
  if (!state.running) return;
  const settings = settingsMod.effective();
  const ms = settings.scanIntervalSec * 1000;
  state.nextScanAt = Date.now() + ms;
  timer = setTimeout(async () => {
    await scanOnce();
    scheduleNext();
  }, ms);
}

async function start() {
  if (state.running) return { ok: true, already: true };
  const settings = settingsMod.effective();
  state.running = true;
  state.startedAt = Date.now();
  logger.info('engine', `Engine started in ${settings.mode.toUpperCase()} mode (${settings.testnet ? 'testnet' : 'mainnet'})`);
  await bybit.syncClock(settings.testnet);
  await scanOnce();
  scheduleNext();
  return { ok: true };
}

function stop() {
  state.running = false;
  if (timer) clearTimeout(timer);
  timer = null;
  state.nextScanAt = null;
  logger.warn('engine', 'Engine stopped — open positions are NOT closed automatically');
  return { ok: true };
}

/** Close everything now and stop opening more. The button you want when something is wrong. */
async function panicClose() {
  const settings = settingsMod.effective();
  state.killSwitch = true;
  logger.warn('engine', 'Kill switch engaged — closing all positions');

  let closed = 0;
  const errors = [];

  for (const t of pendingTrades()) {
    if (t.mode === 'live') await executor.cancelLiveOrder({ trade: t, settings });
    t.status = 'CANCELLED';
    t.closedAt = Date.now();
    t.closeReason = 'Cancelled by kill switch';
    t.netPnl = 0; t.grossPnl = 0; t.fees = 0;
    closed++;
  }

  for (const t of openTrades()) {
    try {
      if (t.mode === 'live') {
        await executor.closeLivePosition({ trade: t, settings });
        t.status = 'CLOSED';
        t.closedAt = Date.now();
        t.closeReason = 'Closed by kill switch';
      } else {
        const candles = await marketData.getCandles(t.symbol, '1', 5, { testnet: settings.testnet, ttlMs: 0 });
        const last = candles[candles.length - 1];
        executor.closeTrade(t, last ? last.close : t.fillPrice, Date.now(), 'Closed by kill switch', settings);
      }
      closed++;
    } catch (e) {
      errors.push(`${t.symbol}: ${e.message}`);
    }
  }

  persistTrades();
  return { ok: errors.length === 0, closed, errors };
}

function releaseKillSwitch() {
  state.killSwitch = false;
  logger.info('engine', 'Kill switch released');
  return { ok: true };
}

function clearHalt() {
  state.haltedUntil = 0;
  state.haltReason = null;
  state.symbolLockouts = {};
  logger.info('engine', 'Circuit breaker halt cleared by operator');
  return { ok: true };
}

function summary() {
  const closed = closedTrades();
  const wins = closed.filter((t) => num(t.netPnl) > 0);
  const losses = closed.filter((t) => num(t.netPnl) < 0);
  const grossWin = wins.reduce((a, t) => a + num(t.netPnl), 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + num(t.netPnl), 0));
  const net = closed.reduce((a, t) => a + num(t.netPnl), 0);

  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const todayPnl = closed.filter((t) => t.closedAt >= dayStart.getTime())
    .reduce((a, t) => a + num(t.netPnl), 0);

  // Max drawdown across the closed-trade equity curve.
  let peak = 0; let equity = 0; let maxDd = 0;
  for (const t of closed.slice().sort((a, b) => a.closedAt - b.closedAt)) {
    equity += num(t.netPnl);
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }

  let consecLosses = 0;
  for (const t of closed.slice().sort((a, b) => b.closedAt - a.closedAt)) {
    if (num(t.netPnl) < 0) consecLosses++; else break;
  }

  return {
    totalClosed: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : null,
    netPnl: net,
    todayPnl,
    avgPnl: closed.length ? net / closed.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    expectancy: closed.length ? net / closed.length : null,
    maxDrawdown: maxDd,
    consecLosses,
    open: openTrades().length,
    pending: pendingTrades().length,
    expired: trades.filter((t) => t.status === 'EXPIRED').length,
  };
}

function getState() {
  const settings = settingsMod.effective();
  return {
    ...state,
    mode: settings.mode,
    testnet: settings.testnet,
    tradingEnabled: settings.tradingEnabled,
    apiKeySet: bybit.keySet(),
    summary: summary(),
  };
}

function getTrades({ status, limit = 200 } = {}) {
  let list = trades;
  if (status) list = list.filter((t) => t.status === status);
  return list.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

function resetTrades() {
  trades = [];
  persistTrades();
  logger.warn('engine', 'Trade history cleared by operator');
  return { ok: true };
}

module.exports = {
  start, stop, scanOnce, panicClose, releaseKillSwitch, clearHalt,
  getState, getTrades, resetTrades, summary, state,
};
