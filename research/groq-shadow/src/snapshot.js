'use strict';

const {INPUT_SCHEMA_VERSION, FROZEN_RULES, REASON_CODES, canonicalJson, sha256} = require('./constants');

const FEATURE_KEYS = [
  'btc_return_24h', 'eth_return_24h', 'linear_breadth',
  'btc_funding_rate', 'eth_funding_rate', 'btc_open_interest', 'eth_open_interest',
];
const FORBIDDEN_KEY = /(^|_)(outcome|realised|realized|pnl|profit|winner|exit|closed|forward|future)(_|$)/i;

function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function finite(v) { return typeof v === 'number' && Number.isFinite(v); }
function nonempty(v) { return typeof v === 'string' && v.trim().length > 0; }
function utcMs(v) {
  if (!nonempty(v) || !/^\d{4}-\d{2}-\d{2}T/.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}
function pathExists(root, path) {
  let cur = root;
  for (const part of String(path).split('.')) {
    if (!isObject(cur) && !Array.isArray(cur)) return false;
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return false;
    cur = cur[part];
  }
  return cur !== undefined;
}
function scanForbidden(value, path = '', found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbidden(item, `${path}[${index}]`, found));
  } else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (FORBIDDEN_KEY.test(key)) found.push(childPath);
      scanForbidden(child, childPath, found);
    }
  }
  return found;
}

function validateSnapshot(snapshot, nowMs = Date.now()) {
  const errors = [], abstain = [];
  if (!isObject(snapshot)) return {valid:false, errors:['snapshot:not_object'], abstainReasons:[]};
  if (snapshot.schema_version !== INPUT_SCHEMA_VERSION) errors.push('schema_version:unsupported');
  if (!nonempty(snapshot.candidate_id)) errors.push('candidate_id:missing');
  if (snapshot.engine !== 'NEW_ORAYAN') errors.push('engine:not_new_orayan');
  if (!nonempty(snapshot.symbol)) errors.push('symbol:missing');
  if (!['BUY', 'SELL'].includes(snapshot.side)) errors.push('side:invalid');
  const birthMs = utcMs(snapshot.candidate_birth_at_utc);
  if (birthMs == null) errors.push('candidate_birth_at_utc:invalid');
  else if (birthMs > nowMs + 5000) errors.push('candidate_birth_at_utc:future');

  const forbidden = scanForbidden(snapshot);
  if (forbidden.length) errors.push(...forbidden.map(key => `future_leakage_key:${key}`));

  if (!isObject(snapshot.regime) || !nonempty(snapshot.regime.label)) abstain.push('regime.label');
  if (!finite(snapshot.regime?.strength)) abstain.push('regime.strength');
  if (snapshot.regime?.status !== 'OK') abstain.push('regime.status');
  if (!finite(snapshot.regime?.age_seconds) || snapshot.regime.age_seconds < 0 || snapshot.regime.age_seconds > 1200) abstain.push('regime.age_seconds');
  const regimeAvailableMs=utcMs(snapshot.regime?.available_to_system_at_utc);
  if(regimeAvailableMs==null)abstain.push('regime.available_to_system_at_utc');
  else if(birthMs!=null&&regimeAvailableMs>birthMs)errors.push('future_leakage_time:regime.available_to_system_at_utc');

  const plan = snapshot.planned_trade;
  for (const key of ['entry', 'sl', 'tp', 'rr', 'planned_risk_usdt', 'planned_heat_usdt']) {
    if (!finite(plan?.[key])) abstain.push(`planned_trade.${key}`);
  }
  if (finite(plan?.entry) && finite(plan?.sl) && plan.entry === plan.sl) abstain.push('planned_trade.stop_distance');
  if (!finite(plan?.stop_distance_pct) && !finite(plan?.stop_atr_multiple)) {
    abstain.push('planned_trade.normalized_stop_distance');
  }

  const quote = plan?.quote_evidence;
  if (quote?.available !== true) abstain.push('planned_trade.quote_evidence.available');
  for (const key of ['bid', 'ask', 'mark']) if (!finite(quote?.[key])) abstain.push(`planned_trade.quote_evidence.${key}`);
  if (!finite(quote?.age_seconds) || quote.age_seconds < 0 || quote.age_seconds > 15) {
    abstain.push('planned_trade.quote_evidence.age_seconds');
  }
  const quoteMs=utcMs(quote?.exchange_timestamp_utc);
  const localQuoteMs=utcMs(quote?.observed_at_utc);
  if(quoteMs==null){
    // Bybit's ticker payload does not include a per-quote exchange timestamp. Accept a fresh,
    // explicit local receipt only when the unsupported exchange timestamp is disclosed; never
    // backfill or mislabel the local clock as exchange time.
    if(quote?.exchange_timestamp_status!=='UNAVAILABLE_BYBIT_TICKER_PAYLOAD')
      abstain.push('planned_trade.quote_evidence.exchange_timestamp_status');
    if(localQuoteMs==null)abstain.push('planned_trade.quote_evidence.observed_at_utc');
    else if(birthMs!=null&&localQuoteMs>birthMs)errors.push('future_leakage_time:planned_trade.quote_evidence.observed_at_utc');
  } else if(birthMs!=null&&quoteMs>birthMs)errors.push('future_leakage_time:planned_trade.quote_evidence.exchange_timestamp_utc');

  const exposure = snapshot.exposure;
  for (const key of ['open_positions_total', 'same_side_count', 'same_side_regime_count', 'same_side_regime_heat_usdt']) {
    if (!finite(exposure?.[key]) || exposure[key] < 0) abstain.push(`exposure.${key}`);
  }
  if(!finite(exposure?.age_seconds)||exposure.age_seconds<0||exposure.age_seconds>60)abstain.push('exposure.age_seconds');
  const exposureMs=utcMs(exposure?.observed_at_utc);
  if(exposureMs==null)abstain.push('exposure.observed_at_utc');
  else if(birthMs!=null&&exposureMs>birthMs)errors.push('future_leakage_time:exposure.observed_at_utc');

  if (snapshot.h1?.version !== FROZEN_RULES.h1.version) errors.push('h1.version:not_frozen_v1');
  if (!['RETAIN', 'SKIP', 'ABSTAIN'].includes(snapshot.h1?.state)) abstain.push('h1.state');
  if (snapshot.h1?.state === 'ABSTAIN') abstain.push(...(snapshot.h1.abstain_reasons || ['h1.abstained']).map(x => `h1:${x}`));
  if (snapshot.h2?.version !== FROZEN_RULES.h2.version) errors.push('h2.version:not_frozen_v1');
  if (!['RETAIN', 'SKIP', 'ABSTAIN'].includes(snapshot.h2?.state)) abstain.push('h2.state');
  if (snapshot.h2?.state === 'ABSTAIN') abstain.push(...(snapshot.h2.abstain_reasons || ['h2.abstained']).map(x => `h2:${x}`));

  const features = snapshot.h2?.features;
  for (const key of FEATURE_KEYS) {
    const feature = features?.[key];
    if (!isObject(feature)) { abstain.push(`h2.features.${key}`); continue; }
    if (feature.status !== 'OK') abstain.push(`h2.features.${key}.status`);
    if (!finite(feature.current)) abstain.push(`h2.features.${key}.current`);
    if (!finite(feature.baseline)) abstain.push(`h2.features.${key}.baseline`);
    if (!finite(feature.delta)) abstain.push(`h2.features.${key}.delta`);
    if (!finite(feature.age_seconds) || feature.age_seconds < 0 || feature.age_seconds > 1200) {
      abstain.push(`h2.features.${key}.age_seconds`);
    }
    const observedMs = utcMs(feature.observed_at_utc);
    const availableMs = utcMs(feature.available_to_system_at_utc);
    if (observedMs == null) abstain.push(`h2.features.${key}.observed_at_utc`);
    if (availableMs == null) abstain.push(`h2.features.${key}.available_to_system_at_utc`);
    if (birthMs != null && observedMs != null && observedMs > birthMs) errors.push(`future_leakage_time:h2.features.${key}.observed_at_utc`);
    if (birthMs != null && availableMs != null && availableMs > birthMs) errors.push(`future_leakage_time:h2.features.${key}.available_to_system_at_utc`);
    const baselineMs=utcMs(feature.baseline_observed_at_utc);
    if(baselineMs==null)abstain.push(`h2.features.${key}.baseline_observed_at_utc`);
    else if(observedMs!=null){
      const gapMinutes=(observedMs-baselineMs)/60000;
      if(gapMinutes<5||gapMinutes>20)abstain.push(`h2.features.${key}.baseline_gap_minutes`);
    }
  }
  if (!finite(features?.linear_breadth?.sample_size) || features.linear_breadth.sample_size <= 0) {
    abstain.push('h2.features.linear_breadth.sample_size');
  }
  if(!finite(snapshot.score?.value))abstain.push('score.value');
  if(!finite(snapshot.score?.rr))abstain.push('score.rr');
  if(!Array.isArray(snapshot.reason_flags))abstain.push('reason_flags');
  if(!Array.isArray(snapshot.risk_flags))abstain.push('risk_flags');

  if (!Array.isArray(snapshot.sources) || !snapshot.sources.length) abstain.push('sources');
  else snapshot.sources.forEach((source, index) => {
    if (source?.status !== 'OK') abstain.push(`sources.${index}.status`);
    if (!finite(source?.age_seconds) || source.age_seconds < 0) abstain.push(`sources.${index}.age_seconds`);
    const availableMs = utcMs(source?.available_to_system_at_utc);
    if (availableMs == null) abstain.push(`sources.${index}.available_to_system_at_utc`);
    else if (birthMs != null && availableMs > birthMs) errors.push(`future_leakage_time:sources.${index}.available_to_system_at_utc`);
  });

  return {valid:errors.length === 0, errors:[...new Set(errors)].sort(), abstainReasons:[...new Set(abstain)].sort()};
}

function compactSnapshot(snapshot) {
  const clean = JSON.parse(canonicalJson(snapshot));
  return {snapshot:clean, inputHash:sha256(canonicalJson(clean))};
}

function validateDecision(decision, snapshot) {
  const errors = [];
  if (!isObject(decision)) return ['decision:not_object'];
  if (!['RETAIN','SKIP','ABSTAIN'].includes(decision.decision)) errors.push('decision:invalid');
  if (!['LOW','MEDIUM','HIGH','UNKNOWN'].includes(decision.risk_level)) errors.push('risk_level:invalid');
  if (!finite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1) errors.push('confidence:invalid');
  for (const key of ['reason_codes','reason_notes','evidence_keys','missing_or_stale']) {
    if (!Array.isArray(decision[key])) errors.push(`${key}:invalid`);
  }
  if(Array.isArray(decision.reason_codes)){
    if(!decision.reason_codes.length)errors.push('reason_codes:empty');
    if(decision.reason_codes.length>6)errors.push('reason_codes:too_many');
    if(decision.reason_codes.some(code=>!REASON_CODES.includes(code)))errors.push('reason_codes:invalid_value');
  }
  for(const key of ['reason_notes','evidence_keys','missing_or_stale'])if(Array.isArray(decision[key])){
    if(decision[key].length>(key==='reason_notes'?6:8))errors.push(`${key}:too_many`);
    if(decision[key].some(value=>typeof value!=='string'||!value.length||value.length>96))errors.push(`${key}:invalid_value`);
  }
  if (!nonempty(decision.rationale_short) || decision.rationale_short.length > 240) errors.push('rationale_short:invalid');
  if (Array.isArray(decision.evidence_keys)) {
    for (const key of decision.evidence_keys) if (!pathExists(snapshot, key)) errors.push(`evidence_key:not_in_input:${key}`);
  }
  if (decision.decision === 'ABSTAIN' && (!Array.isArray(decision.missing_or_stale) || !decision.missing_or_stale.length)) {
    errors.push('abstain:missing_reason_required');
  }
  if (decision.decision !== 'ABSTAIN' && Array.isArray(decision.missing_or_stale) && decision.missing_or_stale.length) {
    errors.push('non_abstain:missing_or_stale_not_empty');
  }
  return errors;
}

function normalizeDecision(decision) {
  if (!isObject(decision) || !Array.isArray(decision.reason_codes)) return {decision, normalization:null};
  const unknown = [...new Set(decision.reason_codes.filter(code => !REASON_CODES.includes(code)))];
  if (!unknown.length) return {decision, normalization:null};
  const known = decision.reason_codes.filter(code => REASON_CODES.includes(code));
  const normalizedCodes = [...new Set([...known, 'OTHER_MODEL_REASON'])].slice(0,6);
  const notes = Array.isArray(decision.reason_notes) ? decision.reason_notes.slice(0,6) : [];
  return {
    decision:{...decision,reason_codes:normalizedCodes,reason_notes:notes},
    normalization:{applied:true,kind:'UNKNOWN_REASON_CODE',unknown_reason_codes:unknown.slice(0,6).map(code=>String(code).slice(0,48))},
  };
}

module.exports = {FEATURE_KEYS, validateSnapshot, compactSnapshot, validateDecision, normalizeDecision, pathExists};
