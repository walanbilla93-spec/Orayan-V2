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
const researchCapture = require('./researchCapture');
const researchSupplement = require('./researchSupplement');
const earlyEntryShadow = require('./earlyEntryShadow');
const groqShadowProducer = require('./groqShadowProducer');
const alibabaShadowProducer = require('./alibabaShadowProducer');
const v3Shadow = require('./v3Shadow');
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
  desiredRunning: false,
  stoppedAt: null,
  stopReason: null,
  startSource: null,
};

let trades = store.read('trades', []);
const captureSafety=store.read('captureSafetyClosed', {total:0,closed:[]});
function closedForSafety(){return [...captureSafety.closed.map(x=>({closedAt:x.closedAt,netPnl:x.netPnl})),...closedTrades()];}
// Retired evidence is loaded only for explicit historical reads, never on startup.
function historicalMarci() {
  const fs=require('fs'),file=require('path').join(store.DATA_DIR,'marciShadowTrades.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : [];
}
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


function persistedTradeRows() {
  // Unresolved live obligations must survive history trimming and process restart.
  const retained=trades.slice(0,-5000).filter(t=>t.mode==='live'&&t.privateOutcome);
  return [...retained,...trades.slice(-5000)];
}

function persistTrades() {
  const saved=store.write('trades',persistedTradeRows());
  if(captureSafety.total){const keep=Math.max(0,5000-trades.length),cutoff=Math.max(0,captureSafety.total-keep);
    store.write('captureSafetyClosed',{total:Math.min(captureSafety.total,keep),closed:captureSafety.closed.filter(x=>x.index>=cutoff).map(x=>({...x,index:x.index-cutoff}))},false);}
  return saved;
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
    const r = await executor.syncLiveTrades(trades, settings, persistTrades);
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
      const did = await executor.stepPaperTrade(t, settings, require('./researchExcursions').observeMinute);
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


async function scanOnce() {
  if (state.scanning) {
    logger.debug('engine', 'Scan already in progress, skipping this tick');
    return;
  }
  state.scanning = true;
  const t0 = Date.now();
  const settings = settingsMod.effective();

  try {
    if (require('./maintenance').fenced()) {
      await require('./maintenance').run('management', 'engine', async () => {
        await manageOpenTrades(settings);
        await v3Shadow.refreshManagementContext(settings, () => getBtcRegime(settings));
      });
      return;
    }
    if (Date.now()-lastStopRecoveryBackfillAt >= 3600000) {
      lastStopRecoveryBackfillAt = Date.now();
      for (const trade of closedTrades()) {
        try { researchSupplement.observeStop(trade,researchCapture.candidateLink(trade.signalId)||{}); }
        catch (e) { logger.warn('research','Stop recovery restore failed',{error:e.message}); }
      }
    }
    await manageOpenTrades(settings);

    if (require('./maintenance').fenced()) {
      await v3Shadow.refreshManagementContext(settings, () => getBtcRegime(settings));
      return;
    }

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
    const signalsForUi = [];
    const journalSignals = [];
    const orderResolved = new Set();

    const cb = risk.checkCircuitBreakers({ settings, state, closedTrades: closedForSafety() });
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
    // V3_BEGIN: one-way shadow observer on exactly the already-fetched V2 market data.
    try { v3Shadow.observeScan({scanAt,scanId,candlesBySymbol:researchCandles,tickerBySymbol,
      instruments,btcRegime,settings,signals:journalSignals,marketSnapshot}); }
    catch (e) { logger.warn('v3-shadow','Research capture failed',{error:e.message}); }
    // V3_END: no output is read by gates, ranking, sizing or execution.
    for (const signal of journalSignals) signal.marketSnapshotId = marketSnapshotId;
    // Observe the same already-fetched decision-time market state used by the prospective
    // journal. This is bounded in memory and has no network I/O or execution authority.
    try { groqShadowProducer.observeEnvironment({ at:scanAt, marketSnapshot, tickers }); }
    catch (e) { logger.warn('groq-shadow', 'Environment observation failed open', { error:e.message }); }
    try { alibabaShadowProducer.observeEnvironment({ at:Date.now(), marketSnapshot, tickers, btcRegime }); }
    catch (e) { logger.warn('alibaba-shadow', 'Environment observation failed open', { code:e.code }); }
    const btcObservation = marketObservations.find(x => x?.symbol === 'BTCUSDT');
    const r12s = marketObservations.filter(x => x?.symbol !== 'BTCUSDT' && Number.isFinite(x?.r12))
      .map(x => Math.log1p(x.r12)).sort((a,b) => a-b);
    const universeResearch = { r12Median:r12s.length ? r12s[Math.floor(r12s.length/2)] : null };
    for (const signal of journalSignals) {
      // One birth packet feeds Meta-Lite and both providers. Pure calculation is
      // embedded in the existing birth append: no extra I/O, queue or async work.
      let birth = null, sharedPacket = null;
      const birthContext = {scanAt,settings,marketSnapshot,
        ticker:tickerBySymbol.get(signal.symbol),btcRegime,
        openPositions:[...openTrades(),...pendingTrades()]};
      const birthResearch = row => {
        const minimal = require('./minimalCapture');
        if (!minimal.researchEnabled() || row.kind !== 'candidate_birth' || row.engine !== 'NEW_ORAYAN') return null;
        const epoch = minimal.current().state.epochId;
        try {
          sharedPacket = require('./researchPayload').sharedBirth(signal,row,birthContext,epoch);
        } catch (e) {
          logger.warn('research','Shared birth packet unavailable',{code:e.code,error:e.message});
          return require('./metaLite').unavailable(row,epoch);
        }
        try {
          const verdict = require('./metaLite').evaluate(sharedPacket);
          // One-way research observer; its output cannot change the frozen comparator.
          try { require('./metaBrainResearch').observeBirth(sharedPacket,verdict,signal.id); } catch (_) {}
          return verdict;
        }
        catch (e) {
          logger.warn('research','Meta-Lite evaluation censored',{code:e.code});
          return require('./metaLite').unavailable(row,epoch,'EVALUATOR_ERROR',sharedPacket);
        }
      };
      try { birth = researchCapture.birth(signal, { scanId, scanAt, ticker:tickerBySymbol.get(signal.symbol),
        candles:researchCandles.get(signal.symbol) || [], settings, snapshot:marketSnapshot,
        btc:{r12:btcObservation?.r12 == null ? null : Math.log1p(btcObservation.r12)}, universe:universeResearch,
        tickerDynamic:tickerResearch.get(signal.symbol), birthResearch }); }
      catch (e) { logger.warn('research', 'Birth capture failed', { error:e.message, symbol:signal.symbol }); }
      if (birth?.kind === 'candidate_birth' && birth.engine === 'NEW_ORAYAN' &&
          require('./minimalCapture').researchEnabled() && !sharedPacket)
        for (const provider of ['Groq','Alibaba']) require('./researchAI').notRequested(provider,birth,signal.id,'LOCAL_ABSTAIN_INPUT_UNAVAILABLE');
      // A shared-builder failure must never fall back to independent evidence in this cohort.
      if (!require('./minimalCapture').researchEnabled() || sharedPacket) {
        try { groqShadowProducer.observeBirth(signal,birth,{...birthContext,sharedPacket}); }
        catch (e) { logger.warn('groq-shadow', 'Candidate handoff failed open', { error:e.message, symbol:signal.symbol }); }
        try { alibabaShadowProducer.observeBirth(signal,birth,{...birthContext,sharedPacket}); }
        catch (e) { logger.warn('alibaba-shadow', 'Candidate handoff failed open', { code:e.code }); }
      }
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
        if (settings.mode==='live'&&executor.hasUnresolvedLiveOutcome(trades)) break;
        if (!require('./researchRuntime').canAdmit(settings.mode)) break;
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
        if (!require('./researchRuntime').canAdmit(settings.mode)) break;

        if (settings.mode === 'live') {
          trades.push(trade);
          try {
            await executor.placeLiveOrder({ trade, settings, instrument, trades, persist:persistTrades });
          } catch (e) {
            if (trade.privateOutcome||e.reasonCode==='UNKNOWN_PRIVATE_OUTCOME') {
              persistTrades();
              researchCapture.outcome(signal.id, 'UNKNOWN_PRIVATE_OUTCOME', trade, { reason:e.reasonCode });
              orderResolved.add(signal.id);
              logger.error('engine', `Live admission fenced for ${signal.symbol}; reconciliation required`, { reasonCode:e.reasonCode });
              break;
            }
            trades.splice(trades.indexOf(trade),1);
            persistTrades();
            const event=e.reasonCode==='PROVEN_PRIVATE_REJECTION'?'ORDER_REJECTED':'ORDER_NOT_SENT';
            researchCapture.outcome(signal.id, event, trade, { reason:e.message,reasonCode:e.reasonCode });
            orderResolved.add(signal.id);
            logger.error('engine', `Live order ${event==='ORDER_REJECTED'?'rejected':'not sent'} for ${signal.symbol}`, { error: e.message,reasonCode:e.reasonCode });
            continue;
          }
        }

        if (settings.mode!=='live') trades.push(trade);
        researchCapture.outcome(signal.id, 'ORDER_ACK', trade, { mode:settings.mode });
        orderResolved.add(signal.id);
        funnel.placed++;
        logger.info('engine',
          `${settings.mode === 'live' ? 'Live' : 'Paper'} order queued: ${signal.symbol} ${signal.side} score ${signal.score} qty ${sizing.qty}`);
      }
      if (funnel.placed) persistTrades();
    }

    for (const signal of journalSignals) {
      if (signal.gates?.passed && !orderResolved.has(signal.id)
        && signal.marciShadow?.passed !== false)
        researchCapture.outcome(signal.id, 'NO_ORDER', null,
          {reason:blockReason || (!settings.tradingEnabled || state.killSwitch ? 'TRADING_DISABLED_OR_KILL_SWITCH' : 'PORTFOLIO_OR_SLOT_LIMIT')});
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
    if (t.mode === 'live') {
      try {await executor.cancelLiveOrder({ trade: t, settings, persist:persistTrades });}
      catch(e) {errors.push(`${t.symbol}: ${e.message}`);continue;}
    }
    t.status = 'CANCELLED';
    t.closedAt = Date.now();
    t.closeReason = 'Cancelled by kill switch';
    t.netPnl = 0; t.grossPnl = 0; t.fees = 0;
    closed++;
  }

  for (const t of openTrades()) {
    try {
      if (t.mode === 'live') {
        await executor.closeLivePosition({ trade: t, settings, persist:persistTrades });
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
function shadowSummary() { return {runtime:'RETIRED',history:'READ_ONLY_ON_DEMAND'}; }

function getState() {
  const settings = settingsMod.effective();
  return {
    ...state,
    mode: settings.mode,
    testnet: settings.testnet,
    tradingEnabled: settings.tradingEnabled,
    researchCapture: require('./minimalCapture').enabled() ? require('./researchRuntime').status() : {enabled:false},
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
  let list = historicalMarci();
  if (status) list = list.filter((t) => t.status === status);
  return list.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

function resetShadowTrades() { return {ok:false,reason:'MARCI_HISTORY_READ_ONLY'}; }

function resetTrades() {
  if (executor.hasUnresolvedLiveOutcome(trades)) return {ok:false,reason:'Unresolved live mutation must be reconciled before clearing history'};
  trades = [];
  persistTrades();
  logger.warn('engine', 'Trade history cleared by operator');
  return { ok: true };
}

function clearLastSignals() {
  state.lastSignals = [];
  state.funnel = {};
  logger.warn('engine', 'Live signal list cleared by operator');
  return { ok: true };
}

// MAINTENANCE_CHECKPOINT_BEGIN: publish existing working state without changing RUN intent.
function maintenanceCheckpoint() {
  const path=require('path'),atomic=require('./researchStore').atomic;
  atomic(path.join(store.DATA_DIR,'trades.json'),persistedTradeRows());
  atomic(path.join(store.DATA_DIR,'engineControl.json'),engineControl);
  if(captureSafety.total) {
    const keep=Math.max(0,5000-trades.length),cutoff=Math.max(0,captureSafety.total-keep);
    atomic(path.join(store.DATA_DIR,'captureSafetyClosed.json'),{total:Math.min(captureSafety.total,keep),
      closed:captureSafety.closed.filter(x=>x.index>=cutoff).map(x=>({...x,index:x.index-cutoff}))});
  }
}
// MAINTENANCE_CHECKPOINT_END
module.exports = {
  maintenanceCheckpoint,
  start, stop, shouldAutoResume, scanOnce, panicClose, releaseKillSwitch, clearHalt,
  getState, getTrades, getShadowTrades, resetTrades, resetShadowTrades, clearLastSignals,
  summary, shadowSummary, state,
};
