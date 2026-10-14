'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto');
const payload=require('../lib/researchPayload'),producer=require('../lib/alibabaShadowProducer'),minimal=require('../lib/minimalCapture');
const {canonical}=require('../lib/researchRequest');
const sha=v=>crypto.createHash('sha256').update(canonical(v)).digest('hex');
const at=Date.parse('2026-09-28T10:00:00Z');
function input(extra={}) {
  return {scanAt:at,settings:{riskUsdtPerTrade:.25},btcRegime:{regime:'BULL_TREND',strength:70,observedAt:at-2000},
    ticker:{observedAt:at-1000,bid:99.9,ask:100.1,markPrice:100},openPositions:[],...extra};
}
function seed() {
  producer._test.reset();
  for (const t of [at-600000,at-1000]) producer.observeEnvironment({at:t,
    marketSnapshot:{observedAt:t-1000,directionalBreadth:20,universeCount:100,btcReturn1:.01,btcReturn3:.02},
    tickers:['BTCUSDT','ETHUSDT'].map(symbol=>({symbol,observedAt:t-1000,change24hPct:1,fundingRate:.0001,openInterest:1000}))});
}
function packet(extra={}) {
  return payload.sharedBirth({id:'C',symbol:'TESTUSDT',side:'BUY',entry:100,sl:98,tp:104,rr:2,atr:1,score:75,signalSource:'ORAYAN',gates:{failed:[]}},
    {kind:'candidate_birth',engine:'NEW_ORAYAN',episodeId:'EP',decisionAt:at},input(extra),'EPOCH');
}
function snapshots(p) {return ['groq','alibaba'].map(name=>payload.providerSnapshot(p,require('../../research/'+name+'-shadow/src/constants').INPUT_SCHEMA_VERSION));}
test.beforeEach(seed);
test('one birth shares immutable evidence object, hash and cohort across transport schemas',()=>{
  const p=packet(),ss=snapshots(p);
  assert.ok(Object.isFrozen(p.snapshot));assert.ok(Object.isFrozen(p.evidence.h2.features));
  assert.equal(payload.evidence(ss[0]),p.evidence);assert.equal(payload.evidence(ss[1]),p.evidence);
  assert.equal(sha(p.evidence),p.identity.shared_context_hash);
  assert.equal(p.identity.cohort_id,sha([payload.PACKET_VERSION,'EPOCH','EP']));
  const bodies=ss.map((s,i)=>{const n=['groq','alibaba'][i],a=require('../../research/'+n+'-shadow/src/advisor'),c=require('../../research/'+n+'-shadow/src/constants');
    return JSON.parse(payload.build(a.buildLegacyRequest(s,{...a.configFromEnv({}),model:i?'other-model':'first-model'}),s,c.RESPONSE_SCHEMA).messages[1].content).candidate;});
  assert.deepEqual(bodies[0],bodies[1]);assert.equal(sha(bodies[0]),p.identity.shared_context_hash);
  assert.equal(sha(payload.evidence({...ss[0],schema_version:'other',model:'other',max_tokens:1})),p.identity.shared_context_hash);
});
test('construction has zero market acquisition and no retained evidence JSON copy',()=>{
  const market=require('../lib/marketData'),old={};let calls=0;
  for(const [k,v]of Object.entries(market))if(typeof v==='function'){old[k]=v;market[k]=()=>{calls++;throw Error('market acquisition forbidden');};}
  try {const p=packet();assert.equal(calls,0);assert.ok(!JSON.stringify(p.snapshot).includes('sharedEvidence'));}
  finally{Object.assign(market,old);}
});
test('missing quote is represented identically and both local validators abstain',()=>{
  const p=packet({ticker:null}),ss=snapshots(p);
  assert.deepEqual(payload.evidence(ss[0]),payload.evidence(ss[1]));
  for(const [i,n]of ['groq','alibaba'].entries())assert.ok(require('../../research/'+n+'-shadow/src/snapshot').validateSnapshot(ss[i],at+5000).abstainReasons.length);
});
test('future and invalid observation/receipt groups lose all values before hashing',()=>{
  const p=packet({ticker:{observedAt:at+1,bid:999,ask:1000,markPrice:999},btcRegime:{regime:'BULL_TREND',strength:99,observedAt:at+1}});
  assert.equal(p.snapshot.planned_trade.quote_evidence.bid,undefined);assert.equal(p.snapshot.regime.strength,undefined);
  assert.equal(p.snapshot.h1.state,'ABSTAIN');assert.ok(!canonical(p.evidence).includes('999'));
  for(const s of snapshots(p))assert.equal(sha(payload.evidence(s)),p.identity.shared_context_hash);
  const feature=producer._test.environment[0].btc_return_24h;feature.availableAt=at+1;
  const bad=packet();assert.equal(bad.snapshot.h2.features.btc_return_24h.current,undefined);assert.equal(bad.snapshot.h2.state,'ABSTAIN');
});
test('restart and replay from canonical snapshot preserves hash, cohort and no-clock reconstruction',()=>{
  const p=packet();seed();const again=packet();assert.deepEqual(again.identity,p.identity);
  for(const s of snapshots(p)){const disk=JSON.parse(JSON.stringify(s));assert.equal(sha(payload.evidence(disk)),p.identity.shared_context_hash);
    assert.equal(disk.shared_context.cohort_id,p.identity.cohort_id);}
});
test('engine dispatches once per provider, shares one builder result and leaves PAPER sizing/execution unchanged',async()=>{
  const vm=require('vm'),root=path.resolve(__dirname,'../..'),source=fs.readFileSync(path.join(root,'backend/lib/engine.js'),'utf8').replace(/\r\n/g,'\n');
  const a=source.indexOf('      // Fire-and-forget shadow research'),b=source.indexOf('      // Shadow-only sidecar.',a),block=source.slice(a,b);
  const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
  assert.equal(hash(source.slice(0,a)+source.slice(b)),'f5665535be164b058c3463d6843f85a4771bdec4b5419e56393d18f9f65eb7ed','all engine code outside the birth handoff unchanged');
  const protectedFiles={'signals.js':'a0b39835e78ed1326a6a07fb1a7eb8d6844b9bdf15ded5bad6f0e02f90671924','gates.js':'30316c24a2b52c96a4f4d1d612dbe688c2759038260d69bca39cc07fa8171048','risk.js':'14dbd15d6fc91c81a4d0aab17cb7a2f061d0301514341ea0cb6cc0f8519610ef','executor.js':'329aac63f3d11efaeac3034bcc1a1ce302754dd089c5c54d98352bf41dbfaa18'};
  for(const [p,h]of Object.entries(protectedFiles))assert.equal(hash(fs.readFileSync(path.join(root,'backend/lib',p),'utf8').replace(/\r\n/g,'\n')),h,p);
  const contexts=[],p=packet();let builds=0;const signal={id:'C',symbol:'TESTUSDT',side:'BUY',entry:100,sl:98,tp:104,market:{turnover24h:1000}};
  const ctx={signal,birth:{kind:'candidate_birth',engine:'NEW_ORAYAN',episodeId:'EP',decisionAt:at},scanAt:at,settings:input().settings,marketSnapshot:{},tickerBySymbol:new Map(),btcRegime:input().btcRegime,openTrades:()=>[],pendingTrades:()=>[],logger:{warn(){}},
    groqShadowProducer:{observeBirth:(s,b,c)=>contexts.push(c)},alibabaShadowProducer:{observeBirth:(s,b,c)=>contexts.push(c)},
    require:n=>n==='./minimalCapture'?{researchEnabled:()=>true,current:()=>({state:{epochId:'EPOCH'}})}:n==='./researchPayload'?{sharedBirth:()=>{builds++;return p;}}:{notRequested(){}}};
  vm.runInNewContext(block,ctx);assert.equal(builds,1);assert.equal(contexts.length,2);assert.equal(contexts[0].sharedPacket,contexts[1].sharedPacket);
  const risk=require('../lib/risk'),executor=require('../lib/executor'),market=require('../lib/marketData');
  const settings={mode:'paper',riskUsdtPerTrade:.25,maxNotionalUsdt:1000,leverage:1,entryWindowMin:10,entryBufferBps:0,tpThroughBps:0,slSlipBps:0,makerFeePct:.02,takerFeePct:.055};
  const sizing=risk.sizePosition({entry:signal.entry,sl:signal.sl,settings,instrument:{qtyStep:.001,tickSize:.01,minOrderQty:.001}});
  assert.equal(sizing.actualRisk,.25);assert.equal(sizing.qty,.125);
  const trade=executor.createPendingOrder({signal,sizing,settings}),old=market.getCandles;market.getCandles=async()=>[{ts:trade.createdAt,open:100,low:99,high:105,close:104}];
  try{await executor.stepPaperTrade(trade,settings);assert.equal(trade.mode,'paper');assert.equal(trade.status,'CLOSED');assert.equal(trade.grossPnl,.5);assert.ok(Math.abs(trade.netPnl-.49035)<1e-9);}
  finally{market.getCandles=old;}
});
test('shared advisor calls, statuses, budgets, dedupe and one causal audit remain authoritative',async t=>{
  const {ResearchStore}=require('../lib/researchStore'),archive=require('../lib/researchArchive');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shared-ai-')),c=new ResearchStore(dir,{epochId:'EPOCH',reserveBytes:0});
  const old={current:minimal.current,researchEnabled:minimal.researchEnabled};minimal.current=()=>c;minimal.researchEnabled=()=>true;
  t.after(()=>{Object.assign(minimal,old);fs.rmSync(dir,{recursive:true,force:true});});
  c.emit('decisions',{sourceEpisodeId:'EP',boundary:'BIRTH'});
  const p=packet();let calls=0;
  for(const [i,n]of ['groq','alibaba'].entries()){
    const advisor=require('../../research/'+n+'-shadow/src/advisor'),ledger=require('../../research/'+n+'-shadow/src/ledger');ledger._test.resetCaches();
    const cfg={...advisor.configFromEnv({}),ledger:path.join(dir,n),allowedRoot:dir,apiKey:'fake',allowLive:true,maxRequestsDay:2};
    const invoke=async(s,reply,config=cfg)=>advisor.advise(s,{config,nowMs:at+5000,completedMs:at+6000,mode:'mock',mockTransport:async()=>{calls++;return reply;}});
    const good={ok:true,status:'OK',httpStatus:200,headers:{},body:{choices:[{message:{content:JSON.stringify({decision:'RETAIN',risk_level:'LOW',confidence:.5,reason_codes:['EVIDENCE_COMPLETE'],reason_notes:[],evidence_keys:['h1.state'],missing_or_stale:[],rationale_short:'Causal retain.'})}}],usage:{prompt_tokens:300,completion_tokens:40,total_tokens:340}}};
    const s=snapshots(p)[i];assert.equal((await invoke(s,good)).status,'OK');
    assert.equal((await invoke(s,good)).status,'DUPLICATE_IGNORED');
    const malformed=payload.attachShared(s,{...s,candidate_id:'M'+i});assert.equal((await invoke(malformed,{...good,body:{choices:[{message:{content:'bad json'}}]}})).status,'MALFORMED_OUTPUT');
    const budget=payload.attachShared(s,{...s,candidate_id:'B'+i});assert.equal((await invoke(budget,good)).status,'BUDGET_EXHAUSTED');
    const missing=snapshots(packet({ticker:null}))[i];assert.equal((await invoke({...missing,candidate_id:'L'+i},good)).status,'LOCAL_ABSTAIN');
    const error=payload.attachShared(s,{...s,candidate_id:'A'+i});assert.equal((await invoke(error,{ok:false,status:'API_5XX',httpStatus:503,body:null,headers:{}},{...cfg,maxRequestsDay:3})).status,'API_5XX');
    assert.equal(cfg.maxRequestsDay,2);
  }
  assert.equal(calls,6,'three calls per provider, none for missing, budget or duplicate');
  const rows=[];await archive.rows(c,r=>rows.push(r));const prep=rows.filter(r=>r.event==='REQUEST_PREPARED');
  assert.equal(prep[0].shared_context_hash,prep[3].shared_context_hash);assert.equal(prep[0].auditDefinitionId,prep[3].auditDefinitionId);
  assert.equal(rows.filter(r=>r.kind==='AI_FULL_CAUSAL_AUDIT'&&r.definition.snapshot.candidate_id==='C').length,1);
  for(const r of prep)assert.equal(r.cohort_id,p.identity.cohort_id);
  assert.equal(c.status().lostRows,0);assert.equal(c.status().health,'HEALTHY');
});
