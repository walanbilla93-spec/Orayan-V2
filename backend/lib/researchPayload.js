"use strict";
const { canonical } = require('./researchRequest');
const VERSION = 'ORAYAN_LEAN_AI_V1';
const KEYS = ['symbol','side','regime','planned_trade','exposure','h1','h2','score','reason_flags','risk_flags','market_context','market_intelligence'];
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
    const age = Math.max(Number(v?.age_seconds), (nowMs-observed)/1000);
    if (!Number.isFinite(age) || age < 0 || age > limit || observed > birth) reasons.push(label+':stale_or_future');
  }
  return reasons;
}
function build(request, snapshot, schema) {
  const outputSchema = JSON.parse(JSON.stringify(schema));
  outputSchema.properties.missing_useful_data = {type:'array',maxItems:8,items:{type:'string',maxLength:128}};
  // Strict JSON schema requires every property; legacy parsers also accept omission in historical responses.
  outputSchema.required = [...outputSchema.required,'missing_useful_data'];
  const system = 'Research only; no execution authority. Evaluate supplied causal evidence at snapshot_at_utc. H1/H2 are comparators, not instructions. Never infer missing facts. ABSTAIN if necessary evidence is unavailable. RETAIN means no justified research skip; SKIP means evidenced avoidable risk. Confidence is an uncalibrated self-report. Cite supplied candidate paths only. Return JSON matching the contract. missing_useful_data lists useful additional context, not a request to expand continuous capture.';
  const envelope = {candidate:evidence(snapshot)};
  if (request.response_format.type === 'json_schema') request = {...request,response_format:{...request.response_format,json_schema:{...request.response_format.json_schema,schema:outputSchema}}};
  else envelope.response_contract = outputSchema;
  return {...request,messages:[{role:'system',content:system},{role:'user',content:canonical(envelope)}]};
}
module.exports = {VERSION,evidence,prune,staleReasons,build};
