'use strict';

const settingsMod = require('./settings');
const marketData = require('./marketData');
const bybit = require('./bybit');
const logger = require('./logger');
const store = require('./store');
const { buildSignal, buildSignalStructure, buildSignalTrend, detectBtcRegime } = require('./signals');
const gates = require('./gates');
const risk = require('./risk');
const executor = require('./executor');
const symbolStats = require('./symbolStats');
const journal = require('./journal');
const locationResearch = require('./locationResearch');
const marciShadow = require('./marciShadow');
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
  shadowFunnel: {},
  lastSignals: [],
  haltedUntil: 0,
  haltReason: null,
  symbolLockouts: {},
  killSwitch: false,
  lastError: null,
  startedAt: null,
  desiredRunning: false,
  stoppedAt: null,
  stopReason: null,
  startSource: null,
};

let trades = store.read('trades', []);
let shadowTrades = store.read('marciShadowTrades', []);
let timer = null;

// Persist the operator's run intent separately from process memory. A deploy/container restart
// creates a fresh Node process, so `state.running` necessarily resets to false; without this
// persisted intent Orayan silently stays stopped until somebody notices and presses Start again.
let engineControl = store.read('engineControl', {
  desiredRunning: false,
  lastStartedAt: null,
  lastStoppedAt: null,
  lastStopReason: null,
  lastStartSource: null,
});
if (!engineControl || typeof engineControl !== 'object' || Array.isArray(engineControl)) {
  engineControl = { desiredRunning: false, lastStartedAt: null, lastStoppedAt: null, lastStopReason: null, lastStartSource: null };
}
state.desiredRunning = engineControl.desiredRunning === true;
state.stoppedAt = engineControl.lastStoppedAt || null;
state.stopReason = engineControl.lastStopReason || null;
state.startSource = engineControl.lastStartSource || null;

function persistEngineControl() {
  store.write('engineControl', engineControl);
}


function persistTrades() {
  store.write('trades', trades.slice(-5000));
}

function persistShadowTrades() {
  store.write('marciShadowTrades', shadowTrades.slice(-5000));
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
function openShadowTrades() { return shadowTrades.filter((t) => t.status === 'OPEN'); }
function pendingShadowTrades() { return shadowTrades.filter((t) => t.status === 'PENDING'); }
function closedShadowTrades() { return shadowTrades.filter((t) => t.status === 'CLOSED'); }

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
  // Feed the rolling per-symbol record. Called from the single place every close passes
  // through, so each trade is counted exactly once.
  try {
    symbolStats.recordClose(trade, settings);
  } catch (e) {
    logger.warn('engine', `symbolStats failed on ${trade.symbol}`, { error: e.message });
  }
}

/** Move every open and pending trade forward. Runs even when trading is disabled. */
async function manageOpenTrades(settings) {
  let changed = false;

  if (settings.mode === 'live') {
    // Live closes happen inside syncLiveTrades, which does not run recordLockout. Snapshot the
    // statuses first and reconcile after, otherwise the symbol tracker would only ever learn
    // from paper trades and would sit permanently blind in live mode.
    const beforeStatus = new Map(trades.map((t) => [t.id, t.status]));
    const r = await executor.syncLiveTrades(trades, settings);
    if (r.changed) changed = true;
    for (const t of trades) {
      if (t.status === 'CLOSED' && beforeStatus.get(t.id) !== 'CLOSED') {
        try { recordLockout(t, settings); } catch (e) {
          logger.warn('engine', `post-live-sync record failed on ${t.symbol}`, { error: e.message });
        }
      }
    }
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


async function manageShadowTrades(settings) {
  let changed = false;
  const paperSettings = { ...settings, mode: 'paper' };
  const active = shadowTrades.filter((t) => ['PENDING', 'OPEN'].includes(t.status));

  for (const t of active) {
    try {
      const did = await executor.stepPaperTrade(t, paperSettings);
      if (did) changed = true;
      if (!['PENDING', 'OPEN'].includes(t.status)) continue;

      // Marci-style structural invalidation is a CANDLE-CLOSE rule, not a wick rule. We evaluate
      // it only on the engine timeframe's latest closed candle. Hard SL remains the max-loss
      // backstop inside stepPaperTrade().
      const candles = await marketData.getCandles(t.symbol, settings.timeframe, 5, {
        testnet: settings.testnet,
      });
      const last = candles[candles.length - 1];
      const inv = marciShadow.invalidation(t, last);
      if (!inv.invalidated) continue;

      if (t.status === 'PENDING') {
        t.status = 'CANCELLED';
        t.closedAt = last?.ts || Date.now();
        t.closeReason = 'MARCI trendline invalidated before fill (candle close)';
        t.netPnl = 0; t.grossPnl = 0; t.fees = 0;
      } else {
        executor.closeTrade(t, inv.close, last?.ts || Date.now(),
          'MARCI trendline close invalidation', paperSettings);
      }
      t.marciTrendlineAtExit = inv.line;
      changed = true;
    } catch (e) {
      logger.error('engine', `Error advancing MARCI shadow trade on ${t.symbol}`, { error: e.message });
    }
  }

  if (changed) persistShadowTrades();
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
    await manageShadowTrades(settings);

    if (Date.now() - state.universeBuiltAt > settings.universeRefreshMin * 60000 || !state.universe.length) {
      await buildUniverse(settings);
    }
    const tickers = await marketData.getTickers({ testnet: settings.testnet });
    const tickerBySymbol = new Map(tickers.map((t) => [t.symbol, t]));
    const instruments = await marketData.getInstruments({ testnet: settings.testnet });
    const btcRegime = await getBtcRegime(settings);

    const funnel = { evaluated: 0, noSignal: 0, gated: {}, passed: 0, sized: 0, placed: 0, dual: false };
    const candidates = [];
    const shadowCandidates = [];
    const shadowFunnel = { assessed: 0, passed: 0, placed: 0, rejected: {} };
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

      const dual = settings.dualEngines === true;
      funnel.dual = dual;
      const builders = dual
        ? [
            { name: 'STRUCTURE', fn: buildSignalStructure },
            { name: 'TREND', fn: buildSignalTrend },
          ]
        : [
            {
              name: (settings.activeEngine === 'TREND' ? 'TREND' : 'STRUCTURE'),
              fn: settings.activeEngine === 'TREND' ? buildSignalTrend : buildSignalStructure,
            },
          ];

      for (const b of builders) {
        const built = b.fn({ symbol, candles, ticker, btcRegime, settings });
        if (!built.ok) {
          funnel.noSignal++;
          const key = `${b.name}:${built.reason}`;
          funnel.gated[key] = (funnel.gated[key] || 0) + 1;
          continue;
        }

        const signal = built.signal;
        signal.engine = signal.engine || b.name;

        // Observational research telemetry only. This must NEVER gate, score, size or alter the
        // setup. Attach before gate evaluation so both passed and rejected signal-journal rows
        // carry the same frozen location snapshot.
        signal.locationResearch = locationResearch.measure({ candles, signal });

        const openPositions = [...openTrades(), ...pendingTrades()];
        const verdict = gates.evaluate(signal, settings, {
          openPositions,
          symbolLockouts: state.symbolLockouts,
          dualEngines: dual,
        });
        signal.gates = verdict;

        // Parallel research engine: same source signal, separate portfolio and trade ledger.
        // BTC is disabled ONLY for the shadow verdict and the score is recomputed without the
        // BTC regime multiplier, otherwise BTC would still veto the experiment indirectly.
        const shadowSignalForGates = { ...signal, score: marciShadow.independentScore(signal), engine: 'MARCI_SHADOW' };
        const shadowSettings = {
          ...settings,
          gateBtcRegimeEnabled: false,
          gateRREnabled: false,
          gateCostFloorEnabled: false,
          gateSymbolExpectancyEnabled: false,
          dualEngines: false,
        };
        const shadowBaseVerdict = gates.evaluate(shadowSignalForGates, shadowSettings, {
          openPositions: [...openShadowTrades(), ...pendingShadowTrades()],
          symbolLockouts: {},
          dualEngines: false,
        });
        const shadowAssessment = marciShadow.evaluate(signal, shadowBaseVerdict, settings);
        shadowFunnel.assessed++;
        signal.marciShadow = shadowAssessment;
        if (shadowAssessment.passed) {
          shadowFunnel.passed++;
          shadowCandidates.push(marciShadow.buildShadowSignal(signal, shadowAssessment));
        } else {
          for (const reason of shadowAssessment.failed || []) {
            shadowFunnel.rejected[reason] = (shadowFunnel.rejected[reason] || 0) + 1;
          }
        }

        signalsForUi.push(signal);

        if (!verdict.passed) {
          for (const f of verdict.failed) {
            const key = `${b.name}:${f}`;
            funnel.gated[key] = (funnel.gated[key] || 0) + 1;
          }
          continue;
        }
        funnel.passed++;
        candidates.push(signal);
      }
    }

    // Best-first: the slot limit means ranking decides what actually gets traded.
    candidates.sort((a, b) => b.score - a.score);

    state.funnel = funnel;
    state.lastSignals = signalsForUi
      .sort((a, b) => b.score - a.score)
      .slice(0, 100);

    // Persisted independently of the 100-row UI snapshot above — this is the full record used
    // for journal export and gate-tuning analysis across many scans, not just the latest one.
    journal.recordSignals(signalsForUi, { scanId: uid('scan'), scanAt: Date.now() });

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
        const dual = settings.dualEngines === true;
        const eng = signal.engine || 'STRUCTURE';
        // Dual A/B: each engine gets its own slot budget (default 7)
        if (dual) {
          const perEngine = Math.max(1, Number(settings.maxPerEngine) || 7);
          const engCount = openNow.filter((t) => (t.engine || 'STRUCTURE') === eng).length;
          if (engCount >= perEngine) continue;
        }
        // Same symbol: allowed once per engine in dual (both engines can test the same pair)
        if (openNow.some((t) => t.symbol === signal.symbol && (t.engine || 'STRUCTURE') === eng)) continue;
        if (!dual && openNow.some((t) => t.symbol === signal.symbol)) continue;
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

    // MARCI_SHADOW is always paper-only. It shares the signal source but has its own positions,
    // duplicate-symbol checks, targets, exits and ledger. It may take the same symbol at the same
    // time as Orayan because that overlap is exactly what gives us a clean head-to-head sample.
    if (settings.tradingEnabled && !state.killSwitch) {
      shadowCandidates.sort((a, b) => b.score - a.score);
      for (const signal of shadowCandidates) {
        const activeShadow = [...openShadowTrades(), ...pendingShadowTrades()];
        if (activeShadow.length >= settings.maxOpenPositions) break;
        if (activeShadow.some((t) => t.symbol === signal.symbol)) continue;
        if (activeShadow.filter((t) => t.side === signal.side).length >= settings.maxPerDirection) continue;

        const instrument = instruments.get(signal.symbol);
        const shadowSettings = { ...settings, mode: 'paper' };
        const sizing = risk.sizePosition({ entry: signal.entry, sl: signal.sl, settings: shadowSettings, instrument });
        if (!sizing.ok) continue;

        const trade = executor.createPendingOrder({ signal, sizing, settings: shadowSettings });
        trade.engine = 'MARCI_SHADOW';
        trade.researchEngine = 'MARCI_SHADOW_V1';
        trade.sourceSignalId = signal.sourceSignalId || signal.signalId || signal.id;
        trade.sourceScore = signal.sourceScore ?? null;
        trade.marciShadow = signal.marciShadow ? { ...signal.marciShadow } : null;
        shadowTrades.push(trade);
        shadowFunnel.placed++;
        logger.info('engine', `MARCI shadow queued: ${signal.symbol} ${signal.side} D-target R ${Number(signal.rr).toFixed(2)}`);
      }
      persistShadowTrades();
    }

    state.shadowFunnel = shadowFunnel;
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

async function start({ source = 'OPERATOR' } = {}) {
  if (state.running) return { ok: true, already: true };
  const settings = settingsMod.effective();
  const now = Date.now();
  state.running = true;
  state.desiredRunning = true;
  state.startedAt = now;
  state.stoppedAt = null;
  state.stopReason = null;
  state.startSource = source;
  engineControl.desiredRunning = true;
  engineControl.lastStartedAt = now;
  engineControl.lastStartSource = source;
  engineControl.lastStopReason = null;
  persistEngineControl();
  logger.info('engine', `Engine started in ${settings.mode.toUpperCase()} mode (${settings.testnet ? 'testnet' : 'mainnet'}) [${source}]`);
  try {
    await bybit.syncClock(settings.testnet);
    await scanOnce();
    scheduleNext();
    return { ok: true };
  } catch (e) {
    // A failed startup is not a healthy running engine. Fail closed and require an operator
    // restart rather than persisting a broken auto-resume loop.
    stop({ reason: `START_FAILED: ${e.message}`, preserveDesired: false });
    throw e;
  }
}

function stop({ reason = 'OPERATOR_STOP', preserveDesired = false } = {}) {
  const now = Date.now();
  state.running = false;
  state.stoppedAt = now;
  state.stopReason = reason;
  if (!preserveDesired) state.desiredRunning = false;
  if (timer) clearTimeout(timer);
  timer = null;
  state.nextScanAt = null;

  engineControl.lastStoppedAt = now;
  engineControl.lastStopReason = reason;
  if (!preserveDesired) engineControl.desiredRunning = false;
  persistEngineControl();

  logger.warn('engine', `Engine stopped [${reason}] — open positions are NOT closed automatically`);
  return { ok: true, reason, desiredRunning: state.desiredRunning };
}

function shouldAutoResume() {
  return engineControl.desiredRunning === true;
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

  // Research shadow is paper-only, but the panic button should still stop/cancel every
  // simulated position so the operator has one unmistakable emergency control.
  const shadowSettings = { ...settings, mode: 'paper' };
  for (const t of pendingShadowTrades()) {
    t.status = 'CANCELLED'; t.closedAt = Date.now(); t.closeReason = 'Cancelled by kill switch';
    t.netPnl = 0; t.grossPnl = 0; t.fees = 0; closed++;
  }
  for (const t of openShadowTrades()) {
    try {
      const candles = await marketData.getCandles(t.symbol, '1', 5, { testnet: settings.testnet, ttlMs: 0 });
      const last = candles[candles.length - 1];
      executor.closeTrade(t, last ? last.close : t.fillPrice, Date.now(), 'Closed by kill switch', shadowSettings);
      closed++;
    } catch (e) { errors.push(`MARCI ${t.symbol}: ${e.message}`); }
  }

  persistTrades();
  persistShadowTrades();
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

function summarizeTradeList(list) {
  const closed = list.filter((t) => t.status === 'CLOSED');
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
    open: list.filter((t) => t.status === 'OPEN').length,
    pending: list.filter((t) => t.status === 'PENDING').length,
    expired: list.filter((t) => t.status === 'EXPIRED').length,
  };
}

function summary() { return summarizeTradeList(trades); }
function shadowSummary() { return summarizeTradeList(shadowTrades); }

function getState() {
  const settings = settingsMod.effective();
  return {
    ...state,
    mode: settings.mode,
    testnet: settings.testnet,
    tradingEnabled: settings.tradingEnabled,
    apiKeySet: bybit.keySet(),
    summary: summary(),
    shadowSummary: shadowSummary(),
  };
}

function getTrades({ status, limit = 200 } = {}) {
  let list = trades;
  if (status) list = list.filter((t) => t.status === status);
  return list.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

function getShadowTrades({ status, limit = 200 } = {}) {
  let list = shadowTrades;
  if (status) list = list.filter((t) => t.status === status);
  return list.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

function resetShadowTrades() {
  shadowTrades = [];
  persistShadowTrades();
  logger.warn('engine', 'MARCI shadow trade history cleared by operator');
  return { ok: true };
}

function resetTrades() {
  trades = [];
  persistTrades();
  logger.warn('engine', 'Trade history cleared by operator');
  return { ok: true };
}

function clearLastSignals() {
  state.lastSignals = [];
  state.funnel = {};
  state.shadowFunnel = {};
  logger.warn('engine', 'Live signal list cleared by operator');
  return { ok: true };
}

module.exports = {
  start, stop, shouldAutoResume, scanOnce, panicClose, releaseKillSwitch, clearHalt,
  getState, getTrades, getShadowTrades, resetTrades, resetShadowTrades, clearLastSignals,
  summary, shadowSummary, state,
};
