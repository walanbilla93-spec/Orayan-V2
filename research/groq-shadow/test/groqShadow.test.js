'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const {advise,configFromEnv,buildRequest,BoundedShadowQueue}=require('../src/advisor');
const {postGroq}=require('../src/client');
const ledgerModule=require('../src/ledger');
const {appendImmutable}=ledgerModule;
const {validateSnapshot,validateDecision}=require('../src/snapshot');
const {REASON_CODES,RESPONSE_SCHEMA_VERSION}=require('../src/constants');

function tempLedger(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orayan-groq-'));return path.join(dir,'ledger.jsonl');}
function snapshot(){
  const feature=(current,baseline,extra={})=>({current,baseline,delta:current-baseline,
    observed_at_utc:'2026-09-28T09:58:00.000Z',baseline_observed_at_utc:'2026-09-28T09:48:00.000Z',
    available_to_system_at_utc:'2026-09-28T09:58:01.000Z',age_seconds:120,status:'OK',...extra});
  return {schema_version:'ORAYAN_GROQ_CANDIDATE_V1',candidate_id:'cand-1',candidate_birth_at_utc:'2026-09-28T10:00:00.000Z',
    engine:'NEW_ORAYAN',symbol:'TESTUSDT',side:'BUY',
    regime:{label:'BULL_RANGE',strength:61,status:'OK',age_seconds:60,available_to_system_at_utc:'2026-09-28T09:59:00.000Z'},
    planned_trade:{entry:100,sl:98,tp:104,rr:2,planned_risk_usdt:0.25,planned_heat_usdt:1.25,stop_distance_pct:2,stop_atr_multiple:1.1,
      quote_evidence:{available:true,bid:99.99,ask:100.01,mark:100,exchange_timestamp_utc:'2026-09-28T09:59:58.000Z',age_seconds:2}},
    exposure:{open_positions_total:4,same_side_count:3,same_side_regime_count:2,same_side_regime_heat_usdt:1,observed_at_utc:'2026-09-28T09:59:59.000Z',age_seconds:1},
    h1:{version:'H1_DIRECTION_REGIME_HEAT_V1',state:'RETAIN',abstain_reasons:[]},
    h2:{version:'H2_BIRTH_TIME_DETERIORATION_V1',state:'RETAIN',alerts:[],abstain_reasons:[],features:{
      btc_return_24h:feature(.01,.011),eth_return_24h:feature(.012,.013),linear_breadth:feature(12,14,{sample_size:120}),
      btc_funding_rate:feature(.00005,.00004),eth_funding_rate:feature(.00004,.00003),
      btc_open_interest:feature(1000,990),eth_open_interest:feature(800,795)}},
    score:{value:74,rr:2},reason_flags:['TEST'],risk_flags:[],sources:[
      {name:'new_orayan_birth',status:'OK',available_to_system_at_utc:'2026-09-28T10:00:00.000Z',age_seconds:0},
      {name:'market_intelligence_join',status:'OK',available_to_system_at_utc:'2026-09-28T09:58:01.000Z',age_seconds:119}]};
}
function config(ledger=tempLedger()){return {...configFromEnv({}),ledger,apiKey:'secret-test-key',allowLive:true};}
function okTransport(decision={decision:'RETAIN',risk_level:'LOW',confidence:.7,reason_codes:['EVIDENCE_COMPLETE'],reason_notes:[],evidence_keys:['h1.state','h2.state'],missing_or_stale:[],rationale_short:'Causal evidence is adequate for a shadow retain.'}){
  return async()=>({ok:true,status:'OK',httpStatus:200,headers:{},latencyMs:2,body:{usage:{prompt_tokens:300,completion_tokens:40,total_tokens:340},choices:[{message:{content:JSON.stringify(decision)}}]}});
}

test('valid V1 snapshot is causal and complete',()=>{
  assert.deepEqual(validateSnapshot(snapshot(),Date.parse('2026-09-28T10:00:05Z')),{valid:true,errors:[],abstainReasons:[]});
});

test('future leakage keys and post-birth availability abstain without transport',async()=>{
  const row=snapshot();row.realised_pnl=3;row.sources[1].available_to_system_at_utc='2026-09-28T10:00:01.000Z';
  let calls=0;const result=await advise(row,{config:config(),mode:'mock',nowMs:Date.parse('2026-09-28T10:00:05Z'),mockTransport:async()=>{calls++;}});
  assert.equal(result.status,'LOCAL_ABSTAIN');assert.equal(result.decision.reason_codes[0],'INVALID_OR_LEAKY_INPUT');assert.equal(calls,0);
});

test('stale feature and missing quote evidence abstain locally',async()=>{
  const row=snapshot();row.h2.features.btc_return_24h.age_seconds=1201;row.planned_trade.quote_evidence.available=false;
  const result=await advise(row,{config:config(),mode:'mock',nowMs:Date.parse('2026-09-28T10:00:05Z'),mockTransport:okTransport()});
  assert.equal(result.status,'LOCAL_ABSTAIN');assert.equal(result.decision.decision,'ABSTAIN');
});

test('malformed model JSON becomes persisted abstention',async()=>{
  const transport=async()=>({ok:true,status:'OK',httpStatus:200,headers:{},body:{choices:[{message:{content:'{'}}]}});
  const result=await advise(snapshot(),{config:config(),mode:'mock',nowMs:Date.parse('2026-09-28T10:00:05Z'),mockTransport:transport});
  assert.equal(result.status,'MALFORMED_OUTPUT');assert.equal(result.decision.decision,'ABSTAIN');
});

test('timeout, 429 and 5xx are classified without retry',async()=>{
  const abort=Object.assign(new Error('aborted'),{name:'AbortError'});
  assert.equal((await postGroq({}, {apiKey:'x',timeoutMs:10,fetchImpl:async()=>{throw abort;}})).status,'TIMEOUT');
  const response=status=>({ok:false,status,headers:{get:()=>null},text:async()=>'{"error":{}}'});
  assert.equal((await postGroq({}, {apiKey:'x',timeoutMs:10,fetchImpl:async()=>response(429)})).status,'API_429_RATE_LIMIT');
  assert.equal((await postGroq({}, {apiKey:'x',timeoutMs:10,fetchImpl:async()=>response(503)})).status,'API_5XX');
});

test('daily budget exhaustion is recorded instead of dropped',async()=>{
  const cfg=config();cfg.maxRequestsDay=1;
  appendImmutable(cfg.ledger,{record_type:'REQUEST_STARTED',request_id:'prior',candidate_id:'prior',input_snapshot_hash:'prior',requested_at_utc:'2026-09-28T09:00:00.000Z',estimated_tokens_reserved:1});
  let calls=0;const result=await advise(snapshot(),{config:cfg,mode:'mock',nowMs:Date.parse('2026-09-28T10:00:05Z'),mockTransport:async request=>{calls+=1;return okTransport()(request);}});
  assert.equal(result.status,'BUDGET_EXHAUSTED');assert.equal(result.decision.reason_codes[0],'LOCAL_BUDGET_EXHAUSTED');
  assert.equal(calls,0);
});

test('restart idempotency ignores exact duplicate and flags changed duplicate ID',async()=>{
  const cfg=config(),now=Date.parse('2026-09-28T10:00:05Z');
  const first=await advise(snapshot(),{config:cfg,mode:'mock',nowMs:now,mockTransport:okTransport()});
  assert.equal(first.status,'OK');
  const duplicate=await advise(snapshot(),{config:cfg,mode:'mock',nowMs:now,mockTransport:okTransport()});
  assert.equal(duplicate.status,'DUPLICATE_IGNORED');
  const changed=snapshot();changed.score.value=75;
  const conflict=await advise(changed,{config:cfg,mode:'mock',nowMs:now,mockTransport:okTransport()});
  assert.equal(conflict.status,'DUPLICATE_CANDIDATE_CONFLICT');
});

test('restart terminalizes orphan REQUEST_STARTED without repeating transport',async()=>{
  const cfg=config(),now=Date.parse('2026-09-28T10:00:05Z');
  let calls=0;
  await assert.rejects(advise(snapshot(),{config:cfg,mode:'mock',nowMs:now,mockTransport:async()=>{
    calls+=1;throw new Error('simulated process death after durable start');
  }}),/simulated process death/);
  ledgerModule._test.resetCaches();
  const result=await advise(snapshot(),{config:cfg,mode:'mock',nowMs:now+1000,mockTransport:async()=>{
    calls+=1;return okTransport()();
  }});
  assert.equal(result.status,'DUPLICATE_IGNORED');
  assert.equal(calls,1,'ambiguous potentially billed request must never be retried');
  const rows=fs.readFileSync(cfg.ledger,'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row=>row.status),['REQUEST_STARTED','INTERRUPTED_UNKNOWN_OUTCOME']);
  assert.equal(rows[1].decision.decision,'ABSTAIN');
});

test('ledger is scanned once then incrementally cached across repeated candidates',async()=>{
  const cfg=config(),now=Date.parse('2026-09-28T10:00:05Z');
  ledgerModule._test.resetCaches();ledgerModule._test.resetScanCount();
  for(let index=0;index<4;index+=1){
    const row=snapshot();row.candidate_id=`cached-${index}`;
    await advise(row,{config:cfg,mode:'mock',nowMs:now+index,mockTransport:okTransport()});
  }
  assert.equal(ledgerModule._test.scanCount(),1);
});

test('successful usage reconciles conservative token reservation',async()=>{
  const cfg=config(),now=Date.parse('2026-09-28T10:00:05Z');
  const result=await advise(snapshot(),{config:cfg,mode:'mock',nowMs:now,completedMs:now+1,mockTransport:okTransport()});
  const state=await ledgerModule.ledgerState(cfg.ledger,now);
  assert.equal(result.tokens.total,340);
  assert.equal(state.dayTokens,340);
  assert.equal(state.minuteTokens,340);
});

test('absent API key is a persisted abstention and secret is never persisted',async()=>{
  const cfg=config();cfg.apiKey='';
  const result=await advise(snapshot(),{config:cfg,mode:'live',nowMs:Date.parse('2026-09-28T10:00:05Z')});
  assert.equal(result.status,'API_KEY_ABSENT');
  assert.doesNotMatch(fs.readFileSync(cfg.ledger,'utf8'),/secret-test-key|Authorization|Bearer/);
});

test('model is environment-configurable while endpoint and prompt V3 stay frozen',()=>{
  const cfg=configFromEnv({GROQ_SHADOW_MODEL:'qwen/qwen3.8-27b'});
  const request=buildRequest(snapshot(),cfg);
  assert.equal(request.model,'qwen/qwen3.8-27b');assert.equal(request.response_format.json_schema.strict,true);
  assert.match(request.messages[1].content,/H1_H2_VISIBLE_V3/);
});

test('gpt-oss-120b request contains only supported fields and strict V3 schema',()=>{
  const request=buildRequest(snapshot(),configFromEnv({}));
  assert.deepEqual(Object.keys(request).sort(),['include_reasoning','max_completion_tokens','messages','model','reasoning_effort','response_format']);
  assert.equal(request.model,'openai/gpt-oss-120b');
  assert.equal(request.max_completion_tokens,1024);
  assert.equal(request.reasoning_effort,'low');
  assert.equal(request.include_reasoning,false);
  assert.equal(request.response_format.type,'json_schema');
  assert.equal(request.response_format.json_schema.strict,true);
  assert.equal(RESPONSE_SCHEMA_VERSION,'ORAYAN_GROQ_SHADOW_RESPONSE_V3');
});

test('HTTP 400 details are classified, bounded, sanitized and persisted with hashes',async()=>{
  const longMessage=`Generated JSON does not match schema Bearer secret-test-key gsk_not-a-real-key ${'x'.repeat(800)}`;
  const transport=async request=>postGroq(request,{apiKey:'secret-test-key',timeoutMs:100,
    fetchImpl:async()=>({ok:false,status:400,headers:{get:()=>null},text:async()=>JSON.stringify({error:{
      message:longMessage,type:'invalid_request_error',code:'json_validate_failed'}})})});
  const cfg=config();const result=await advise(snapshot(),{config:cfg,mode:'mock',nowMs:Date.parse('2026-09-28T10:00:05Z'),mockTransport:transport});
  assert.equal(result.status,'API_400_SCHEMA');
  assert.equal(result.api_error.type,'invalid_request_error');
  assert.equal(result.api_error.code,'json_validate_failed');
  assert.ok(result.api_error.message.length<=512);
  assert.doesNotMatch(result.api_error.message,/secret-test-key|gsk_not-a-real-key/);
  assert.match(result.request_hash,/^[a-f0-9]{64}$/);
  assert.match(result.prompt_hash,/^[a-f0-9]{64}$/);
  assert.match(result.response_schema_hash,/^[a-f0-9]{64}$/);
  assert.doesNotMatch(fs.readFileSync(cfg.ledger,'utf8'),/secret-test-key|Authorization|Bearer/);
});

test('every allowed reason code validates against the local V2 contract',()=>{
  for(const reason of REASON_CODES){
    const decision={decision:'RETAIN',risk_level:'LOW',confidence:.5,reason_codes:[reason],reason_notes:[],
      evidence_keys:['h1.state'],missing_or_stale:[],rationale_short:'Bounded causal rationale.'};
    assert.deepEqual(validateDecision(decision,snapshot()),[],reason);
  }
});

test('unknown reason code is normalized without discarding an otherwise valid response',async()=>{
  const decision={decision:'SKIP',risk_level:'HIGH',confidence:.8,reason_codes:['MODEL_MADE_A_NEW_CODE'],reason_notes:['Model detail'],
    evidence_keys:['h1.state'],missing_or_stale:[],rationale_short:'Causal evidence supports skip.'};
  const result=await advise(snapshot(),{config:config(),mode:'mock',nowMs:Date.parse('2026-09-28T10:00:05Z'),mockTransport:okTransport(decision)});
  assert.equal(result.status,'OK');
  assert.deepEqual(result.decision.reason_codes,['OTHER_MODEL_REASON']);
  assert.equal(result.normalization.kind,'UNKNOWN_REASON_CODE');
});

test('truly invalid structured output still safely abstains',async()=>{
  const invalid={decision:'BUY_NOW',risk_level:'EXTREME',confidence:2,reason_codes:['EVIDENCE_COMPLETE'],reason_notes:[],
    evidence_keys:['not.in.snapshot'],missing_or_stale:[],rationale_short:''};
  const result=await advise(snapshot(),{config:config(),mode:'mock',nowMs:Date.parse('2026-09-28T10:00:05Z'),mockTransport:okTransport(invalid)});
  assert.equal(result.status,'MALFORMED_OUTPUT');assert.equal(result.decision.decision,'ABSTAIN');
});

test('minute TPM pressure defers a fresh candidate without an API call',async()=>{
  const cfg=config(),birth=Date.parse('2026-09-28T10:00:00Z'),now=birth+5000;
  cfg.maxTokensMinute=7200;cfg.maxDeferAgeMs=75000;
  appendImmutable(cfg.ledger,{record_type:'REQUEST_STARTED',request_id:'prior',candidate_id:'prior',input_snapshot_hash:'prior',
    requested_at_utc:new Date(now-1000).toISOString(),estimated_tokens_reserved:7000});
  let calls=0;const result=await advise(snapshot(),{config:cfg,mode:'mock',nowMs:now,mockTransport:async()=>{calls+=1;return okTransport()();}});
  assert.equal(result.status,'BUDGET_DEFERRED');assert.equal(result.record_type,'BUDGET_DEFERRED');assert.equal(calls,0);
  assert.ok(Date.parse(result.defer_until_utc)>now);
});

test('minute TPM pressure becomes ABSTAIN_BUDGET_STALE after configured age',async()=>{
  const cfg=config(),birth=Date.parse('2026-09-28T10:00:00Z'),now=birth+75000;
  cfg.maxTokensMinute=7200;cfg.maxDeferAgeMs=75000;
  appendImmutable(cfg.ledger,{record_type:'REQUEST_STARTED',request_id:'prior',candidate_id:'prior',input_snapshot_hash:'prior',
    requested_at_utc:new Date(now-1000).toISOString(),estimated_tokens_reserved:7000});
  let calls=0;const result=await advise(snapshot(),{config:cfg,mode:'mock',nowMs:now,mockTransport:async()=>{calls+=1;return okTransport()();}});
  assert.equal(result.status,'ABSTAIN_BUDGET_STALE');assert.equal(result.decision.reason_codes[0],'ABSTAIN_BUDGET_STALE');assert.equal(calls,0);
});

test('bounded queue refuses excess work',async()=>{
  let release;const hold=new Promise(resolve=>{release=resolve;});
  const queue=new BoundedShadowQueue({maxSize:1,worker:async()=>hold});
  const first=queue.enqueue(snapshot());
  await assert.rejects(queue.enqueue(snapshot()),error=>error.code==='QUEUE_FULL');
  release('done');assert.equal(await first,'done');
});

test('shadow worker failure is contained and the bounded queue continues',async()=>{
  let calls=0;
  const queue=new BoundedShadowQueue({maxSize:2,worker:async()=>{calls++;if(calls===1)throw Error('upstream exploded');return 'next-ok';}});
  await assert.rejects(queue.enqueue(snapshot()),/upstream exploded/);
  assert.equal(await queue.enqueue(snapshot()),'next-ok');
});

test('shadow package has no executor or gates integration and engine uses a one-way producer',()=>{
  const root=path.resolve(__dirname,'../../..');
  for(const file of ['backend/lib/executor.js','backend/lib/gates.js']){
    assert.doesNotMatch(fs.readFileSync(path.join(root,file),'utf8'),/groq[-_ ]?shadow|GROQ_SHADOW/i);
  }
  const engine=fs.readFileSync(path.join(root,'backend/lib/engine.js'),'utf8');
  assert.match(engine,/groqShadowProducer\.observeBirth\(/);
  assert.doesNotMatch(engine,/await\s+groqShadowProducer\.observeBirth/);
});
