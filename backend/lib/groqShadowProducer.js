'use strict';
const minimal=require('./minimalCapture');


// Research-only adapter between the canonical prospective candidate-birth journal and the
// frozen Groq sidecar. Nothing returned by this module is consumed by gates or execution.
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const store = require('./store');
const groqShadowExport = require('./groqShadowExport');
const { appendImmutableAsync, readRecords, ledgerIndex } = require('../../research/groq-shadow/src/ledger');
const { advise, BoundedShadowQueue, configFromEnv } = require('../../research/groq-shadow/src/advisor');
const { FROZEN_RULES, INPUT_SCHEMA_VERSION, DEFAULT_MODEL, canonicalJson, sha256 } = require('../../research/groq-shadow/src/constants');

const AUDIT_SCHEMA = 'ORAYAN_GROQ_SNAPSHOT_AUDIT_V1';
const MAX_ENV_POINTS = 64;
const MAX_SEEN = 4096;
const environment = [];
const seenBirths = new Set();
let runtime = null;
let runtimeConfigKey = null;
let testTransport = null;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function iso(ms) { return Number.isFinite(Number(ms)) ? new Date(Number(ms)).toISOString() : null; }
function regimeLabel(value) {
  return typeof value === 'string' ? value : value?.regime || value?.label || 'UNKNOWN';
}
function withinDataRoot(candidate) {
  const root = path.resolve(store.DATA_DIR);
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function config(env = process.env) {
  const resolved = groqShadowExport.ledgerPath({ env, dataRoot: store.DATA_DIR }).candidate;
  const result = configFromEnv({ ...env, GROQ_SHADOW_LEDGER: resolved });
  const audit = env.GROQ_SHADOW_SNAPSHOT_LOG
    ? path.resolve(env.GROQ_SHADOW_SNAPSHOT_LOG)
    : path.join(path.dirname(resolved), 'candidate-snapshots.jsonl');
  if (!withinDataRoot(audit)) {
    const error = new Error('Groq shadow snapshot audit is not within the persistent data directory.');
    error.code = 'GROQ_SHADOW_SNAPSHOT_OUTSIDE_DATA_ROOT';
    throw error;
  }
  return { ...result, snapshotAudit: audit, allowedRoot: store.DATA_DIR };
}

function pointFeature(value, observedAt, availableAt, sampleSize) {
  return { value: finite(value), observedAt: finite(observedAt), availableAt: finite(availableAt), sampleSize: finite(sampleSize) };
}

function observeEnvironment({ at = Date.now(), marketSnapshot, tickers = [] } = {}) {
  const bySymbol = new Map((Array.isArray(tickers) ? tickers : []).map(ticker => [ticker.symbol, ticker]));
  const btc = bySymbol.get('BTCUSDT') || {};
  const eth = bySymbol.get('ETHUSDT') || {};
  const point = {
    at,
    btc_return_24h: pointFeature(btc.change24hPct, btc.observedAt, at),
    eth_return_24h: pointFeature(eth.change24hPct, eth.observedAt, at),
    linear_breadth: pointFeature(marketSnapshot?.directionalBreadth, marketSnapshot?.observedAt, at, marketSnapshot?.universeCount),
    btc_funding_rate: pointFeature(btc.fundingRate, btc.observedAt, at),
    eth_funding_rate: pointFeature(eth.fundingRate, eth.observedAt, at),
    btc_open_interest: pointFeature(btc.openInterest, btc.observedAt, at),
    eth_open_interest: pointFeature(eth.openInterest, eth.observedAt, at),
  };
  environment.push(point);
  while (environment.length > MAX_ENV_POINTS) environment.shift();
  return point;
}

function baselineFor(at) {
  return environment
    .filter(point => at - point.at >= 5 * 60000 && at - point.at <= 20 * 60000)
    .sort((a, b) => Math.abs((at - a.at) - 10 * 60000) - Math.abs((at - b.at) - 10 * 60000))[0] || null;
}

function h2Feature(name, current, baseline, birthAt) {
  const ageSeconds = current?.observedAt == null ? null : Math.max(0, (birthAt - current.observedAt) / 1000);
  const value = current?.value ?? null;
  const base = baseline?.value ?? null;
  const status = value != null && base != null && current?.observedAt <= birthAt && current?.availableAt <= birthAt
    ? 'OK' : 'NOT_AVAILABLE';
  return {
    current: value,
    baseline: base,
    delta: value != null && base != null ? value - base : null,
    observed_at_utc: iso(current?.observedAt),
    baseline_observed_at_utc: iso(baseline?.observedAt),
    available_to_system_at_utc: iso(current?.availableAt),
    age_seconds: ageSeconds,
    status,
    ...(name === 'linear_breadth' ? { sample_size: current?.sampleSize ?? null } : {}),
  };
}

function h2Decision(features, side) {
  const sign = side === 'SELL' ? -1 : 1;
  const missing = Object.entries(features)
    .filter(([, feature]) => feature.status !== 'OK' || feature.age_seconds == null || feature.age_seconds > 1200)
    .map(([name]) => name);
  if (missing.length) return { state: 'ABSTAIN', alerts: [], abstain_reasons: missing.map(name => `${name}:missing_or_stale`) };
  const alerts = [];
  for (const name of ['btc_return_24h', 'eth_return_24h', 'linear_breadth']) {
    if (sign * features[name].delta < 0) alerts.push(`${name}:directional_deterioration`);
  }
  for (const name of ['btc_funding_rate', 'eth_funding_rate']) {
    if (sign * features[name].delta > 0) alerts.push(`${name}:same_side_crowding_increase`);
  }
  for (const name of ['btc_open_interest', 'eth_open_interest']) {
    if (features[name].delta < 0) alerts.push(`${name}:open_interest_decline`);
  }
  const priceOrBreadth = alerts.some(alert => /return|breadth/.test(alert));
  const fundingOrOi = alerts.some(alert => /funding|open_interest/.test(alert));
  return {
    state: alerts.length >= FROZEN_RULES.h2.min_alerts && priceOrBreadth && fundingOrOi ? 'SKIP' : 'RETAIN',
    alerts,
    abstain_reasons: [],
  };
}

function buildSnapshot(signal, birth, context = {}) {
  const birthAt = finite(birth?.at ?? birth?.decisionAt ?? context.scanAt) || Date.now();
  const current = environment.at(-1) || null;
  const baseline = baselineFor(birthAt);
  const featureNames = ['btc_return_24h', 'eth_return_24h', 'linear_breadth', 'btc_funding_rate',
    'eth_funding_rate', 'btc_open_interest', 'eth_open_interest'];
  const features = Object.fromEntries(featureNames.map(name => [name, h2Feature(name, current?.[name], baseline?.[name], birthAt)]));
  const h2 = h2Decision(features, signal.side);
  const active = Array.isArray(context.openPositions) ? context.openPositions : [];
  const label = regimeLabel(context.btcRegime || signal.btcRegime);
  const sameSide = active.filter(trade => trade.side === signal.side);
  const sameRegime = sameSide.filter(trade => regimeLabel(trade.btcRegime) === label);
  const existingHeat = sameRegime.reduce((sum, trade) => sum + (finite(trade.plannedRisk) || 0), 0);
  const plannedRisk = finite(context.settings?.riskUsdtPerTrade);
  const plannedHeat = plannedRisk == null ? null : existingHeat + plannedRisk;
  const postCount = sameRegime.length + 1;
  const h1Reasons = [];
  const h1Missing = [];
  if (label === 'UNKNOWN') h1Missing.push('regime:missing');
  if (plannedRisk == null) h1Missing.push('planned_risk_usdt:missing');
  if (postCount >= FROZEN_RULES.h1.skip_if_post_count_gte) h1Reasons.push('POST_DIRECTION_REGIME_COUNT_LIMIT');
  if (plannedHeat != null && plannedHeat >= FROZEN_RULES.h1.skip_if_post_heat_usdt_gte) h1Reasons.push('POST_DIRECTION_REGIME_HEAT_LIMIT');
  const regimeObservedAt = finite(context.btcRegime?.observedAt);
  const quoteObservedAt = finite(context.ticker?.observedAt);
  const entry = finite(signal.entry), sl = finite(signal.sl), tp = finite(signal.tp);
  const stopDistance = entry != null && sl != null ? Math.abs(entry - sl) : null;
  const stopPct = entry > 0 && stopDistance != null ? 100 * stopDistance / entry : null;
  const quoteComplete = ['bid', 'ask', 'markPrice'].every(key => finite(context.ticker?.[key]) != null);
  const sources = [
    { name: 'new_orayan_birth', status: 'OK', available_to_system_at_utc: iso(birthAt), age_seconds: 0 },
    { name: 'market_environment_scan', status: current ? 'OK' : 'NOT_AVAILABLE',
      available_to_system_at_utc: iso(current?.at), age_seconds: current ? Math.max(0, (birthAt - current.at) / 1000) : null },
  ];
  return {
    schema_version: INPUT_SCHEMA_VERSION,
    candidate_id: signal.id,
    candidate_episode_id: birth?.episodeId || null,
    candidate_birth_at_utc: iso(birthAt),
    engine: 'NEW_ORAYAN',
    symbol: signal.symbol,
    side: signal.side,
    regime: {
      label,
      strength: finite(context.btcRegime?.strength),
      status: label !== 'UNKNOWN' && regimeObservedAt != null ? 'OK' : 'NOT_AVAILABLE',
      age_seconds: regimeObservedAt == null ? null : Math.max(0, (birthAt - regimeObservedAt) / 1000),
      observed_at_utc: iso(regimeObservedAt),
      available_to_system_at_utc: iso(regimeObservedAt),
    },
    planned_trade: {
      entry, sl, tp, rr: finite(signal.rr ?? birth?.grossTargetR),
      planned_risk_usdt: plannedRisk,
      planned_heat_usdt: plannedHeat,
      stop_distance_pct: stopPct,
      stop_atr_multiple: finite(signal.atr) > 0 && stopDistance != null ? stopDistance / finite(signal.atr) : null,
      quote_evidence: {
        available: quoteComplete && quoteObservedAt != null,
        status: quoteComplete && quoteObservedAt != null ? 'LOCAL_RECEIPT_ONLY' : 'NOT_AVAILABLE',
        bid: finite(context.ticker?.bid), ask: finite(context.ticker?.ask), mark: finite(context.ticker?.markPrice),
        observed_at_utc: iso(quoteObservedAt),
        available_to_system_at_utc: iso(quoteObservedAt),
        exchange_timestamp_utc: null,
        exchange_timestamp_status: 'UNAVAILABLE_BYBIT_TICKER_PAYLOAD',
        age_seconds: quoteObservedAt == null ? null : Math.max(0, (birthAt - quoteObservedAt) / 1000),
      },
    },
    exposure: {
      open_positions_total: active.length,
      same_side_count: sameSide.length,
      same_side_regime_count: sameRegime.length,
      same_side_regime_heat_usdt: existingHeat,
      observed_at_utc: iso(birthAt), age_seconds: 0,
    },
    h1: { version: FROZEN_RULES.h1.version,
      state: h1Missing.length ? 'ABSTAIN' : h1Reasons.length ? 'SKIP' : 'RETAIN',
      reason_codes: h1Reasons, abstain_reasons: h1Missing },
    h2: { version: FROZEN_RULES.h2.version, ...h2, features },
    score: { value: finite(signal.score), rr: finite(signal.rr ?? birth?.grossTargetR) },
    reason_flags: [signal.signalSource, signal.structureEvent, signal.entryPath].filter(Boolean),
    risk_flags: [...new Set([...(signal.gates?.failed || []), ...(h1Reasons || [])])],
    sources,
  };
}

async function appendAudit(cfg, record) {
  await appendImmutableAsync(cfg.snapshotAudit,
    { audit_schema_version: AUDIT_SCHEMA, recorded_at_utc: new Date().toISOString(), ...record },
    { allowedRoot:cfg.allowedRoot });
}

function handoffId(snapshot) {
  return sha256(`${snapshot.candidate_episode_id || ''}|${snapshot.candidate_id}|${canonicalJson(snapshot)}`);
}

class DurableShadowRuntime {
  constructor(cfg) {
    this.cfg = cfg;
    this.reserved = 0;
    this.recoveryOwned = new Set();
    this.recoveryDone = false;
    this.queue = new BoundedShadowQueue({maxSize:cfg.maxQueue,worker:item=>this.process(item)});
    this.ready = this.recover().finally(()=>{this.recoveryDone=true;});
  }

  reserve() {
    if (this.reserved >= this.cfg.maxQueue) return false;
    this.reserved += 1;
    return true;
  }

  async process(item) {
    const {id,snapshot} = item;
    await appendAudit(this.cfg,{record_type:'PROCESSING_EVENT',handoff_id:id,
      candidate_id:snapshot.candidate_id,processing_status:'PROCESSING'});
    let result;
    if (!this.cfg.allowLive) result={status:'LIVE_DISABLED',persisted:false};
    else {
      do {
        result=await advise(snapshot,{config:this.cfg,mode:testTransport?'mock':'live',
          ...(testTransport?{mockTransport:testTransport}:{})});
        if (result?.status === 'BUDGET_DEFERRED') {
          const waitMs=Math.max(25,Date.parse(result.defer_until_utc)-Date.now());
          await new Promise(resolve=>setTimeout(resolve,waitMs));
        }
      } while (result?.status === 'BUDGET_DEFERRED');
    }
    await appendAudit(this.cfg,{record_type:'PROCESSING_EVENT',handoff_id:id,
      candidate_id:snapshot.candidate_id,processing_status:result?.status || 'COMPLETED'});
    return result;
  }

  async recover() {
    const outstanding = new Map();
    await readRecords(this.cfg.snapshotAudit,row=>{
      if (!row.handoff_id) return;
      if (row.record_type === 'CANDIDATE_SNAPSHOT' && row.processing_status === 'QUEUED' && row.snapshot) {
        outstanding.set(row.handoff_id,{id:row.handoff_id,snapshot:row.snapshot});
      } else if (row.record_type === 'PROCESSING_EVENT' && row.processing_status !== 'PROCESSING') {
        outstanding.delete(row.handoff_id);
      }
    });
    for (const item of outstanding.values()) {
      this.recoveryOwned.add(item.id);
      try { await this.queue.enqueue(item); }
      catch (error) {
        logger.warn('groq-shadow','Recovered snapshot remains queued for a later restart',
          {candidateId:item.snapshot.candidate_id,code:error.code,error:error.message});
      }
    }
    return {recovered:outstanding.size};
  }

  async accept(snapshot) {
    const id = handoffId(snapshot);
    const appendedDuringRecovery=!this.recoveryDone;
    try {
      // The fsync is asynchronous: durable evidence reaches disk before in-memory pending work,
      // without blocking the trading call stack or keeping an unbounded prequeue in memory.
      await appendAudit(this.cfg,{record_type:'CANDIDATE_SNAPSHOT',handoff_id:id,
        candidate_id:snapshot.candidate_id,processing_status:'QUEUED',snapshot});
      await this.ready;
      if (appendedDuringRecovery && this.recoveryOwned.has(id)) return {status:'RECOVERED_BY_STARTUP',persisted:true};
      return await this.queue.enqueue({id,snapshot});
    } finally { this.reserved=Math.max(0,this.reserved-1); }
  }
}

function getRuntime(cfg) {
  const key = [cfg.ledger,cfg.snapshotAudit,cfg.maxQueue,cfg.allowLive,cfg.model,cfg.maxOutputTokens,
    cfg.maxRequestsDay,cfg.maxTokensDay,cfg.maxRequestsMinute,cfg.maxTokensMinute,cfg.maxDeferAgeMs].join('|');
  if (runtime && runtimeConfigKey === key) return runtime;
  runtimeConfigKey = key;
  runtime = new DurableShadowRuntime(cfg);
  runtime.ready.catch(error=>logger.warn('groq-shadow','Startup recovery failed open',{code:error.code,error:error.message}));
  return runtime;
}

async function initialize(env = process.env) {
  const cfg=config(env);
  const [recovery] = await Promise.all([
    getRuntime(cfg).ready,
    ledgerIndex(cfg.ledger,Date.now(),{allowedRoot:cfg.allowedRoot}),
  ]);
  return recovery;
}

function observeBirth(signal, birth, context = {}) {
  if(minimal.enabled())return null;
  if (!birth || birth.kind !== 'candidate_birth' || birth.engine !== 'NEW_ORAYAN') return false;
  const dedupeKey = `${birth.episodeId || ''}|${signal.id}`;
  if (seenBirths.has(dedupeKey)) return false;
  seenBirths.add(dedupeKey);
  while (seenBirths.size > MAX_SEEN) seenBirths.delete(seenBirths.values().next().value);
  let cfg;
  try { cfg = config(); }
  catch (error) {
    logger.warn('groq-shadow', 'Groq shadow path configuration rejected', { code: error.code, error: error.message });
    return false;
  }
  const currentRuntime=getRuntime(cfg);
  if(!currentRuntime.reserve()) {
    logger.warn('groq-shadow','Durable shadow handoff capacity is full',{candidateId:signal.id});
    return false;
  }
  const snapshot = buildSnapshot(signal, birth, context);
  // Defer the durable append. The engine receives a boolean immediately; after this point the
  // snapshot is fsynced before it is allowed to enter pending work.
  setImmediate(() => {
    currentRuntime.accept(snapshot)
      .then(result => logger.info('groq-shadow', 'Shadow decision recorded', { candidateId: signal.id, status: result?.status }))
      .catch(error => {
        logger.warn('groq-shadow', 'Shadow evaluation failed open', { candidateId: signal.id, code: error.code, error: error.message });
      });
  });
  return true;
}

function statOrNull(file) {
  try { const stat = fs.statSync(file); return stat.isFile() ? { available: true, sizeBytes: stat.size,
    lastUpdatedAt: stat.mtime.toISOString() } : null; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function status(env = process.env) {
  const cfg = config(env);
  const audit = statOrNull(cfg.snapshotAudit);
  const state = await ledgerIndex(cfg.ledger,Date.now(),{allowedRoot:cfg.allowedRoot});
  return {
    enabled: cfg.allowLive,
    model: cfg.model || DEFAULT_MODEL,
    queueDepth: runtime ? runtime.queue.pending.length + (runtime.queue.active ? 1 : 0) : 0,
    snapshotAuditAvailable: !!audit,
    snapshotAuditSizeBytes: audit?.sizeBytes || 0,
    snapshotAuditLastUpdatedAt: audit?.lastUpdatedAt || null,
    summary:state.state(Date.now()).summary,
  };
}

module.exports = { observeEnvironment, observeBirth, buildSnapshot, status, config, initialize,
  _test: { environment, baselineFor, h2Decision, withinDataRoot, handoffId,
    setTransport:value=>{testTransport=value;}, getRuntime,
    reset: () => { environment.length = 0; seenBirths.clear(); runtime = null; runtimeConfigKey = null; testTransport = null; } } };
