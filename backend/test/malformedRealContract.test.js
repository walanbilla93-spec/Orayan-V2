'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const payload=require('../lib/researchPayload'),minimal=require('../lib/minimalCapture');
const {ResearchStore,sha}=require('../lib/researchStore'),archive=require('../lib/researchArchive');
const fixtures=fs.readdirSync(path.join(__dirname,'fixtures/malformed-real')).filter(f=>f.endsWith('.json')).map(f=>require('./fixtures/malformed-real/'+f));
for(const fixture of fixtures){
 const original=fixture.chain.find(r=>r.event==='PARSED_RESPONSE'),provider=original.provider==='Groq'?'groq':'alibaba';
 const parser=require('../../research/'+provider+'-shadow/src/snapshot');
 test(provider+' real malformed response remains an exact safe abstention '+original.attemptId,()=>{
  const raw=fixture.chain.find(r=>r.event==='RAW_RESPONSE');
  assert.equal(sha(raw.rawResponse),raw.unredactedSha256);
  const body=JSON.parse(raw.rawResponse);assert.equal(body.choices[0].finish_reason,'stop');
  const parsed=JSON.parse(body.choices[0].message.content),normalized=parser.normalizeDecision(parsed);
  const errors=parser.validateDecision(normalized.decision,JSON.parse(fixture.request.messages[1].content).candidate);
  assert.deepEqual(errors,original.normalizedResponse.missing_or_stale);
  assert.equal(original.normalizedResponse.decision,'ABSTAIN');assert.equal(original.disposition,'INVALID');
  assert.equal(original.tradeDisposition,'NO_EXECUTION_AUTHORITY');
  assert.equal(sha(JSON.stringify(fixture.request)),fixture.chain.find(r=>r.event==='REQUEST_PREPARED').exactRequestSha256);
 });
 test(provider+' raw replay captures parse separately, redacts secrets, and exports causal closure '+original.attemptId,async(t)=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'real-contract-')),store=new ResearchStore(dir,{reserveBytes:0,secrets:['fixture-secret-value']});
  const old={current:minimal.current,researchEnabled:minimal.researchEnabled};minimal.current=()=>store;minimal.researchEnabled=()=>true;
  t.after(()=>{Object.assign(minimal,old);fs.rmSync(dir,{recursive:true,force:true});});
  const advisor=require('../../research/'+provider+'-shadow/src/advisor'),s=require('./fixtures/'+provider+'Candidate')();
  require('../../research/'+provider+'-shadow/src/ledger')._test.resetCaches();
  const raw=fixture.chain.find(r=>r.event==='RAW_RESPONSE').rawResponse;
  const result=await advisor.advise(s,{config:{...advisor.configFromEnv({}),apiKey:'fixture-secret-value',ledger:path.join(dir,'ledger'),allowedRoot:dir},nowMs:Date.parse(s.candidate_birth_at_utc),mode:'mock',mockTransport:async()=>({ok:true,status:'OK',httpStatus:200,body:JSON.parse(raw),rawText:raw,headers:{}})});
  assert.equal(result.status,'MALFORMED_OUTPUT');assert.equal(result.decision.decision,'ABSTAIN');
  const rows=[];await archive.rows(store,r=>rows.push(r));
  const request=rows.find(r=>r.event==='REQUEST_PREPARED'),response=rows.find(r=>r.event==='RAW_RESPONSE'),parsed=rows.find(r=>r.event==='PARSED_RESPONSE');
  assert.ok(request.sequence<response.sequence&&response.sequence<parsed.sequence);
  assert.deepEqual(parsed.parsed,JSON.parse(JSON.parse(raw).choices[0].message.content));
  assert.equal(parsed.tradeDisposition,'NO_EXECUTION_AUTHORITY');assert.equal(parsed.finalEndpoint,'EPISODE_ENDPOINT_REFERENCE');
  assert.equal(request.payloadVersion,'ORAYAN_LEAN_AI_V2');assert.equal(parsed.parserVersion,'ORAYAN_AI_PARSE_V2');assert.equal(parsed.normalizationVersion,'PROVIDER_NORMALIZE_V1');
  assert.ok(!JSON.stringify(rows).includes('fixture-secret-value'));
  const chosen=archive.closure(store,[response.eventId],original.provider);
  assert.ok(chosen.has(request.eventId));assert.ok(chosen.has(parsed.eventId));
  const zip=path.join(dir,'review.zip');await archive.build(store,{target:zip,provider:original.provider});
  const manifest=await archive.verify(zip);assert.equal(manifest.complete,true);
 });
}
for(const provider of ['groq','alibaba'])test(provider+' clarified contract preserves request limits and safe parsing',()=>{
 const advisor=require('../../research/'+provider+'-shadow/src/advisor'),constants=require('../../research/'+provider+'-shadow/src/constants'),parser=require('../../research/'+provider+'-shadow/src/snapshot');
 const s=require('./fixtures/'+provider+'Candidate')(),config=advisor.configFromEnv({}),base=advisor.buildLegacyRequest(s,config),lean=payload.build(base,s,constants.RESPONSE_SCHEMA);
 for(const key of Object.keys(base).filter(k=>!['messages','response_format'].includes(k)))assert.deepEqual(lean[key],base[key]);
 assert.equal(lean.response_format.type,base.response_format.type);
 const schema=provider==='groq'?lean.response_format.json_schema.schema:JSON.parse(lean.messages[1].content).response_contract;
 assert.deepEqual(schema.properties.risk_level.enum,['LOW','MEDIUM','HIGH','UNKNOWN']);assert.deepEqual(schema.properties.decision.enum,['RETAIN','SKIP','ABSTAIN']);
 assert.equal(schema.additionalProperties,false);assert.match(lean.messages[0].content,/at most 96/);assert.match(lean.messages[0].content,/numeric indexes/);
 const valid={decision:'RETAIN',risk_level:'LOW',confidence:.5,reason_codes:['EVIDENCE_COMPLETE'],reason_notes:[],evidence_keys:['h1.state'],missing_or_stale:[],rationale_short:'Causal evidence supports retain.',missing_useful_data:[]};
 assert.deepEqual(parser.normalizeDecision(valid).decision,valid);assert.deepEqual(parser.validateDecision(valid,payload.evidence(s)),[]);
 for(const unsafe of [null,[],{...valid,risk_level:'low'},{...valid,decision:'BUY'},{...valid,confidence:2},{...valid,evidence_keys:['invented.path']},{...valid,reason_notes:['x'.repeat(97)]}])assert.ok(parser.validateDecision(parser.normalizeDecision(unsafe).decision,payload.evidence(s)).length);
 if(provider==='alibaba')assert.ok(parser.validateDecision({...valid,execute:true},payload.evidence(s)).includes('additional_property:execute'));
});
