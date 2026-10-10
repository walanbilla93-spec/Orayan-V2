"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const payload=require('../lib/researchPayload'),minimal=require('../lib/minimalCapture');
for(const p of ['groq','alibaba']) {
 test(p+' lean request removes repetition while durable input remains untouched',()=>{
  const s=require('./fixtures/'+p+'Candidate')(),original=JSON.stringify(s),advisor=require('../../research/'+p+'-shadow/src/advisor'),config=advisor.configFromEnv({});
  s.debug={large:'x'.repeat(10000)};s.history=Array(100).fill({price:1});s.model_confidence_map={BUY:.9};
  const lean=payload.build(advisor.buildLegacyRequest(s,config),s,require('../../research/'+p+'-shadow/src/constants').RESPONSE_SCHEMA);
  const content=JSON.parse(lean.messages[1].content),body=JSON.stringify(content.candidate);
  assert.equal(content.candidate.snapshot_at_utc,s.candidate_birth_at_utc);
  assert.equal((body.match(/2026-/g)||[]).length,1);
  for(const k of ['debug','history','model_confidence_map','schema_version','version','engine'])assert.ok(!body.includes('"'+k+'"'));
  assert.ok(!body.includes('[]'));assert.ok(!body.includes('{}'));
  assert.equal(content.candidate.planned_trade.entry,s.planned_trade.entry);
  assert.equal(content.candidate.h2.features.linear_breadth.delta,s.h2.features.linear_breadth.delta);
  assert.ok(Buffer.byteLength(JSON.stringify(lean))<Buffer.byteLength(JSON.stringify(advisor.buildLegacyRequest(s,config))));
  assert.equal(payload.staleReasons(s,Date.parse(s.candidate_birth_at_utc)+5000,75000).length,0);
  assert.ok(payload.staleReasons(s,Date.parse(s.candidate_birth_at_utc)+80000,75000).length);
  assert.ok(original.includes('version'));assert.ok(JSON.stringify(s).includes('observed_at_utc'));
 });
 test(p+' stale advisor performs zero provider calls',async(t)=>{
  const fs=require('fs'),path=require('path'),os=require('os'),{ResearchStore}=require('../lib/researchStore');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lean-stale-')),store=new ResearchStore(dir,{reserveBytes:0});
  const old={current:minimal.current,researchEnabled:minimal.researchEnabled};minimal.current=()=>store;minimal.researchEnabled=()=>true;
  t.after(()=>{Object.assign(minimal,old);fs.rmSync(dir,{recursive:true,force:true});});
  const advisor=require('../../research/'+p+'-shadow/src/advisor'),s=require('./fixtures/'+p+'Candidate')();
  require('../../research/'+p+'-shadow/src/ledger')._test.resetCaches();let calls=0;
  const result=await advisor.advise(s,{config:{...advisor.configFromEnv({}),ledger:path.join(dir,'unused'),allowedRoot:dir},nowMs:Date.parse(s.candidate_birth_at_utc)+80000,mode:'mock',mockTransport:async()=>{calls++;throw Error('should not dispatch');}});
  assert.equal(calls,0);assert.ok(['LOCAL_ABSTAIN','ABSTAIN_BUDGET_STALE'].includes(result.status));assert.equal(result.decision.decision,'ABSTAIN');assert.equal(Object.keys(store.state.aiAttempts||{}).length,0);
 });
}
test('missing useful context is bounded and retained by both parsers',()=>{
 for(const p of ['groq','alibaba']){const module=require('../../research/'+p+'-shadow/src/snapshot');const s=require('./fixtures/'+p+'Candidate')();const decision={decision:'RETAIN',risk_level:'LOW',confidence:.5,reason_codes:['EVIDENCE_COMPLETE'],reason_notes:[],evidence_keys:['h1.state'],missing_or_stale:[],rationale_short:'Evidence supports retain',missing_useful_data:['validated correlation context']};assert.deepEqual(module.validateDecision(decision,s),[]);assert.deepEqual(module.normalizeDecision(decision).decision.missing_useful_data,decision.missing_useful_data);assert.ok(module.validateDecision({...decision,missing_useful_data:[1]},s).includes('missing_useful_data:invalid'));}
});
