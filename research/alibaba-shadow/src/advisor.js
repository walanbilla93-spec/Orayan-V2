'use strict';

const path=require('path');
const {SCHEMA_VERSION,PROMPT_VERSION,PROMPT_VARIANT,RESPONSE_SCHEMA_VERSION,DEFAULT_MODEL,DEFAULT_BASE_URL,
  MODEL_PRICING_USD_PER_MILLION,RESPONSE_SCHEMA,SYSTEM_PROMPT,PROMPT_HASH,RESPONSE_SCHEMA_HASH,SNAPSHOT_SCHEMA_HASH,
  canonicalJson,sha256}=require('./constants');
const {validateSnapshot,compactSnapshot,validateDecision,normalizeDecision}=require('./snapshot');
const {ledgerIndex,budgetReason,nextMinuteAvailableAt}=require('./ledger');
const {postAlibaba}=require('./client');

function intEnv(env,key,dflt,min,max){const value=Number(env[key]??dflt);return Number.isInteger(value)&&value>=min&&value<=max?value:dflt;}
function numberEnv(env,key,dflt,min,max){const value=Number(env[key]??dflt);return Number.isFinite(value)&&value>=min&&value<=max?value:dflt;}
function optionalPrice(env,key,dflt){return String(env[key]??'').trim()===''?dflt:numberEnv(env,key,dflt,0,1000);}
function configFromEnv(env=process.env){
  const persistentDefault=path.resolve(__dirname,'..','..','..','backend','data','alibaba-shadow','decisions.jsonl');
  const model=env.ALIBABA_SHADOW_MODEL||DEFAULT_MODEL;
  const known=MODEL_PRICING_USD_PER_MILLION[model]||null;
  return {apiKey:env.ALIBABA_API_KEY||'',model,baseUrl:env.ALIBABA_SHADOW_BASE_URL||DEFAULT_BASE_URL,
    allowLive:String(env.ALIBABA_SHADOW_ALLOW_LIVE||'').toLowerCase()==='true',
    ledger:env.ALIBABA_SHADOW_LEDGER||persistentDefault,
    timeoutMs:intEnv(env,'ALIBABA_SHADOW_TIMEOUT_MS',20000,1000,60000),
    maxOutputTokens:intEnv(env,'ALIBABA_SHADOW_MAX_OUTPUT_TOKENS',600,128,2048),
    budgetCompletionTokens:intEnv(env,'ALIBABA_SHADOW_BUDGET_COMPLETION_TOKENS',450,128,1024),
    maxRequestsMinute:intEnv(env,'ALIBABA_SHADOW_MAX_REQUESTS_MINUTE',10,1,15000),
    maxTokensMinute:intEnv(env,'ALIBABA_SHADOW_MAX_TOKENS_MINUTE',100000,1000,5000000),
    maxRequestsDay:intEnv(env,'ALIBABA_SHADOW_MAX_REQUESTS_DAY',500,1,100000),
    maxTokensDay:intEnv(env,'ALIBABA_SHADOW_MAX_TOKENS_DAY',3250000,1000,100000000),
    maxCostUsdDay:numberEnv(env,'ALIBABA_SHADOW_MAX_COST_USD_DAY',1,0.01,1000),
    maxDeferAgeMs:intEnv(env,'ALIBABA_SHADOW_MAX_DEFER_SECONDS',75,1,300)*1000,
    maxQueue:intEnv(env,'ALIBABA_SHADOW_MAX_QUEUE',32,1,256),
    inputUsdPerMillion:optionalPrice(env,'ALIBABA_SHADOW_INPUT_USD_PER_MILLION',known?.input??0),
    outputUsdPerMillion:optionalPrice(env,'ALIBABA_SHADOW_OUTPUT_USD_PER_MILLION',known?.output??0),
    pricingKnown:!!known||(String(env.ALIBABA_SHADOW_INPUT_USD_PER_MILLION??'').trim()!==''&&
      String(env.ALIBABA_SHADOW_OUTPUT_USD_PER_MILLION??'').trim()!==''),
  };
}

function buildRequest(snapshot,config){
  return {model:config.model,enable_thinking:false,max_tokens:config.maxOutputTokens,temperature:0.1,
    messages:[{role:'system',content:SYSTEM_PROMPT},{role:'user',content:canonicalJson({prompt_version:PROMPT_VERSION,
      prompt_variant:PROMPT_VARIANT,response_contract:RESPONSE_SCHEMA,candidate:snapshot})}],
    response_format:{type:'json_object'}};
}
function estimatePromptTokens(request){return Math.ceil(Buffer.byteLength(JSON.stringify(request),'utf8')/3.5);}
function estimateTokens(request,completionReserveTokens=450){return estimatePromptTokens(request)+completionReserveTokens;}
function estimatedCostUsd(promptTokens,completionTokens,config){
  return Number(((Number(promptTokens)||0)*config.inputUsdPerMillion/1e6+
    (Number(completionTokens)||0)*config.outputUsdPerMillion/1e6).toFixed(9));
}
function abstainDecision(reasons,code='INSUFFICIENT_DECISION_TIME_EVIDENCE'){
  return {decision:'ABSTAIN',risk_level:'UNKNOWN',confidence:0,reason_codes:[code],reason_notes:[],evidence_keys:[],
    missing_or_stale:reasons.slice(0,8).map(x=>String(x).slice(0,128)),
    rationale_short:'Required causal decision-time evidence is missing, stale, unavailable, or invalid.'};
}
function baseRecord({recordType,requestId,snapshot,inputHash,config,nowIso,status}){
  return {schema_version:SCHEMA_VERSION,record_type:recordType,request_id:requestId,candidate_id:snapshot.candidate_id,
    candidate_birth_at_utc:snapshot.candidate_birth_at_utc,model:config.model,base_url:config.baseUrl,
    region:'Singapore',thinking_enabled:false,prompt_version:PROMPT_VERSION,prompt_variant:PROMPT_VARIANT,
    prompt_hash:PROMPT_HASH,response_schema_version:RESPONSE_SCHEMA_VERSION,response_schema_hash:RESPONSE_SCHEMA_HASH,
    snapshot_schema_version:snapshot.schema_version,snapshot_schema_hash:SNAPSHOT_SCHEMA_HASH,input_snapshot_hash:inputHash,status,
    requested_at_utc:nowIso,completed_at_utc:null,available_to_system_at_utc:null};
}

async function advise(snapshot,options={}){
  const config=options.config||configFromEnv(),nowMs=options.nowMs??Date.now(),nowIso=new Date(nowMs).toISOString();
  const check=validateSnapshot(snapshot,nowMs),compact=compactSnapshot(snapshot);
  const requestId=sha256(`${snapshot?.candidate_id||'missing'}|${compact.inputHash}|${config.model}|${PROMPT_HASH}|${PROMPT_VARIANT}`);
  const index=await ledgerIndex(config.ledger,nowMs,{allowedRoot:config.allowedRoot}),state=index.state(nowMs);
  if(state.requestIds.has(requestId))return {status:'DUPLICATE_IGNORED',request_id:requestId,persisted:false};
  const priorInput=state.candidateInputs.get(snapshot?.candidate_id);
  if(priorInput&&priorInput!==compact.inputHash){
    const decision=abstainDecision(['candidate_id previously recorded with a different input snapshot'],'DUPLICATE_CANDIDATE_CONFLICT');
    const record={...baseRecord({recordType:'SHADOW_DECISION',requestId,snapshot,inputHash:compact.inputHash,config,nowIso,
      status:'DUPLICATE_CANDIDATE_CONFLICT'}),completed_at_utc:nowIso,available_to_system_at_utc:nowIso,latency_ms:0,
      tokens:null,estimated_cost_usd:0,decision};await index.append(record,nowMs);return record;
  }
  if(!check.valid||check.abstainReasons.length){
    const reasons=[...check.errors,...check.abstainReasons];
    const decision=abstainDecision(reasons,check.valid?'INSUFFICIENT_DECISION_TIME_EVIDENCE':'INVALID_OR_LEAKY_INPUT');
    const record={...baseRecord({recordType:'SHADOW_DECISION',requestId,snapshot,inputHash:compact.inputHash,config,nowIso,
      status:'LOCAL_ABSTAIN'}),completed_at_utc:nowIso,available_to_system_at_utc:nowIso,latency_ms:0,tokens:null,
      estimated_cost_usd:0,decision};await index.append(record,nowMs);return record;
  }

  const request=buildRequest(compact.snapshot,config),requestHash=sha256(canonicalJson(request));
  const completionReserveTokens=Math.min(config.budgetCompletionTokens,config.maxOutputTokens);
  const promptEstimate=estimatePromptTokens(request),estimatedTokens=promptEstimate+completionReserveTokens;
  const estimatedCostReserved=estimatedCostUsd(promptEstimate,completionReserveTokens,config);
  const exhausted=!config.pricingKnown?'UNKNOWN_MODEL_PRICING':budgetReason(state,estimatedTokens,estimatedCostReserved,config);
  if(exhausted){
    if(exhausted.startsWith('MINUTE_')){
      const birthMs=Date.parse(snapshot.candidate_birth_at_utc||''),deferAgeMs=Number.isFinite(birthMs)?Math.max(0,nowMs-birthMs):config.maxDeferAgeMs;
      if(deferAgeMs<config.maxDeferAgeMs){
        const deferUntilMs=Math.min(nextMinuteAvailableAt(state,estimatedTokens,config,nowMs),birthMs+config.maxDeferAgeMs);
        const record={...baseRecord({recordType:'BUDGET_DEFERRED',requestId,snapshot,inputHash:compact.inputHash,config,nowIso,
          status:'BUDGET_DEFERRED'}),request_hash:requestHash,estimated_tokens_reserved:estimatedTokens,
          estimated_cost_usd_reserved:estimatedCostReserved,completion_tokens_reserved:completionReserveTokens,
          budget_reason:exhausted,defer_until_utc:new Date(deferUntilMs).toISOString()};await index.append(record,nowMs);
        return {...record,persisted:true};
      }
      const decision=abstainDecision([`${exhausted}; deferred candidate exceeded freshness limit`],'ABSTAIN_BUDGET_STALE');
      const record={...baseRecord({recordType:'SHADOW_DECISION',requestId,snapshot,inputHash:compact.inputHash,config,nowIso,
        status:'ABSTAIN_BUDGET_STALE'}),request_hash:requestHash,completed_at_utc:nowIso,available_to_system_at_utc:nowIso,
        latency_ms:0,tokens:null,estimated_cost_usd:0,decision};await index.append(record,nowMs);return record;
    }
    const decision=abstainDecision([exhausted],exhausted==='UNKNOWN_MODEL_PRICING'?'UNKNOWN_MODEL_PRICING':'LOCAL_BUDGET_EXHAUSTED');
    const record={...baseRecord({recordType:'SHADOW_DECISION',requestId,snapshot,inputHash:compact.inputHash,config,nowIso,
      status:'BUDGET_EXHAUSTED'}),request_hash:requestHash,completed_at_utc:nowIso,available_to_system_at_utc:nowIso,
      latency_ms:0,tokens:null,estimated_cost_usd:0,decision};await index.append(record,nowMs);return record;
  }
  if(options.mode==='dry-run')return {status:'DRY_RUN',request_id:requestId,request,estimated_tokens_reserved:estimatedTokens,
    estimated_cost_usd_reserved:estimatedCostReserved,completion_tokens_reserved:completionReserveTokens,persisted:false};
  if(!['live','mock'].includes(options.mode))throw new Error('Mode must be dry-run, mock, or live.');
  if(options.mode==='live'&&!config.allowLive)throw new Error('Live call blocked: ALIBABA_SHADOW_ALLOW_LIVE must remain false until canary approval.');

  await index.append({...baseRecord({recordType:'REQUEST_STARTED',requestId,snapshot,inputHash:compact.inputHash,config,nowIso,
    status:'REQUEST_STARTED'}),request_hash:requestHash,estimated_tokens_reserved:estimatedTokens,
    estimated_cost_usd_reserved:estimatedCostReserved,completion_tokens_reserved:completionReserveTokens},nowMs);
  const started=Date.now();
  const api=options.mode==='mock'?await options.mockTransport(request):await postAlibaba(request,{apiKey:config.apiKey,
    baseUrl:config.baseUrl,timeoutMs:config.timeoutMs,fetchImpl:options.fetchImpl});
  const completedMs=options.completedMs??Date.now(),completedIso=new Date(completedMs).toISOString();
  let status=api.status,decision,normalization=null;
  if(api.ok){let parsed;try{parsed=JSON.parse(api.body?.choices?.[0]?.message?.content||'');}catch(_){status='MALFORMED_JSON';}
    const normalized=parsed?normalizeDecision(parsed):{decision:parsed,normalization:null};parsed=normalized.decision;normalization=normalized.normalization;
    const errors=parsed?validateDecision(parsed,compact.snapshot):['response:not_json'];
    if(errors.length){status='MALFORMED_OUTPUT';decision=abstainDecision(errors,'MALFORMED_MODEL_OUTPUT');}else decision=parsed;
  }else decision=abstainDecision([api.status],api.status);
  const usage=api.body?.usage||null;
  const tokens=usage?{prompt:usage.prompt_tokens??usage.input_tokens??null,
    completion:usage.completion_tokens??usage.output_tokens??null,total:usage.total_tokens??null}:null;
  if(tokens&&tokens.total==null&&Number.isFinite(tokens.prompt)&&Number.isFinite(tokens.completion))tokens.total=tokens.prompt+tokens.completion;
  const actualCost=tokens?estimatedCostUsd(tokens.prompt,tokens.completion,config):estimatedCostReserved;
  const record={...baseRecord({recordType:'SHADOW_DECISION',requestId,snapshot,inputHash:compact.inputHash,config,nowIso,status}),
    completed_at_utc:completedIso,available_to_system_at_utc:completedIso,latency_ms:api.latencyMs??Math.max(0,Date.now()-started),
    request_hash:requestHash,http_status:api.httpStatus??null,rate_limit_headers:api.headers||{},
    api_error:api.ok?null:(api.error||{type:null,code:null,message:null}),normalization,tokens,
    estimated_cost_usd:actualCost,pricing_usd_per_million:{input:config.inputUsdPerMillion,output:config.outputUsdPerMillion},decision};
  await index.append(record,completedMs);return record;
}

class BoundedShadowQueue{
  constructor({maxSize=32,worker}){this.maxSize=maxSize;this.worker=worker;this.pending=[];this.active=false;}
  enqueue(snapshot){if(this.pending.length+(this.active?1:0)>=this.maxSize){const error=new Error('Alibaba shadow queue is full');
    error.code='QUEUE_FULL';return Promise.reject(error);}return new Promise((resolve,reject)=>{this.pending.push({snapshot,resolve,reject});this.pump();});}
  async pump(){if(this.active)return;const item=this.pending.shift();if(!item)return;this.active=true;
    try{item.resolve(await this.worker(item.snapshot));}catch(error){item.reject(error);}finally{this.active=false;queueMicrotask(()=>this.pump());}}
}

module.exports={configFromEnv,buildRequest,estimatePromptTokens,estimateTokens,estimatedCostUsd,advise,BoundedShadowQueue,abstainDecision};
