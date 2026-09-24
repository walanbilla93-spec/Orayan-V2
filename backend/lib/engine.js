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
const marciIndependent = require('./marciIndependent');
const researchCapture = require('./researchCapture');
const researchSupplement = require('./researchSupplement');
const earlyEntryShadow = require('./earlyEntryShadow');
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
let lastStopRecoveryBackfillAt = 0;
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
    const latest=candles.at(-1),intervalMs=Number(settings.timeframe)*60000;
    if (!latest || !Number.isFinite(latest.ts) ||
        Date.now()-(latest.ts+intervalMs)>2.5*intervalMs)
      throw Error('BTC closed candle is missing or stale');
    const regime = {...detectBtcRegime(candles),observedAt:Date.now(),closedBarAt:latest.ts+intervalMs};
    state.btcRegime = regime;
    return regime;
  } catch (e) {
    logger.warn('engine', 'Could not determine BTC regime', { error: e.message });
    state.btcRegime={ regime: 'UNKNOWN', strength: 0, observedAt:Date.now(),closedBarAt:null,error:e.message };
    return state.btcRegime;
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
      if (beforeStatus.get(t.id) && beforeStatus.get(t.id) !== t.status)
        researchCapture.outcome(t.signalId, t.status, t);
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
      if (before !== t.status) researchCapture.outcome(t.signalId, t.status, t);
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
      const statusBefore = t.status;
      const tfMs = Math.max(60000, num(settings.timeframe, 15) * 60000);

      // A resting Marci order must be cancelled if ANY completed signal-timeframe candle since
      // order creation closed through the Rizzy line. Check this BEFORE the 1m fill simulator.
      // Otherwise a scan arriving just after a 15m boundary can fill an order that should already
      // have been cancelled by the structural rule. We inspect the whole pending lifetime (bounded
      // by the entry window), not only the latest candle, so a brief invalidation cannot be missed
      // after a restart or slow scan.
      if (t.status === 'PENDING') {
        const ageBars = Math.ceil(Math.max(0, Date.now() - num(t.createdAt)) / tfMs) + 3;
        const preCandles = await marketData.getCandles(
          t.symbol, settings.timeframe, Math.min(1000, Math.max(5, ageBars)),
          { testnet: settings.testnet }
        );
        const afterCreate = preCandles.filter((c) => c.ts + tfMs >= num(t.createdAt));
        const firstInvalid = afterCreate.find((c) => marciShadow.invalidation(t, c).invalidated);
        if (firstInvalid) {
          const inv = marciShadow.invalidation(t, firstInvalid);
          t.status = 'CANCELLED';
          t.closedAt = firstInvalid.ts + tfMs;
          t.closeReason = 'MARCI trendline invalidated before fill (candle close)';
          t.netPnl = 0; t.grossPnl = 0; t.fees = 0;
          t.marciTrendlineAtExit = inv.line;
          changed = true;
          researchCapture.outcome(t.signalId, t.status, t, { reason:t.closeReason });
          continue;
        }
      }

      const did = await executor.stepPaperTrade(t, paperSettings);
      if (did) changed = true;
      if (statusBefore !== t.status) researchCapture.outcome(t.signalId, t.status, t);
      if (!['PENDING', 'OPEN'].includes(t.status)) continue;

      // Marci-style structural invalidation is a CANDLE-CLOSE rule, not a wick rule. Hard SL
      // remains the max-loss backstop inside stepPaperTrade().
      const candles = await marketData.getCandles(t.symbol, settings.timeframe, 5, {
        testnet: settings.testnet,
      });
      const last = candles[candles.length - 1];
      const closedTs = last?.ts ? last.ts + tfMs : Date.now();
      // Never apply a candle-close invalidation from before the position actually existed.
      const relevantFrom = t.status === 'OPEN' ? num(t.filledAt) : num(t.createdAt);
      if (last?.ts != null && last.ts + tfMs < relevantFrom) continue;
      const inv = marciShadow.invalidation(t, last);
      if (!inv.invalidated) continue;

      if (t.status === 'PENDING') {
        t.status = 'CANCELLED';
        t.closedAt = closedTs;
        t.closeReason = 'MARCI trendline invalidated before fill (candle close)';
        t.netPnl = 0; t.grossPnl = 0; t.fees = 0;
      } else {
        executor.closeTrade(t, inv.close, closedTs,
          'MARCI trendline close invalidation', paperSettings);
        t.marciCounterfactual = {
          tracking: true,
          exitPrice: inv.close,
          startedAt: closedTs,
          lastCheckedTs: closedTs,
          postInvalidationMfeR: 0,
          postInvalidationMaeR: 0,
          outcome: null,
          originalPlanWouldWin: null,
          resolvedAt: null,
        };
      }
      t.marciTrendlineAtExit = inv.line;
      changed = true;
      researchCapture.outcome(t.signalId, t.status, t, { reason:t.closeReason });
    } catch (e) {
      logger.error('engine', `Error advancing MARCI shadow trade on ${t.symbol}`, { error: e.message });
    }
  }

  if (changed) persistShadowTrades();
  return changed;
}


async function manageMarciCounterfactuals(settings) {
  let changed = false;
  const trackers = shadowTrades.filter((t) =>
    t.status === 'CLOSED'
    && t.marciCounterfactual?.tracking === true
    && t.filledAt
    && t.closedAt
  );

  for (const t of trackers) {
    try {
      const cf = t.marciCounterfactual;
      const anchor = num(cf.lastCheckedTs) || num(t.closedAt);
      const sinceMin = Math.ceil((Date.now() - anchor) / 60000) + 5;
      const limit = Math.min(1000, Math.max(10, sinceMin));
      const candles = await marketData.getCandles(t.symbol, '1', limit, {
        testnet: settings.testnet,
        ttlMs: 10000,
      });
      const after = candles.filter((c) => c.ts >= anchor);
      const isBuy = t.side === 'BUY';
      const riskPx = Math.abs(num(t.fillPrice) - num(t.sl));
      for (const c of after) {
        const favPx = isBuy ? num(c.high) - num(cf.exitPrice) : num(cf.exitPrice) - num(c.low);
        const advPx = isBuy ? num(cf.exitPrice) - num(c.low) : num(c.high) - num(cf.exitPrice);
        if (riskPx > 0) {
          cf.postInvalidationMfeR = Math.max(num(cf.postInvalidationMfeR, 0), favPx / riskPx);
          cf.postInvalidationMaeR = Math.max(num(cf.postInvalidationMaeR, 0), advPx / riskPx);
        }

        const hitTp = isBuy ? num(c.high) >= num(t.tp) : num(c.low) <= num(t.tp);
        const hitSl = isBuy ? num(c.low) <= num(t.sl) : num(c.high) >= num(t.sl);
        if (hitTp || hitSl) {
          cf.tracking = false;
          cf.resolvedAt = c.ts;
          cf.outcome = hitTp && hitSl ? 'STOP_SAME_CANDLE_CONSERVATIVE' : hitSl ? 'STOP' : 'TARGET';
          cf.originalPlanWouldWin = hitTp && !hitSl;
          changed = true;
          break;
        }
      }

      if (cf.tracking && after.length) {
        cf.lastCheckedTs = after[after.length - 1].ts;
      }
      if (cf.tracking && Date.now() - num(t.filledAt) > settings.maxHoldMin * 60000) {
        cf.tracking = false;
        cf.resolvedAt = Date.now();
        cf.outcome = 'MAX_HOLD';
        cf.originalPlanWouldWin = null;
        changed = true;
      }
    } catch (e) {
      logger.warn('engine', `MARCI counterfactual tracking failed on ${t.symbol}`, { error: e.message });
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
    if (Date.now()-lastStopRecoveryBackfillAt >= 3600000) {
      lastStopRecoveryBackfillAt = Date.now();
      for (const trade of closedTrades()) {
        try { researchSupplement.observeStop(trade,researchCapture.candidateLink(trade.signalId)||{}); }
        catch (e) { logger.warn('research','Stop recovery restore failed',{error:e.message}); }
      }
    }
    await manageOpenTrades(settings);
    await manageShadowTrades(settings);
    await manageMarciCounterfactuals(settings);

    if (Date.now() - state.universeBuiltAt > settings.universeRefreshMin * 60000 || !state.universe.length) {
      await buildUniverse(settings);
    }
    const tickers = await marketData.getTickers({ testnet: settings.testnet });
    try { researchCapture.watch(state.universe, settings.testnet); }
    catch (e) { logger.warn('research', 'Liquidation watch unavailable', { error:e.message }); }
    earlyEntryShadow.start();
    const tickerResearch = researchCapture.tickerDynamics(tickers, Date.now());
    const tickerBySymbol = new Map(tickers.map((t) => [t.symbol, t]));
    const instruments = await marketData.getInstruments({ testnet: settings.testnet });
    const btcRegime = await getBtcRegime(settings);
    logger.info('engine', `BTC regime ${btcRegime.regime} from closed bar ${btcRegime.closedBarAt || 'NOT_AVAILABLE'}`);
    const scanAt = Date.now();
    const scanId = uid('scan');
    const researchConfigHash = researchCapture.settingsHash(settings);
    const marketObservations = [];
    const researchCandles = new Map();
    const structureObservations = [];
    try {
      const btcCandles = await marketData.getCandles('BTCUSDT', settings.timeframe, 200, { testnet: settings.testnet });
      marketObservations.push(journal.buildMarketObservation('BTCUSDT', btcCandles));
    } catch (e) {
      logger.debug('engine', 'BTC market research observation unavailable', { error: e.message });
    }

    const funnel = { evaluated: 0, noSignal: 0, gated: {}, passed: 0, sized: 0, placed: 0, dual: false };
    const candidates = [];
    const shadowCandidates = [];
    const shadowFunnel = { assessed: 0, passed: 0, placed: 0, rejected: {}, source: marciIndependent.VERSION };
    const signalsForUi = [];
    const journalSignals = [];
    const orderResolved = new Set();

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
        researchCandles.set(symbol, candles);
        structureObservations.push({symbol,candles,ticker,tickerDynamic:tickerResearch.get(symbol)});
        marketObservations.push(journal.buildMarketObservation(symbol, candles));
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

        signalsForUi.push(signal);
        journalSignals.push(signal);

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

      // MARCI_INDEPENDENT_V2 scans the same candles but does NOT wait for an Orayan signal.
      // It owns discovery; only execution-quality/portfolio gates are shared for a fair paper test.
      shadowFunnel.assessed++;
      const marciBuilt = marciIndependent.buildSignal({ symbol, candles, ticker, btcRegime, settings });
      if (!marciBuilt.ok) {
        const r = marciBuilt.reason || 'NO_MARCI_SETUP';
        shadowFunnel.rejected[r] = (shadowFunnel.rejected[r] || 0) + 1;
      } else {
        const mSignal = marciBuilt.signal;
        mSignal.locationResearch = locationResearch.measure({ candles, signal: mSignal });

        const shadowSettings = {
          ...settings,
          gateScoreBandEnabled: false,
          gateBtcRegimeEnabled: false,
          gateRREnabled: false,
          gateCostFloorEnabled: false,
          gateSymbolExpectancyEnabled: false,
          // These are Orayan strategy filters, not neutral execution protections. Leaving them
          // enabled would silently make Marci's supposedly independent discovery depend on
          // effects validated on the Orayan ledger. Keep the liquidity floor, spread check,
          // stop-distance safety bounds and portfolio limits; disable the strategy opinions.
          gateTurnoverCeilingEnabled: false,
          gateVolumeEnabled: false,
          gateFundingEnabled: false,
          dualEngines: false,
        };
        const shadowVerdict = gates.evaluate(mSignal, shadowSettings, {
          openPositions: [...openShadowTrades(), ...pendingShadowTrades()],
          symbolLockouts: {},
          dualEngines: false,
        });
        mSignal.gates = shadowVerdict;
        mSignal.marciShadow = {
          ...(mSignal.marciShadow || {}),
          passed: shadowVerdict.passed,
          failed: shadowVerdict.failed || [],
          checks: shadowVerdict.checks || [],
        };
        journalSignals.push(mSignal);

        if (shadowVerdict.passed) {
          const patternKey = mSignal.marciIndependent?.patternKey;
          const seen = patternKey && shadowTrades.some((t) => t.marciPatternKey === patternKey);
          if (seen) {
            shadowFunnel.rejected.PATTERN_ALREADY_TRADED = (shadowFunnel.rejected.PATTERN_ALREADY_TRADED || 0) + 1;
            mSignal.marciShadow.passed = false;
            mSignal.marciShadow.failed = [...(mSignal.marciShadow.failed || []), 'PATTERN_ALREADY_TRADED'];
          } else {
            shadowFunnel.passed++;
            shadowCandidates.push(mSignal);
          }
        } else {
          for (const reason of shadowVerdict.failed || []) {
            shadowFunnel.rejected[reason] = (shadowFunnel.rejected[reason] || 0) + 1;
          }
        }
      }
    }

    // Observational only: one immutable cross-sectional snapshot per completed signal bar.
    // No value produced here is read by signal builders, gates, sizing, ranking or execution.
    const marketSnapshot = journal.captureMarketSnapshot(marketObservations, {
      scanId, scanAt, timeframe: settings.timeframe,
      expectedUniverseCount: state.universe.length,
      btcRegime: btcRegime?.regime || null,
      configHash: researchConfigHash,
    });
    const marketSnapshotId = marketSnapshot?.marketSnapshotId || null;
    for (const signal of journalSignals) signal.marketSnapshotId = marketSnapshotId;
    const btcObservation = marketObservations.find(x => x?.symbol === 'BTCUSDT');
    const r12s = marketObservations.filter(x => x?.symbol !== 'BTCUSDT' && Number.isFinite(x?.r12))
      .map(x => Math.log1p(x.r12)).sort((a,b) => a-b);
    const universeResearch = { r12Median:r12s.length ? r12s[Math.floor(r12s.length/2)] : null };
    for (const signal of journalSignals) {
      try { researchCapture.birth(signal, { scanId, scanAt, ticker:tickerBySymbol.get(signal.symbol),
        candles:researchCandles.get(signal.symbol) || [], settings, snapshot:marketSnapshot,
        btc:{r12:btcObservation?.r12 == null ? null : Math.log1p(btcObservation.r12)}, universe:universeResearch,
        tickerDynamic:tickerResearch.get(signal.symbol) }); }
      catch (e) { logger.warn('research', 'Birth capture failed', { error:e.message, symbol:signal.symbol }); }
      // Shadow-only sidecar. Its return value is deliberately ignored and cannot affect any
      // candidate, gate, rank, size, portfolio limit, or order path below.
      try { earlyEntryShadow.observeCandidate(signal,{scanAt,settings,snapshot:marketSnapshot,
        candles:researchCandles.get(signal.symbol)||[],configHash:researchConfigHash,
        instrument:instruments.get(signal.symbol)||null}); }
      catch (e) { logger.warn('research','Early-entry shadow capture failed',{error:e.message,symbol:signal.symbol}); }
    }
    for (const observation of structureObservations) {
      try { researchSupplement.observeStructure({...observation,settings,scanAt,
        configHash:researchConfigHash,marketSnapshotId,marketSnapshot,signals:journalSignals}); }
      catch (e) { logger.warn('research','Structure capture failed',{symbol:observation.symbol,error:e.message}); }
    }

    // Best-first: the slot limit means ranking decides what actually gets traded.
    candidates.sort((a, b) => b.score - a.score);

    state.funnel = funnel;
    state.lastSignals = signalsForUi
      .sort((a, b) => b.score - a.score)
      .slice(0, 100);

    // Persisted independently of the 100-row UI snapshot above — this is the full record used
    // for journal export and gate-tuning analysis across many scans, not just the latest one.
    journal.recordSignals(journalSignals, { scanId, scanAt, marketSnapshotId, configHash:researchConfigHash });

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
          researchCapture.outcome(signal.id, 'NO_ORDER', null, { reason:sizing.reason });
          orderResolved.add(signal.id);
          funnel.gated[sizing.reason] = (funnel.gated[sizing.reason] || 0) + 1;
          logger.debug('engine', `Cannot size ${signal.symbol}: ${sizing.reason}`, { detail: sizing.detail });
          continue;
        }
        funnel.sized++;

        const trade = executor.createPendingOrder({ signal, sizing, settings });
        const candidateLink = researchCapture.candidateLink(signal.id);
        trade.marketSnapshotId = signal.marketSnapshotId || marketSnapshotId;
        trade.configHash = researchConfigHash;
        trade.candidateKey = candidateLink?.key || null;
        trade.episodeId = candidateLink?.episodeId || null;
        trade.atrAtBirth = signal.atr ?? null;
        trade.structureBreakLevel = signal.retestLevel ?? signal.levels?.brokenLevel ?? null;
        trade.testnet = !!settings.testnet;
        researchCapture.outcome(signal.id, 'ORDER_INTENT', trade, { mode:settings.mode });

        if (settings.mode === 'live') {
          try {
            await executor.placeLiveOrder({ trade, settings, instrument });
          } catch (e) {
            researchCapture.outcome(signal.id, 'ORDER_REJECTED', trade, { reason:e.message });
            orderResolved.add(signal.id);
            logger.error('engine', `Live order rejected for ${signal.symbol}`, { error: e.message });
            continue;
          }
        }

        trades.push(trade);
        researchCapture.outcome(signal.id, 'ORDER_ACK', trade, { mode:settings.mode });
        orderResolved.add(signal.id);
        funnel.placed++;
        logger.info('engine',
          `${settings.mode === 'live' ? 'Live' : 'Paper'} order queued: ${signal.symbol} ${signal.side} score ${signal.score} qty ${sizing.qty}`);
      }
      if (funnel.placed) persistTrades();
    }

    // MARCI_INDEPENDENT_V2 is always paper-only. It has its own signal discovery, positions,
    // duplicate-symbol checks, targets, exits and ledger. It may take the same symbol at the same
    // time as Orayan because that overlap is exactly what gives us a clean head-to-head sample.
    if (settings.tradingEnabled && !state.killSwitch) {
      shadowCandidates.sort((a, b) => num(b.marciIndependent?.priorityScore) - num(a.marciIndependent?.priorityScore));
      for (const signal of shadowCandidates) {
        const activeShadow = [...openShadowTrades(), ...pendingShadowTrades()];
        if (activeShadow.length >= settings.maxOpenPositions) break;
        if (activeShadow.some((t) => t.symbol === signal.symbol)) continue;
        if (activeShadow.filter((t) => t.side === signal.side).length >= settings.maxPerDirection) continue;

        const instrument = instruments.get(signal.symbol);
        const shadowSettings = { ...settings, mode: 'paper' };
        const sizing = risk.sizePosition({ entry: signal.entry, sl: signal.sl, settings: shadowSettings, instrument });
        if (!sizing.ok) { researchCapture.outcome(signal.id, 'NO_ORDER', null, {reason:sizing.reason}); orderResolved.add(signal.id); continue; }
        researchCapture.outcome(signal.id, 'ORDER_INTENT', null, { mode:'paper' });

        const trade = executor.createPendingOrder({ signal, sizing, settings: shadowSettings });
        trade.marketSnapshotId = signal.marketSnapshotId || marketSnapshotId;
        trade.engine = 'MARCI_SHADOW';
        trade.researchEngine = marciIndependent.VERSION;
        trade.sourceSignalId = signal.id;
        trade.sourceScore = null;
        trade.signalSource = marciIndependent.VERSION;
        trade.marciPatternKey = signal.marciIndependent?.patternKey || null;
        trade.marciIndependent = signal.marciIndependent ? { ...signal.marciIndependent } : null;
        trade.marciShadow = signal.marciShadow ? { ...signal.marciShadow } : null;
        shadowTrades.push(trade);
        researchCapture.outcome(signal.id, 'ORDER_ACK', trade, { mode:'paper' });
        orderResolved.add(signal.id);
        shadowFunnel.placed++;
        logger.info('engine', `MARCI independent queued: ${signal.symbol} ${signal.side} Rizzy ${signal.marciIndependent?.sequence} D-target R ${Number(signal.rr).toFixed(2)}`);
      }
      persistShadowTrades();
    }

    for (const signal of journalSignals) {
      if (signal.gates?.passed && !orderResolved.has(signal.id)
        && signal.marciShadow?.passed !== false)
        researchCapture.outcome(signal.id, 'NO_ORDER', null,
          {reason:blockReason || (!settings.tradingEnabled || state.killSwitch ? 'TRADING_DISABLED_OR_KILL_SWITCH' : 'PORTFOLIO_OR_SLOT_LIMIT')});
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
  researchCapture.stop();
  earlyEntryShadow.stop();
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
