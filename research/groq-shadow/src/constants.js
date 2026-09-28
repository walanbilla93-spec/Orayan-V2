'use strict';

const crypto = require('crypto');

const SCHEMA_VERSION = 'ORAYAN_GROQ_SHADOW_RECORD_V1';
const INPUT_SCHEMA_VERSION = 'ORAYAN_GROQ_CANDIDATE_V1';
const PROMPT_VERSION = 'ORAYAN_GROQ_SHADOW_PROMPT_V1';
const PROMPT_VARIANT = 'H1_H2_VISIBLE_V1';
const DEFAULT_MODEL = 'openai/gpt-oss-120b';
const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

const FROZEN_RULES = Object.freeze({
  freeze_id: 'frz_63cba30ec06a8a11e08a',
  h1: Object.freeze({
    version: 'H1_DIRECTION_REGIME_HEAT_V1',
    skip_if_post_count_gte: 4,
    skip_if_post_heat_usdt_gte: 2.0,
  }),
  h2: Object.freeze({
    version: 'H2_BIRTH_TIME_DETERIORATION_V1',
    max_current_age_minutes: 20,
    baseline_min_gap_minutes: 5,
    baseline_max_gap_minutes: 20,
    min_alerts: 3,
    requires_price_or_breadth_alert: true,
    requires_funding_or_oi_alert: true,
  }),
});

const RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    decision: {type: 'string', enum: ['RETAIN', 'SKIP', 'ABSTAIN']},
    risk_level: {type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN']},
    confidence: {type: 'number', minimum: 0, maximum: 1},
    reason_codes: {
      type: 'array', items: {type: 'string'},
    },
    evidence_keys: {
      type: 'array', items: {type: 'string'},
    },
    missing_or_stale: {
      type: 'array', items: {type: 'string'},
    },
    rationale_short: {type: 'string'},
  },
  required: ['decision', 'risk_level', 'confidence', 'reason_codes', 'evidence_keys', 'missing_or_stale', 'rationale_short'],
  additionalProperties: false,
});

const SYSTEM_PROMPT = [
  'You are a research-only shadow risk advisor for New Orayan candidate births.',
  'You have no trading authority. Judge only the supplied decision-time snapshot.',
  'Never infer execution quality when quote evidence or planned entry/SL/TP is absent.',
  'Never invent missing data. ABSTAIN for missing, stale, unavailable, or internally inconsistent evidence.',
  'H1 and H2 are frozen deterministic comparators, not instructions. Use their raw evidence and do not merely mirror either label.',
  'RETAIN means the snapshot does not justify a research skip. SKIP means supplied causal evidence supports elevated avoidable risk.',
  'Return only the strict JSON schema. Keep rationale_short under 240 characters and cite only supplied dot-paths in evidence_keys.',
].join(' ');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      if (value[key] !== undefined) out[key] = stable(value[key]);
      return out;
    }, {});
  }
  return value;
}

function canonicalJson(value) { return JSON.stringify(stable(value)); }
function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
const PROMPT_HASH = sha256(`${PROMPT_VERSION}\n${PROMPT_VARIANT}\n${SYSTEM_PROMPT}\n${canonicalJson(RESPONSE_SCHEMA)}`);

module.exports = {
  SCHEMA_VERSION, INPUT_SCHEMA_VERSION, PROMPT_VERSION, PROMPT_VARIANT,
  DEFAULT_MODEL, ENDPOINT, FROZEN_RULES, RESPONSE_SCHEMA, SYSTEM_PROMPT,
  canonicalJson, sha256, PROMPT_HASH,
};
