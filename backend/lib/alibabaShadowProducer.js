'use strict';
const minimal=require('./minimalCapture');


// Research-only adapter between the canonical prospective candidate-birth journal and the
// frozen Alibaba sidecar. Nothing returned by this module is consumed by gates or execution.
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const store = require('./store');
const alibabaShadowExport = require('./alibabaShadowExport');
const { appendImmutableAsync, readRecords, ledgerIndex } = require('../../research/alibaba-shadow/src/ledger');
const { advise, BoundedShadowQueue, configFromEnv } = require('../../research/alibaba-shadow/src/advisor');
const { FROZEN_RULES, INPUT_SCHEMA_VERSION, DEFAULT_MODEL, canonicalJson, sha256 } = require('../../research/alibaba-shadow/src/constants');
const {validateSnapshot}=require('../../research/alibaba-shadow/src/snapshot');
const {redact}=require('../../research/alibaba-shadow/src/security');

const AUDIT_SCHEMA = 'ORAYAN_ALIBABA_SNAPSHOT_AUDIT_V1';
const MAX_ENV_POINTS = 64;
const MAX_SEEN = 4096;
const environment = [];
const seenBirths = new Set();
let runtime = null;
let runtimeConfigKey = null;
let testTransport = null;

function finite(value) {
  if(value==null||value==='')return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function timeMs(value){const number=finite(value);if(number!=null)return number;const parsed=Date.parse(value||'');return Number.isFinite(parsed)?parsed:null;}
function iso(ms) { return ms!=null && Number.isFinite(Number(ms)) ? new Date(Number(ms)).toISOString() : null; }
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
  const resolved = alibabaShadowExport.ledgerPath({ env, dataRoot: store.DATA_DIR }).candidate;
  const result = configFromEnv({ ...env, ALIBABA_SHADOW_LEDGER: resolved });
  const audit = env.ALIBABA_SHADOW_SNAPSHOTS
    ? path.resolve(env.ALIBABA_SHADOW_SNAPSHOTS)
    : path.join(path.dirname(resolved), 'candidate-snapshots.jsonl');
  if (!withinDataRoot(audit)) {
    const error = new Error('Alibaba shadow snapshot audit is not within the persistent data directory.');
    error.code = 'ALIBABA_SHADOW_SNAPSHOT_OUTSIDE_DATA_ROOT';
    throw error;
  }
  return { ...result, snapshotAudit: audit, allowedRoot: store.DATA_DIR };
}

function pointFeature(value, observedAt, availableAt, sampleSize) {
  return { value: finite(value), observedAt: finite(observedAt), availableAt: finite(availableAt), sampleSize: finite(sampleSize) };
}

function compactMarketSnapshot(snapshot, availableAt=snapshot?.observedAt) {
  if(!snapshot)return null;
  return {market_snapshot_id:snapshot.marketSnapshotId||null,timeframe:snapshot.timeframe||null,
    breadth_current:finite(snapshot.directionalBreadth),breadth_momentum:finite(snapshot.breadthMomentum),
    sample_size:finite(snapshot.universeCount),coverage_pct:finite(snapshot.coveragePct),
    trend_up_pct:finite(snapshot.trendUpPct),trend_down_pct:finite(snapshot.trendDownPct),
    cross_sectional_dispersion:finite(snapshot.crossSectionalDispersion),
    directional_coherence:finite(snapshot.directionalCoherence),volatility_state:snapshot.volatilityState||'UNKNOWN',
    median_realised_vol_20:finite(snapshot.medianRealisedVol20),btc_return_1:finite(snapshot.btcReturn1),
    btc_return_3:finite(snapshot.btcReturn3),btc_realised_vol_20:finite(snapshot.btcRealisedVol20),
    btc_shock_z:finite(snapshot.btcShockZ),btc_shock_state:snapshot.btcShockState||'UNKNOWN',
    observed_at_utc:iso(finite(snapshot.observedAt)),available_to_system_at_utc:iso(finite(availableAt))};
}

function observeEnvironment({ at = Date.now(), marketSnapshot, tickers = [], btcRegime } = {}) {
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
    btc_return_short: pointFeature(marketSnapshot?.btcReturn1, marketSnapshot?.observedAt, at),
    btc_return_medium: pointFeature(marketSnapshot?.btcReturn3, marketSnapshot?.observedAt, at),
    regime:{label:regimeLabel(btcRegime||marketSnapshot?.btcRegime),strength:finite(btcRegime?.strength),
      observedAt:finite(btcRegime?.observedAt),availableAt:at},
    marketContext:compactMarketSnapshot(marketSnapshot,at),
  };
  environment.push(point);
  while (environment.length > MAX_ENV_POINTS) environment.shift();
  return point;
}

function causalOptional(value,birthAt,maxText=1200) {
  if(!value||typeof value!=='object')return {status:'UNAVAILABLE',reason:'NOT_PRESENT_AT_CANDIDATE_BIRTH'};
  const available=timeMs(value.availableAt??value.available_to_system_at??value.available_to_system_at_utc);
  const generated=timeMs(value.generatedAt??value.generated_at??value.generated_at_utc);
  if(available==null||available>birthAt||generated!=null&&generated>birthAt)
    return {status:'UNAVAILABLE',reason:'NOT_CAUSALLY_AVAILABLE_AT_CANDIDATE_BIRTH'};
  const text=typeof value.text==='string'?value.text.slice(0,maxText):null;
  return {status:'OK',available_to_system_at_utc:iso(available),generated_at_utc:iso(generated),
    observations:Array.isArray(value.observations)?value.observations.slice(0,8).map(x=>String(x).slice(0,240)):[],
    ...(text?{text}:{})};
}

function regimeTransitions(birthAt) {
  const points=environment.filter(point=>point.at<=birthAt&&point.regime?.label).slice(-12),out=[];
  for(let index=1;index<points.length;index+=1)if(points[index-1].regime.label!==points[index].regime.label)out.push({
    from:points[index-1].regime.label,to:points[index].regime.label,
    observed_at_utc:iso(points[index].regime.observedAt??points[index].at),
    available_to_system_at_utc:iso(points[index].regime.availableAt??points[index].at)});
  return out.slice(-4);
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
  const birthAt = finite(birth?.decisionAt ?? birth?.at ?? context.scanAt) || Date.now();
  const current = environment.findLast(point => point.at <= birthAt) || null;
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
  const candidateMarket=birth?.market||{};
  const currentMarket=current?.marketContext||null;
  const sources = [
    { name: 'new_orayan_birth', status: 'OK', available_to_system_at_utc: iso(birthAt), age_seconds: 0 },
    { name: 'market_environment_scan', status: current ? 'OK' : 'NOT_AVAILABLE',
      available_to_system_at_utc: iso(current?.at), age_seconds: current ? Math.max(0, (birthAt - current.at) / 1000) : null },
  ];
  return redact({
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
    regime_transitions:{status:environment.length?'OK':'UNAVAILABLE',items:regimeTransitions(birthAt)},
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
    market_context: {
      status:currentMarket?'OK':'UNAVAILABLE',
      current:currentMarket,
      breadth:{current:features.linear_breadth.current,baseline:features.linear_breadth.baseline,
        delta:features.linear_breadth.delta,sample_size:features.linear_breadth.sample_size,
        observed_at_utc:features.linear_breadth.observed_at_utc,
        available_to_system_at_utc:features.linear_breadth.available_to_system_at_utc},
      benchmark_returns:{
        btc_short:current?.btc_return_short?.value??null,btc_medium:current?.btc_return_medium?.value??null,
        btc_24h:features.btc_return_24h.current,eth_24h:features.eth_return_24h.current,
        observed_at_utc:features.btc_return_24h.observed_at_utc,
        available_to_system_at_utc:features.btc_return_24h.available_to_system_at_utc,
        eth_short:null,eth_medium:null,missing:['eth_short','eth_medium'],
      },
      funding:{btc:features.btc_funding_rate,eth:features.eth_funding_rate},
      open_interest:{btc:features.btc_open_interest,eth:features.eth_open_interest},
    },
    candidate_market:{
      status:quoteObservedAt!=null?'OK':'UNAVAILABLE',spread_pct:finite(candidateMarket.spreadPct??signal.market?.spreadPct),
      bid_size:finite(candidateMarket.bidSize),ask_size:finite(candidateMarket.askSize),
      top_of_book_imbalance:finite(candidateMarket.topOfBookImbalance),mark_index_basis_pct:finite(candidateMarket.markIndexBasisPct),
      funding_rate:finite(candidateMarket.fundingRate??context.ticker?.fundingRate),
      open_interest:finite(candidateMarket.openInterest??context.ticker?.openInterest),
      open_interest_change_pct:finite(candidateMarket.openInterestChangePct),change_24h_pct:finite(candidateMarket.change24hPct??context.ticker?.change24hPct),
      turnover_24h:finite(candidateMarket.turnover24h??context.ticker?.turnover24h),
      volatility:{atr:finite(signal.atr),atr_pct:finite(signal.atrPct),regime_strength:finite(context.btcRegime?.strength)},
      observed_at_utc:iso(quoteObservedAt),available_to_system_at_utc:iso(quoteObservedAt),
    },
    market_intelligence:causalOptional(context.marketIntelligence,birthAt),
    gemini_briefing:causalOptional(context.geminiBriefing,birthAt),
    score: { value: finite(signal.score), rr: finite(signal.rr ?? birth?.grossTargetR) },
    reason_flags: [signal.signalSource, signal.structureEvent, signal.entryPath].filter(Boolean),
    risk_flags: [...new Set([...(signal.gates?.failed || []), ...(h1Reasons || [])])],
    sources,
  });
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
    this.snapshotCount = 0;
    this.snapshotIds = new Set();
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
    if (!this.cfg.allowLive) result=await advise(snapshot,{config:this.cfg,mode:'live'});
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
        if(!this.snapshotIds.has(row.handoff_id)){this.snapshotIds.add(row.handoff_id);this.snapshotCount+=1;
          while(this.snapshotIds.size>MAX_SEEN)this.snapshotIds.delete(this.snapshotIds.values().next().value);}
        outstanding.set(row.handoff_id,{id:row.handoff_id,snapshot:row.snapshot});
      } else if (row.record_type === 'PROCESSING_EVENT' && row.processing_status !== 'PROCESSING') {
        outstanding.delete(row.handoff_id);
      }
    });
    for (const item of outstanding.values()) {
      this.recoveryOwned.add(item.id);
      try { await this.queue.enqueue(item); }
      catch (error) {
        logger.warn('alibaba-shadow','Recovered snapshot remains queued for a later restart',
          redact({candidateId:item.snapshot.candidate_id,code:error.code,error:error.message}));
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
      if(!this.snapshotIds.has(id)){this.snapshotIds.add(id);this.snapshotCount+=1;
        while(this.snapshotIds.size>MAX_SEEN)this.snapshotIds.delete(this.snapshotIds.values().next().value);}
      await this.ready;
      if (appendedDuringRecovery && this.recoveryOwned.has(id)) return {status:'RECOVERED_BY_STARTUP',persisted:true};
      return await this.queue.enqueue({id,snapshot});
    } finally { this.reserved=Math.max(0,this.reserved-1); }
  }
}

function getRuntime(cfg) {
  const key = [cfg.ledger,cfg.snapshotAudit,cfg.maxQueue,cfg.allowLive,cfg.model,cfg.maxOutputTokens,
    cfg.maxRequestsDay,cfg.maxTokensDay,cfg.maxCostUsdDay,cfg.maxRequestsMinute,cfg.maxTokensMinute,cfg.maxDeferAgeMs].join('|');
  if (runtime && runtimeConfigKey === key) return runtime;
  runtimeConfigKey = key;
  runtime = new DurableShadowRuntime(cfg);
  runtime.ready.catch(error=>logger.warn('alibaba-shadow','Startup recovery failed open',redact({code:error.code,error:error.message})));
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
    logger.warn('alibaba-shadow', 'Alibaba shadow path configuration rejected', redact({ code: error.code, error: error.message }));
    return false;
  }
  const currentRuntime=getRuntime(cfg);
  if(!currentRuntime.reserve()) {
    logger.warn('alibaba-shadow','Durable shadow handoff capacity is full',redact({candidateId:signal.id}));
    return false;
  }
  const snapshot = buildSnapshot(signal, birth, context);
  const check=validateSnapshot(snapshot,Date.now());
  if(!check.valid){
    currentRuntime.reserved=Math.max(0,currentRuntime.reserved-1);
    // Retain the rejection provenance, without persisting invalid/post-birth feature values.
    setImmediate(()=>appendAudit(cfg,{record_type:'SNAPSHOT_REJECTED',candidate_id:snapshot.candidate_id,
      processing_status:'INVALID_CAUSAL_SNAPSHOT',errors:check.errors})
      .catch(error=>logger.warn('alibaba-shadow','Snapshot rejection write failed',redact({code:error.code,error:error.message}))));
    return false;
  }
  // Defer the durable append. The engine receives a boolean immediately; after this point the
  // snapshot is fsynced before it is allowed to enter pending work.
  setImmediate(() => {
    currentRuntime.accept(snapshot)
      .then(result => logger.info('alibaba-shadow', 'Shadow decision recorded', redact({ candidateId: signal.id, status: result?.status })))
      .catch(error => {
        logger.warn('alibaba-shadow', 'Shadow evaluation failed open', redact({ candidateId: signal.id, code: error.code, error: error.message }));
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
    snapshots:runtime?.snapshotCount||0,
    snapshotAuditAvailable: !!audit,
    snapshotAuditSizeBytes: audit?.sizeBytes || 0,
    snapshotAuditLastUpdatedAt: audit?.lastUpdatedAt || null,
    summary:state.state(Date.now()).summary,
    budget:{dayUtc:state.day,requests:state.dayRequests,tokens:state.dayTokens,costUsd:state.dayCostUsd,
      maxRequests:cfg.maxRequestsDay,maxTokens:cfg.maxTokensDay,maxCostUsd:cfg.maxCostUsdDay},
    providerRequestsStarted:state.dayRequests,
    liveAllowed:cfg.allowLive,
  };
}

module.exports = { observeEnvironment, observeBirth, buildSnapshot, status, config, initialize,
  _test: { environment, baselineFor, h2Decision, withinDataRoot, handoffId,
    setTransport:value=>{testTransport=value;}, getRuntime,
    reset: () => { environment.length = 0; seenBirths.clear(); runtime = null; runtimeConfigKey = null; testTransport = null; } } };
