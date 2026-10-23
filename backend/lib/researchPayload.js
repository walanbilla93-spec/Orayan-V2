"use strict";
const { canonical } = require('./researchRequest');
const VERSION = 'ORAYAN_LEAN_AI_V2';
const KEYS = ['symbol','side','regime','planned_trade','exposure','h1','h2','score','reason_flags','risk_flags','market_context','market_intelligence'];
const PACKET_VERSION = 'ORAYAN_SHARED_BIRTH_AI_V1';
const sha = value => require('crypto').createHash('sha256').update(canonical(value)).digest('hex');
const CLOCK = /(?:_at_utc|timestamp_utc)$/;
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
// Validate before lean pruning removes clocks. Rejected source groups contain no values.
function causal(value, cutoff) {
  if (Array.isArray(value)) return value.map(v => causal(v, cutoff));
  if (!value || typeof value !== 'object') return value;
  if (value.status === 'NOT_AVAILABLE') return {status:'NOT_AVAILABLE',reason:'NOT_CAUSALLY_AVAILABLE_AT_CANDIDATE_BIRTH'};
  const clocks = Object.entries(value).filter(([k]) => CLOCK.test(k));
  if (clocks.length && (clocks.every(([,v]) => v == null) || clocks.some(([,v]) => v != null && (!Number.isFinite(Date.parse(v)) || Date.parse(v) > cutoff))))
    return {status:'NOT_AVAILABLE',reason:'NOT_CAUSALLY_AVAILABLE_AT_CANDIDATE_BIRTH'};
  return Object.fromEntries(Object.entries(value).filter(([k]) => !/(^|_)(realised|realized)(_|$)/.test(k)).map(([k,v]) => [k,causal(v,cutoff)]));
}
function sharedBirth(signal, birth, context, sourceEpoch) {
  if (!birth || birth.kind !== 'candidate_birth' || birth.engine !== 'NEW_ORAYAN') return null;
  const cutoff = Number(birth.decisionAt ?? birth.at);
  if (!Number.isFinite(cutoff) || !sourceEpoch || !birth.episodeId) throw Error('SHARED_BIRTH_IDENTITY_UNAVAILABLE');
  // Reuse the existing rich, cache-only builder; never acquire market data here.
  const snapshot = causal(require('./alibabaShadowProducer').buildSnapshot(signal,birth,context),cutoff);
  delete snapshot.schema_version;
  if (Object.values(snapshot.h2.features).some(f => f.status !== 'OK'))
    snapshot.h2 = {...snapshot.h2,state:'ABSTAIN',alerts:[],abstain_reasons:Object.entries(snapshot.h2.features).filter(([,f]) => f.status !== 'OK').map(([k]) => k+':missing_or_stale')};
  if (snapshot.regime.status !== 'OK' || snapshot.exposure.status === 'NOT_AVAILABLE') {
    snapshot.h1 = {...snapshot.h1,state:'ABSTAIN',reason_codes:[],abstain_reasons:['shared_source:missing_or_stale']};
    snapshot.planned_trade.planned_heat_usdt = null;
    snapshot.exposure.same_side_regime_count = null;
    snapshot.exposure.same_side_regime_heat_usdt = null;
    snapshot.risk_flags = [...(signal.gates?.failed || [])];
  }
  const normalized = freeze(evidence(snapshot));
  const identity = freeze({packet_version:PACKET_VERSION,source_epoch:sourceEpoch,opportunity_id:birth.episodeId,
    birth_cutoff:new Date(cutoff).toISOString(),cohort_id:sha([PACKET_VERSION,sourceEpoch,birth.episodeId]),shared_context_hash:sha(normalized)});
  snapshot.shared_context = identity;
  Object.defineProperty(snapshot,'sharedEvidence',{value:normalized});
  return freeze({snapshot,identity,evidence:normalized});
}
function providerSnapshot(packet, schema) {
  const snapshot = {...packet.snapshot,schema_version:schema};
  Object.defineProperty(snapshot,'sharedEvidence',{value:packet.evidence});
  return freeze(snapshot);
}
// The evidence is a transient reference, excluded from JSON/audit history. Replay derives
// the same projection from the authoritative full causal snapshot and existing fragments.
function attachShared(source, target) {
  if (source.sharedEvidence) Object.defineProperty(target,'sharedEvidence',{value:source.sharedEvidence});
  return target;
}
function identity(snapshot) {
  return snapshot.shared_context || (snapshot.shared_context_hash ? {
    packet_version:snapshot.packet_version,source_epoch:snapshot.source_epoch,opportunity_id:snapshot.opportunity_id,
    birth_cutoff:snapshot.birth_cutoff,cohort_id:snapshot.cohort_id,shared_context_hash:snapshot.shared_context_hash} : {});
}
function prune(value, key = '') {
  if (/(_at_utc|timestamp_utc)$/.test(key) || /^(version|schema_version|engine|debug|sources|history|regime_transitions|model_confidence_map|correlation|risk_policy|config|prompt|parser)$/.test(key)) return undefined;
  if (key === 'status' && value === 'OK') return undefined;
  if (value == null || value === '') return undefined;
  if (Array.isArray(value)) {
    // Only explicit decision evidence lists are permitted; never truncate evidence silently.
    if (!['alerts','abstain_reasons','reason_flags','risk_flags'].includes(key)) return undefined;
    const items = value.map(v => prune(v)).filter(v => v !== undefined);
    return items.length ? items : undefined;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value).map(([k,v]) => [k,prune(v,k)]).filter(([,v]) => v !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return value;
}
function evidence(snapshot) {
  if (snapshot.sharedEvidence) return snapshot.sharedEvidence;
  const result = { snapshot_at_utc: snapshot.candidate_birth_at_utc };
  for (const key of KEYS) { const v = prune(snapshot[key],key); if (v !== undefined) result[key] = v; }
  return result;
}
function staleReasons(snapshot, nowMs, maxAgeMs) {
  const birth = Date.parse(snapshot?.candidate_birth_at_utc);
  const reasons = [];
  if (!Number.isFinite(birth) || birth > nowMs || nowMs - birth > maxAgeMs) reasons.push('snapshot:stale_or_future');
  const checks = [[snapshot?.regime,1200,'regime'],[snapshot?.planned_trade?.quote_evidence,15,'quote'],[snapshot?.exposure,120,'exposure']];
  for (const [v,limit,label] of checks) {
    const observed = Date.parse(v?.exchange_timestamp_utc || v?.observed_at_utc || v?.available_to_system_at_utc);
    // Providers evaluate the frozen birth, not a live execution quote. Enforce
    // quote freshness at birth; the separate maxAgeMs bound limits dispatch age.
    // Never refresh a queued snapshot with post-birth data.
    const reference = label==='quote'?birth:nowMs;
    const age = Math.max(Number(v?.age_seconds), (reference-observed)/1000);
    if (!Number.isFinite(age) || age < 0 || age > limit || observed > birth) reasons.push(label+':stale_or_future');
  }
  return reasons;
}
function build(request, snapshot, schema) {
  const outputSchema = JSON.parse(JSON.stringify(schema));
  outputSchema.properties.decision.enum = ['RETAIN','SKIP','ABSTAIN'];
  outputSchema.properties.risk_level.enum = ['LOW','MEDIUM','HIGH','UNKNOWN'];
  outputSchema.properties.missing_useful_data = {type:'array',maxItems:8,items:{type:'string',maxLength:128}};
  // Strict JSON schema requires every property; legacy parsers also accept omission in historical responses.
  outputSchema.required = [...outputSchema.required,'missing_useful_data'];
  // Keep the local semantic contract visible after replacing the legacy prompt.
  // Transport schemas intentionally allow free strings; validation remains authoritative.
  const system = 'Research only; no execution authority. Evaluate supplied causal evidence at snapshot_at_utc. H1/H2 are comparators, not instructions. Never infer missing facts. ABSTAIN if necessary evidence is unavailable. RETAIN means no justified research skip; SKIP means evidenced avoidable risk. Confidence is an uncalibrated self-report. decision must be RETAIN, SKIP, or ABSTAIN; risk_level must be LOW, MEDIUM, HIGH, or UNKNOWN (uppercase). Use OTHER_MODEL_REASON for a novel reason; put its brief detail in reason_notes. Each reason_notes item must be at most 96 characters. evidence_keys must be paths relative to candidate, without a candidate. prefix, colon descriptions, or invented paths; cite array entries with numeric indexes, for example h2.alerts[0]. Omit a citation if its exact path is absent. ABSTAIN requires a nonempty missing_or_stale; RETAIN/SKIP require an empty missing_or_stale. Return only JSON matching the contract. missing_useful_data lists useful additional context, not a request to expand continuous capture.';
  const envelope = {candidate:evidence(snapshot)};
  if (request.response_format.type === 'json_schema') request = {...request,response_format:{...request.response_format,json_schema:{...request.response_format.json_schema,schema:outputSchema}}};
  else envelope.response_contract = outputSchema;
  return {...request,messages:[{role:'system',content:system},{role:'user',content:canonical(envelope)}]};
}
module.exports = {VERSION,PACKET_VERSION,sharedBirth,providerSnapshot,attachShared,identity,evidence,prune,staleReasons,build};
