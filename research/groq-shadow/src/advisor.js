'use strict';

const path = require('path');

const {
  SCHEMA_VERSION, PROMPT_VERSION, PROMPT_VARIANT, DEFAULT_MODEL, RESPONSE_SCHEMA,
  SYSTEM_PROMPT, PROMPT_HASH, canonicalJson, sha256,
} = require('./constants');
const {validateSnapshot, compactSnapshot, validateDecision} = require('./snapshot');
const {appendImmutable, ledgerState, budgetReason} = require('./ledger');
const {postGroq} = require('./client');

function intEnv(env, key, dflt, min, max) {
  const value = Number(env[key] ?? dflt);
  return Number.isInteger(value) && value >= min && value <= max ? value : dflt;
}
function configFromEnv(env = process.env) {
  // In the production image this resolves to /app/backend/data. Keep the environment override,
  // but never default to a working-directory-dependent /data or ./data location.
  const persistentDefault = path.resolve(__dirname, '..', '..', '..', 'backend', 'data', 'groq-shadow', 'decisions.jsonl');
  return {
    apiKey:env.GROQ_API_KEY || '',
    model:env.GROQ_SHADOW_MODEL || DEFAULT_MODEL,
    allowLive:String(env.GROQ_SHADOW_ALLOW_LIVE || '').toLowerCase() === 'true',
    ledger:env.GROQ_SHADOW_LEDGER || persistentDefault,
    timeoutMs:intEnv(env,'GROQ_SHADOW_TIMEOUT_MS',15000,1000,60000),
    maxOutputTokens:intEnv(env,'GROQ_SHADOW_MAX_OUTPUT_TOKENS',220,64,1000),
    maxRequestsDay:intEnv(env,'GROQ_SHADOW_MAX_REQUESTS_DAY',700,1,999),
    maxTokensDay:intEnv(env,'GROQ_SHADOW_MAX_TOKENS_DAY',150000,1000,199999),
    maxRequestsMinute:intEnv(env,'GROQ_SHADOW_MAX_REQUESTS_MINUTE',20,1,29),
    maxTokensMinute:intEnv(env,'GROQ_SHADOW_MAX_TOKENS_MINUTE',6000,500,7999),
    maxQueue:intEnv(env,'GROQ_SHADOW_MAX_QUEUE',32,1,256),
  };
}

function buildRequest(snapshot, config) {
  return {
    model:config.model,
    reasoning_effort:'low',
    max_completion_tokens:config.maxOutputTokens,
    messages:[
      {role:'system',content:SYSTEM_PROMPT},
      {role:'user',content:canonicalJson({prompt_version:PROMPT_VERSION,prompt_variant:PROMPT_VARIANT,candidate:snapshot})},
    ],
    response_format:{type:'json_schema',json_schema:{name:'orayan_shadow_decision',strict:true,schema:RESPONSE_SCHEMA}},
  };
}

function estimateTokens(request, maxOutputTokens) {
  return Math.ceil(Buffer.byteLength(JSON.stringify(request),'utf8')/3.5) + maxOutputTokens;
}

function abstainDecision(reasons, code = 'INSUFFICIENT_DECISION_TIME_EVIDENCE') {
  return {decision:'ABSTAIN',risk_level:'UNKNOWN',confidence:0,reason_codes:[code],evidence_keys:[],missing_or_stale:reasons.slice(0,8),rationale_short:'Required causal decision-time evidence is missing, stale, unavailable, or invalid.'};
}

function baseRecord({recordType,requestId,snapshot,inputHash,config,nowIso,status}) {
  return {
    schema_version:SCHEMA_VERSION,record_type:recordType,request_id:requestId,
    candidate_id:snapshot.candidate_id,candidate_birth_at_utc:snapshot.candidate_birth_at_utc,
    model:config.model,prompt_version:PROMPT_VERSION,prompt_variant:PROMPT_VARIANT,
    prompt_hash:PROMPT_HASH,input_snapshot_hash:inputHash,status,
    requested_at_utc:nowIso,completed_at_utc:null,available_to_system_at_utc:null,
  };
}

async function advise(snapshot, options = {}) {
  const config = options.config || configFromEnv();
  const nowMs = options.nowMs ?? Date.now(), nowIso = new Date(nowMs).toISOString();
  const check = validateSnapshot(snapshot, nowMs);
  const compact = compactSnapshot(snapshot);
  const requestId = sha256(`${snapshot?.candidate_id || 'missing'}|${compact.inputHash}|${config.model}|${PROMPT_HASH}|${PROMPT_VARIANT}`);
  const state = await ledgerState(config.ledger, nowMs);
  if (state.requestIds.has(requestId)) return {status:'DUPLICATE_IGNORED',request_id:requestId,persisted:false};
  const priorInput = state.candidateInputs.get(snapshot?.candidate_id);
  if (priorInput && priorInput !== compact.inputHash) {
    const decision=abstainDecision(['candidate_id previously recorded with a different input snapshot'],'DUPLICATE_CANDIDATE_CONFLICT');
    const record={...baseRecord({recordType:'SHADOW_DECISION',requestId,snapshot,inputHash:compact.inputHash,config,nowIso,status:'DUPLICATE_CANDIDATE_CONFLICT'}),
      completed_at_utc:nowIso,available_to_system_at_utc:nowIso,latency_ms:0,tokens:null,decision};
    appendImmutable(config.ledger,record);
    return record;
  }

  if (!check.valid || check.abstainReasons.length) {
    const reasons = [...check.errors,...check.abstainReasons];
    const decision = abstainDecision(reasons, check.valid ? 'INSUFFICIENT_DECISION_TIME_EVIDENCE' : 'INVALID_OR_LEAKY_INPUT');
    const record = {...baseRecord({recordType:'SHADOW_DECISION',requestId,snapshot,inputHash:compact.inputHash,config,nowIso,status:'LOCAL_ABSTAIN'}),
      completed_at_utc:nowIso,available_to_system_at_utc:nowIso,latency_ms:0,tokens:null,decision};
    appendImmutable(config.ledger, record);
    return record;
  }

  const request = buildRequest(compact.snapshot, config);
  const estimatedTokens = estimateTokens(request, config.maxOutputTokens);
  const exhausted = budgetReason(state, estimatedTokens, config);
  if (exhausted) {
    const decision = abstainDecision([exhausted], 'LOCAL_BUDGET_EXHAUSTED');
    const record = {...baseRecord({recordType:'SHADOW_DECISION',requestId,snapshot,inputHash:compact.inputHash,config,nowIso,status:'BUDGET_EXHAUSTED'}),
      completed_at_utc:nowIso,available_to_system_at_utc:nowIso,latency_ms:0,tokens:null,decision};
    appendImmutable(config.ledger, record);
    return record;
  }

  if (options.mode === 'dry-run') return {status:'DRY_RUN',request_id:requestId,request,estimated_tokens_reserved:estimatedTokens,persisted:false};
  if (options.mode !== 'live' && options.mode !== 'mock') throw new Error('Mode must be dry-run, mock, or live.');
  if (options.mode === 'live' && !config.allowLive) throw new Error('Live call blocked: set GROQ_SHADOW_ALLOW_LIVE=true only after explicit approval.');

  appendImmutable(config.ledger, {...baseRecord({recordType:'REQUEST_STARTED',requestId,snapshot,inputHash:compact.inputHash,config,nowIso,status:'REQUEST_STARTED'}),
    estimated_tokens_reserved:estimatedTokens});
  const started = Date.now();
  const api = options.mode === 'mock'
    ? await options.mockTransport(request)
    : await postGroq(request,{apiKey:config.apiKey,timeoutMs:config.timeoutMs,fetchImpl:options.fetchImpl});
  const completedMs = options.completedMs ?? Date.now(), completedIso = new Date(completedMs).toISOString();
  let status = api.status, decision;
  if (api.ok) {
    let parsed;
    try { parsed = JSON.parse(api.body?.choices?.[0]?.message?.content || ''); }
    catch (_) { status='MALFORMED_JSON'; }
    const decisionErrors = parsed ? validateDecision(parsed,compact.snapshot) : ['response:not_json'];
    if (decisionErrors.length) {
      status='MALFORMED_OUTPUT'; decision=abstainDecision(decisionErrors,'MALFORMED_MODEL_OUTPUT');
    } else decision=parsed;
  } else decision=abstainDecision([api.status], api.status);
  const usage = api.body?.usage || null;
  const record = {...baseRecord({recordType:'SHADOW_DECISION',requestId,snapshot,inputHash:compact.inputHash,config,nowIso,status}),
    completed_at_utc:completedIso,available_to_system_at_utc:completedIso,
    latency_ms:api.latencyMs ?? Math.max(0,Date.now()-started),
    http_status:api.httpStatus ?? null,rate_limit_headers:api.headers || {},
    tokens:usage ? {prompt:usage.prompt_tokens??null,completion:usage.completion_tokens??null,total:usage.total_tokens??null} : null,
    decision};
  appendImmutable(config.ledger, record);
  return record;
}

class BoundedShadowQueue {
  constructor({maxSize=32,worker}) { this.maxSize=maxSize;this.worker=worker;this.pending=[];this.active=false; }
  enqueue(snapshot) {
    if (this.pending.length + (this.active?1:0) >= this.maxSize) {
      const error = new Error('Groq shadow queue is full'); error.code='QUEUE_FULL'; return Promise.reject(error);
    }
    return new Promise((resolve,reject)=>{this.pending.push({snapshot,resolve,reject});this.pump();});
  }
  async pump() {
    if (this.active) return;
    const item=this.pending.shift(); if(!item)return;
    this.active=true;
    try {item.resolve(await this.worker(item.snapshot));} catch(error){item.reject(error);}
    finally {this.active=false;queueMicrotask(()=>this.pump());}
  }
}

module.exports = {configFromEnv,buildRequest,estimateTokens,advise,BoundedShadowQueue,abstainDecision};
