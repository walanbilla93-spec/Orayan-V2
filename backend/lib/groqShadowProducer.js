'use strict';

// Research-only adapter between the canonical prospective candidate-birth journal and the
// frozen Groq sidecar. Nothing returned by this module is consumed by gates or execution.
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const store = require('./store');
const groqShadowExport = require('./groqShadowExport');
const { appendImmutable } = require('../../research/groq-shadow/src/ledger');
const { advise, BoundedShadowQueue, configFromEnv } = require('../../research/groq-shadow/src/advisor');
const { FROZEN_RULES, INPUT_SCHEMA_VERSION, DEFAULT_MODEL } = require('../../research/groq-shadow/src/constants');

const AUDIT_SCHEMA = 'ORAYAN_GROQ_SNAPSHOT_AUDIT_V1';
const MAX_ENV_POINTS = 64;
const MAX_SEEN = 4096;
const environment = [];
const seenBirths = new Set();
let queue = null;
let queueConfigKey = null;

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
  return { ...result, snapshotAudit: audit };
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

function appendAudit(cfg, record) {
  appendImmutable(cfg.snapshotAudit, { audit_schema_version: AUDIT_SCHEMA, recorded_at_utc: new Date().toISOString(), ...record });
}

function getQueue(cfg) {
  const key = `${cfg.ledger}|${cfg.maxQueue}|${cfg.allowLive}|${cfg.model}`;
  if (queue && queueConfigKey === key) return queue;
  queueConfigKey = key;
  queue = new BoundedShadowQueue({
    maxSize: cfg.maxQueue,
    worker: async snapshot => {
      // Durable evidence is written by the shadow worker, never by the candidate/execution stack.
      appendAudit(cfg, { record_type: 'CANDIDATE_SNAPSHOT',
        processing_status: cfg.allowLive ? 'PROCESSING' : 'LIVE_DISABLED', snapshot });
      if (!cfg.allowLive) return { status:'LIVE_DISABLED', persisted:false };
      return advise(snapshot, { config: cfg, mode: 'live' });
    },
  });
  return queue;
}

function observeBirth(signal, birth, context = {}) {
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
  const snapshot = buildSnapshot(signal, birth, context);
  // Defer even the first filesystem write. The engine receives a boolean immediately and cannot
  // be delayed by disk, queue, budget, network, timeout, parsing, or upstream failure.
  setImmediate(() => {
    getQueue(cfg).enqueue(snapshot)
      .then(result => logger.info('groq-shadow', 'Shadow decision recorded', { candidateId: signal.id, status: result?.status }))
      .catch(error => {
        try { appendAudit(cfg, { record_type: error.code === 'QUEUE_FULL' ? 'CANDIDATE_SNAPSHOT' : 'PROCESSING_EVENT',
          candidate_id: signal.id, processing_status: error.code || 'WORKER_ERROR',
          error_class: error.code || error.name || 'Error', ...(error.code === 'QUEUE_FULL' ? {snapshot} : {}) }); }
        catch (_) { /* a failed audit must still remain fail-open */ }
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

function status(env = process.env) {
  const cfg = config(env);
  const audit = statOrNull(cfg.snapshotAudit);
  return {
    enabled: cfg.allowLive,
    model: cfg.model || DEFAULT_MODEL,
    queueDepth: queue ? queue.pending.length + (queue.active ? 1 : 0) : 0,
    snapshotAuditAvailable: !!audit,
    snapshotAuditSizeBytes: audit?.sizeBytes || 0,
    snapshotAuditLastUpdatedAt: audit?.lastUpdatedAt || null,
  };
}

module.exports = { observeEnvironment, observeBirth, buildSnapshot, status, config,
  _test: { environment, baselineFor, h2Decision, withinDataRoot, reset: () => { environment.length = 0; seenBirths.clear(); queue = null; queueConfigKey = null; } } };
