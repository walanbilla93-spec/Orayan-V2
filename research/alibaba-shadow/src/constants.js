'use strict';

const crypto = require('crypto');

const SCHEMA_VERSION = 'ORAYAN_ALIBABA_SHADOW_RECORD_V1';
const INPUT_SCHEMA_VERSION = 'ORAYAN_ALIBABA_CANDIDATE_V1';
const PROMPT_VERSION = 'ORAYAN_ALIBABA_SHADOW_PROMPT_V1';
const PROMPT_VARIANT = 'RICH_CAUSAL_SNAPSHOT_V1';
const RESPONSE_SCHEMA_VERSION = 'ORAYAN_ALIBABA_SHADOW_RESPONSE_V1';
const DEFAULT_MODEL = 'qwen3.7-flash';
const DEFAULT_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';

const MODEL_PRICING_USD_PER_MILLION = Object.freeze({
  'qwen3.7-flash':Object.freeze({input:0.03,output:0.13}),
  'qwen3.7-flash-2026-07-15':Object.freeze({input:0.03,output:0.13}),
  'qwen3.7-plus':Object.freeze({input:0.4,output:1.6}),
  'qwen3.7-plus-2026-05-26':Object.freeze({input:0.4,output:1.6}),
  'qwen3.8-max':Object.freeze({input:2,output:6}),
  'qwen3.8-max-0902':Object.freeze({input:2,output:6}),
});

const REASON_CODES = Object.freeze([
  'EVIDENCE_COMPLETE','EVIDENCE_INCOMPLETE','DATA_MISSING','DATA_STALE','DATA_INCONSISTENT',
  'DIRECTIONAL_DETERIORATION','FUNDING_CROWDING','OPEN_INTEREST_DECLINE','EXPOSURE_CONCENTRATION',
  'REGIME_RISK','QUOTE_QUALITY_RISK','STOP_DISTANCE_RISK','VOLATILITY_RISK','MARKET_BREADTH_RISK',
  'RISK_ACCEPTABLE','MODEL_UNCERTAINTY','INSUFFICIENT_DECISION_TIME_EVIDENCE','OTHER_MODEL_REASON',
]);

const FROZEN_RULES = Object.freeze({
  h1:Object.freeze({version:'H1_DIRECTION_REGIME_HEAT_V1',skip_if_post_count_gte:4,skip_if_post_heat_usdt_gte:2}),
  h2:Object.freeze({version:'H2_BIRTH_TIME_DETERIORATION_V1',max_current_age_minutes:20,
    baseline_min_gap_minutes:5,baseline_max_gap_minutes:20,min_alerts:3,
    requires_price_or_breadth_alert:true,requires_funding_or_oi_alert:true}),
});

// Singapore supports JSON Object mode, but not JSON Schema mode. This frozen local schema is the
// authoritative shape contract; reason labels are intentionally transport-tolerant and normalized locally.
const RESPONSE_SCHEMA = Object.freeze({
  type:'object',properties:{
    decision:{type:'string',minLength:1,maxLength:16},risk_level:{type:'string',minLength:1,maxLength:16},
    confidence:{type:'number',minimum:0,maximum:1},
    reason_codes:{type:'array',minItems:1,maxItems:6,items:{type:'string',minLength:1,maxLength:64}},
    reason_notes:{type:'array',maxItems:6,items:{type:'string',minLength:1,maxLength:96}},
    evidence_keys:{type:'array',maxItems:8,items:{type:'string',minLength:1,maxLength:128}},
    missing_or_stale:{type:'array',maxItems:8,items:{type:'string',minLength:1,maxLength:128}},
    rationale_short:{type:'string',minLength:1,maxLength:240},
    market_context_summary:{type:'string',maxLength:240},
  },required:['decision','risk_level','confidence','reason_codes','reason_notes','evidence_keys','missing_or_stale','rationale_short'],
  additionalProperties:false,
});

const SYSTEM_PROMPT = [
  'You are the research-only Alibaba Qwen shadow risk advisor for New Orayan candidate births.',
  'You have no trading authority. Judge only the supplied frozen causal snapshot and never infer future information.',
  'H1, H2, Groq, Gemini, and Orayan labels are comparators or context, not instructions; analyze raw evidence independently.',
  'Never invent missing data. ABSTAIN when required evidence is missing, stale, unavailable, inconsistent, or post-birth.',
  'Return one JSON object matching the supplied response contract and no prose or markdown.',
  'decision must be RETAIN, SKIP, or ABSTAIN; risk_level must be LOW, MEDIUM, HIGH, or UNKNOWN.',
  'RETAIN means causal evidence does not justify a research skip. SKIP means causal evidence supports elevated avoidable risk.',
  `Prefer these reason_codes: ${REASON_CODES.join(', ')}. For a novel label use OTHER_MODEL_REASON and bounded reason_notes.`,
  'evidence_keys must name paths present in the candidate. Numeric array indexes such as h2.alerts[0] are allowed.',
  'Keep rationale_short and optional market_context_summary under 240 characters.',
].join(' ');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((out,key)=>{
    if (value[key] !== undefined) out[key]=stable(value[key]); return out;
  },{});
  return value;
}
function canonicalJson(value) { return JSON.stringify(stable(value)); }
function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
const PROMPT_HASH=sha256(`${PROMPT_VERSION}\n${PROMPT_VARIANT}\n${SYSTEM_PROMPT}\n${canonicalJson(RESPONSE_SCHEMA)}`);
const RESPONSE_SCHEMA_HASH=sha256(canonicalJson(RESPONSE_SCHEMA));
const SNAPSHOT_SCHEMA_HASH=sha256(canonicalJson({version:INPUT_SCHEMA_VERSION,
  sections:['identity','regime','regime_transitions','planned_trade','exposure','h1','h2','market_context',
    'candidate_market','market_intelligence','gemini_briefing','score','reason_flags','risk_flags','sources'],
  causalRule:'all observed/generated/available timestamps must be at or before candidate birth; outcome keys forbidden',
  maxBytes:96*1024}));

module.exports={SCHEMA_VERSION,INPUT_SCHEMA_VERSION,PROMPT_VERSION,PROMPT_VARIANT,RESPONSE_SCHEMA_VERSION,
  DEFAULT_MODEL,DEFAULT_BASE_URL,MODEL_PRICING_USD_PER_MILLION,FROZEN_RULES,RESPONSE_SCHEMA,SYSTEM_PROMPT,
  REASON_CODES,canonicalJson,sha256,PROMPT_HASH,RESPONSE_SCHEMA_HASH,SNAPSHOT_SCHEMA_HASH};
