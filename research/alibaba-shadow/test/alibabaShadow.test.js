'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const {advise,configFromEnv,buildRequest,BoundedShadowQueue,estimatedCostUsd}=require('../src/advisor');
const {postAlibaba,endpointFor}=require('../src/client');
const ledger=require('../src/ledger');
const {validateSnapshot,validateDecision,pathExists}=require('../src/snapshot');
const {RESPONSE_SCHEMA_VERSION}=require('../src/constants');

function tempLedger(){return path.join(fs.mkdtempSync(path.join(os.tmpdir(),'orayan-alibaba-')),'decisions.jsonl');}
function feature(current,baseline,extra={}){return {current,baseline,delta:current-baseline,
  observed_at_utc:'2026-09-28T09:58:00.000Z',baseline_observed_at_utc:'2026-09-28T09:48:00.000Z',
  available_to_system_at_utc:'2026-09-28T09:58:01.000Z',age_seconds:120,status:'OK',...extra};}
function snapshot(){return {schema_version:'ORAYAN_ALIBABA_CANDIDATE_V1',candidate_id:'cand-1',candidate_episode_id:'ep-1',
  candidate_birth_at_utc:'2026-09-28T10:00:00.000Z',engine:'NEW_ORAYAN',symbol:'TESTUSDT',side:'BUY',
  regime:{label:'BULL_RANGE',strength:61,status:'OK',age_seconds:60,observed_at_utc:'2026-09-28T09:59:00.000Z',
    available_to_system_at_utc:'2026-09-28T09:59:00.000Z'},regime_transitions:{status:'OK',items:[]},
  planned_trade:{entry:100,sl:98,tp:104,rr:2,planned_risk_usdt:.25,planned_heat_usdt:1.25,stop_distance_pct:2,
    stop_atr_multiple:1.1,quote_evidence:{available:true,status:'LOCAL_RECEIPT_ONLY',bid:99.99,ask:100.01,mark:100,
      exchange_timestamp_utc:'2026-09-28T09:59:58.000Z',observed_at_utc:'2026-09-28T09:59:58.000Z',
      available_to_system_at_utc:'2026-09-28T09:59:58.000Z',age_seconds:2}},
  exposure:{open_positions_total:4,same_side_count:3,same_side_regime_count:2,same_side_regime_heat_usdt:1,
    observed_at_utc:'2026-09-28T09:59:59.000Z',age_seconds:1},
  h1:{version:'H1_DIRECTION_REGIME_HEAT_V1',state:'RETAIN',reason_codes:[],abstain_reasons:[]},
  h2:{version:'H2_BIRTH_TIME_DETERIORATION_V1',state:'RETAIN',alerts:['linear_breadth:directional_deterioration'],
    abstain_reasons:[],features:{btc_return_24h:feature(.01,.011),eth_return_24h:feature(.012,.013),
      linear_breadth:feature(12,14,{sample_size:120}),btc_funding_rate:feature(.00005,.00004),
      eth_funding_rate:feature(.00004,.00003),btc_open_interest:feature(1000,990),eth_open_interest:feature(800,795)}},
  market_context:{status:'OK',current:{observed_at_utc:'2026-09-28T09:58:00.000Z',
    available_to_system_at_utc:'2026-09-28T09:58:01.000Z'}},
  market_intelligence:{status:'UNAVAILABLE',reason:'NOT_PRESENT_AT_CANDIDATE_BIRTH'},
  gemini_briefing:{status:'UNAVAILABLE',reason:'NOT_PRESENT_AT_CANDIDATE_BIRTH'},
  score:{value:74,rr:2},reason_flags:['TEST'],risk_flags:[],sources:[
    {name:'new_orayan_birth',status:'OK',available_to_system_at_utc:'2026-09-28T10:00:00.000Z',age_seconds:0},
    {name:'market_environment_scan',status:'OK',available_to_system_at_utc:'2026-09-28T09:58:01.000Z',age_seconds:119}]};}
function config(file=tempLedger()){return {...configFromEnv({}),ledger:file,apiKey:'sk-secret-test-key',allowLive:true,allowedRoot:path.dirname(file)};}
function decision(extra={}){return {decision:'RETAIN',risk_level:'LOW',confidence:.7,reason_codes:['EVIDENCE_COMPLETE'],
  reason_notes:[],evidence_keys:['h1.state','h2.alerts[0]'],missing_or_stale:[],
  rationale_short:'Causal evidence supports a research retain.',...extra};}
function okTransport(value=decision(),usage={prompt_tokens:3000,completion_tokens:400,total_tokens:3400}){
  return async()=>({ok:true,status:'OK',httpStatus:200,headers:{},latencyMs:2,
    body:{usage,choices:[{message:{content:JSON.stringify(value)}}]}});}

test('causal snapshot validates and safe evidence paths support array indexes',()=>{
  assert.deepEqual(validateSnapshot(snapshot(),Date.parse('2026-09-28T10:00:05Z')),{valid:true,errors:[],abstainReasons:[]});
  assert.equal(pathExists(snapshot(),'h2.alerts[0]'),true);assert.equal(pathExists(snapshot(),'h2.alerts[9]'),false);
  assert.equal(pathExists(snapshot(),'__proto__.polluted'),false);
});

test('future timestamps and outcome keys locally abstain before transport',async()=>{
  for(const mutate of [row=>{row.realized_pnl=2;},row=>{row.market_context.current.available_to_system_at_utc='2026-09-28T10:00:01.000Z';}]){
    const row=snapshot();mutate(row);let calls=0;
    const result=await advise(row,{config:config(),mode:'mock',nowMs:Date.parse('2026-09-28T10:00:05Z'),mockTransport:async()=>{calls+=1;}});
    assert.equal(result.status,'LOCAL_ABSTAIN');assert.equal(result.decision.reason_codes[0],'INVALID_OR_LEAKY_INPUT');assert.equal(calls,0);
  }
});

test('missing or stale required evidence is a persisted local abstain',async()=>{
  const row=snapshot();row.planned_trade.quote_evidence.age_seconds=16;
  const result=await advise(row,{config:config(),mode:'mock',nowMs:Date.parse('2026-09-28T10:00:05Z'),mockTransport:okTransport()});
  assert.equal(result.status,'LOCAL_ABSTAIN');assert.equal(result.decision.decision,'ABSTAIN');
});

test('Alibaba request contains only supported fields, JSON Object mode, and thinking disabled',()=>{
  const cfg=configFromEnv({ALIBABA_SHADOW_INPUT_USD_PER_MILLION:'',ALIBABA_SHADOW_OUTPUT_USD_PER_MILLION:''});
  const request=buildRequest(snapshot(),cfg);
  assert.deepEqual(Object.keys(request).sort(),['enable_thinking','max_tokens','messages','model','response_format','temperature']);
  assert.equal(request.model,'qwen3.7-flash');assert.equal(request.enable_thinking,false);
  assert.equal(cfg.inputUsdPerMillion,.03);assert.equal(cfg.outputUsdPerMillion,.13);assert.equal(cfg.pricingKnown,true);
  assert.deepEqual(request.response_format,{type:'json_object'});assert.equal(RESPONSE_SCHEMA_VERSION,'ORAYAN_ALIBABA_SHADOW_RESPONSE_V1');
});

test('structured output normalizes novel reasons but rejects structural violations',async()=>{
  const novel=decision({decision:'SKIP',risk_level:'HIGH',reason_codes:['NOVEL_MODEL_LABEL'],reason_notes:['bounded detail']});
  const normalized=await advise(snapshot(),{config:config(),mode:'mock',nowMs:Date.parse('2026-09-28T10:00:05Z'),mockTransport:okTransport(novel)});
  assert.equal(normalized.status,'OK');assert.deepEqual(normalized.decision.reason_codes,['OTHER_MODEL_REASON']);
  const invalid=decision({unexpected:true});
  const rejected=await advise(snapshot(),{config:config(),mode:'mock',nowMs:Date.parse('2026-09-28T10:00:05Z'),mockTransport:okTransport(invalid)});
  assert.equal(rejected.status,'MALFORMED_OUTPUT');assert.equal(rejected.decision.decision,'ABSTAIN');
  assert.ok(validateDecision(invalid,snapshot()).includes('additional_property:unexpected'));
});

test('400/401/403/429/5xx classification is sanitized and has no retry',async()=>{
  const expected=new Map([[400,'API_400_SCHEMA'],[401,'API_401_AUTH'],[403,'API_403_FORBIDDEN'],[429,'API_429_RATE_LIMIT'],[503,'API_5XX']]);
  for(const [status,label] of expected){let calls=0;
    const result=await postAlibaba({}, {apiKey:'sk-secret-test-key',timeoutMs:100,fetchImpl:async()=>{calls+=1;return {
      ok:false,status,headers:{get:()=>null},text:async()=>JSON.stringify({error:{type:'bad',code:'json_schema',
        message:'Bearer sk-secret-test-key '+('x'.repeat(800))}})};}});
    assert.equal(result.status,label);assert.equal(calls,1);assert.ok(result.error.message.length<=512);
    assert.doesNotMatch(result.error.message,/sk-secret-test-key|Bearer/);
  }
});

test('Singapore endpoint validation permits shared/workspace URLs and rejects other regions',()=>{
  assert.match(endpointFor(),/dashscope-intl.*chat\/completions$/);
  assert.match(endpointFor('https://abc123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1'),/chat\/completions$/);
  assert.throws(()=>endpointFor('https://dashscope.aliyuncs.com/compatible-mode/v1'),error=>error.code==='ALIBABA_BASE_URL_NOT_SINGAPORE');
});

test('provider usage reconciles token and cost reservations',async()=>{
  const cfg=config(),now=Date.parse('2026-09-28T10:00:05Z');
  const result=await advise(snapshot(),{config:cfg,mode:'mock',nowMs:now,completedMs:now+1,mockTransport:okTransport()});
  const state=await ledger.ledgerState(cfg.ledger,now,{allowedRoot:cfg.allowedRoot});
  assert.equal(result.tokens.total,3400);assert.equal(result.estimated_cost_usd,estimatedCostUsd(3000,400,cfg));
  assert.equal(state.dayTokens,3400);assert.equal(state.dayCostUsd,result.estimated_cost_usd);
  assert.equal(state.summary.estimatedCostUsd,result.estimated_cost_usd);
});

test('daily dollar cap prevents a provider call',async()=>{
  const cfg=config(),now=Date.parse('2026-09-28T10:00:05Z');cfg.maxCostUsdDay=.000001;
  let calls=0;const result=await advise(snapshot(),{config:cfg,mode:'mock',nowMs:now,mockTransport:async()=>{calls+=1;return okTransport()();}});
  assert.equal(result.status,'BUDGET_EXHAUSTED');assert.match(result.decision.missing_or_stale[0],/DAILY_COST_BUDGET/);assert.equal(calls,0);
});

test('minute pressure defers fresh work and expires stale work',async()=>{
  for(const age of [5000,75000]){const cfg=config(),birth=Date.parse('2026-09-28T10:00:00Z'),now=birth+age;
    cfg.maxTokensMinute=1000;cfg.maxDeferAgeMs=75000;
    ledger.appendImmutable(cfg.ledger,{record_type:'REQUEST_STARTED',request_id:'prior',candidate_id:'prior',input_snapshot_hash:'prior',
      requested_at_utc:new Date(now-1000).toISOString(),estimated_tokens_reserved:999,estimated_cost_usd_reserved:0},
      {allowedRoot:cfg.allowedRoot});
    const result=await advise(snapshot(),{config:cfg,mode:'mock',nowMs:now,mockTransport:okTransport()});
    assert.equal(result.status,age<75000?'BUDGET_DEFERRED':'ABSTAIN_BUDGET_STALE');
  }
});

test('orphaned durable start is terminalized and never billed twice',async()=>{
  const cfg=config(),now=Date.parse('2026-09-28T10:00:05Z');let calls=0;
  await assert.rejects(advise(snapshot(),{config:cfg,mode:'mock',nowMs:now,mockTransport:async()=>{calls+=1;throw Error('crash');}}),/crash/);
  ledger._test.resetCaches();
  const again=await advise(snapshot(),{config:cfg,mode:'mock',nowMs:now+1,mockTransport:async()=>{calls+=1;return okTransport()();}});
  assert.equal(again.status,'DUPLICATE_IGNORED');assert.equal(calls,1);
  const rows=fs.readFileSync(cfg.ledger,'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row=>row.status),['REQUEST_STARTED','INTERRUPTED_UNKNOWN_OUTCOME']);
});

test('bounded single-worker queue rejects overflow and recovers after failure',async()=>{
  let release;const hold=new Promise(resolve=>{release=resolve;});
  const queue=new BoundedShadowQueue({maxSize:1,worker:async()=>hold}),first=queue.enqueue(snapshot());
  await assert.rejects(queue.enqueue(snapshot()),error=>error.code==='QUEUE_FULL');release('done');assert.equal(await first,'done');
  let calls=0;const second=new BoundedShadowQueue({maxSize:2,worker:async()=>{calls+=1;if(calls===1)throw Error('failed');return 'ok';}});
  await assert.rejects(second.enqueue(snapshot()),/failed/);assert.equal(await second.enqueue(snapshot()),'ok');
});

test('package has no executor or gates integration and engine does not await the producer',()=>{
  const root=path.resolve(__dirname,'../../..');
  for(const file of ['backend/lib/executor.js','backend/lib/gates.js'])assert.doesNotMatch(
    fs.readFileSync(path.join(root,file),'utf8'),/alibaba[-_ ]?shadow|ALIBABA_SHADOW/i);
  const engine=fs.readFileSync(path.join(root,'backend/lib/engine.js'),'utf8');
  assert.match(engine,/alibabaShadowProducer\.observeBirth\(/);assert.doesNotMatch(engine,/await\s+alibabaShadowProducer\.observeBirth/);
});
