'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),vm=require('vm');
const lite=require('../lib/metaLite'),payload=require('../lib/researchPayload'),producer=require('../lib/alibabaShadowProducer');
const at=Date.parse('2026-10-14T10:00:00Z'),iso=n=>new Date(n).toISOString();
const signal={id:'C',symbol:'TESTUSDT',side:'BUY',entry:100,sl:98,tp:104,score:75,rr:2,btcRegime:'BULL_TREND',gates:{passed:true,failed:[]}};
const birth={kind:'candidate_birth',engine:'NEW_ORAYAN',episodeId:'EP',decisionAt:at,at,candidateKey:'KEY',configHash:'CFG',passed:true,failedGates:[]};
const context={scanAt:at,settings:{mode:'paper',timeframe:5,riskUsdtPerTrade:.25},btcRegime:{regime:'BULL_TREND',observedAt:at-2000},ticker:{bid:99.99,ask:100.01,markPrice:100,observedAt:at-1000},openPositions:[]};
const packet=(s=signal,c=context)=>payload.sharedBirth(s,birth,c,'EPOCH');
const altered=(p,mutate)=>{const x=JSON.parse(JSON.stringify(p));mutate(x.snapshot);return x;};

test('same immutable shared packet identity; deterministic replay; bounded compact output',()=>{
  const p=packet(),r=lite.evaluate(p);
  assert.equal(r.status,'OK_RETAIN');assert.equal(r.cohort_id,p.identity.cohort_id);assert.equal(r.shared_context_hash,p.identity.shared_context_hash);
  assert.deepEqual(lite.evaluate(JSON.parse(JSON.stringify(p))),r);
  assert.ok(Buffer.byteLength(JSON.stringify(r))<2048);assert.ok(Object.isFrozen(p.snapshot));
  assert.deepEqual(Object.keys(r.input).sort(),['cutoff','side','entry','stop','target','bid','ask','quote_observed','quote_received','regime','regime_observed','regime_received'].sort());
});
test('fixed independent rules retain, skip and abstain, including SELL geometry',()=>{
  assert.equal(lite.evaluate(packet({...signal,tp:102})).reason_codes[0],'LOW_REWARD_RISK');
  assert.ok(lite.evaluate(packet(signal,{...context,ticker:{...context.ticker,bid:99.8,ask:100.2}})).reason_codes.includes('SPREAD_STOP_FRACTION'));
  assert.ok(lite.evaluate(packet(signal,{...context,btcRegime:{regime:'BEAR_TREND',observedAt:at-1000}})).reason_codes.includes('OPPOSING_REGIME'));
  assert.equal(lite.evaluate(packet({...signal,side:'SELL',sl:102,tp:96},{...context,btcRegime:{regime:'BEAR_TREND',observedAt:at-1000}})).status,'OK_RETAIN');
  assert.equal(lite.evaluate(packet({...signal,sl:101})).status,'OK_ABSTAIN');
  assert.equal(lite.evaluate(packet(signal,{...context,btcRegime:{regime:'CHOP',observedAt:at}})).status,'OK_RETAIN');
});
test('Orayan gates, outcomes, score, H1/H2, risk flags cannot enter projection or alter policy',()=>{
  const p=packet(),r=lite.evaluate(p);
  const dirty=altered(p,s=>{s.gates={passed:false};s.admission='REJECT';s.outcome={netPnl:1e9};s.score={value:-999};s.h1={state:'SKIP'};s.h2={state:'SKIP'};s.risk_flags=['FINAL_REJECT'];s.reason_flags=['SKIP'];});
  assert.deepEqual(lite.evaluate(dirty),r);
  // Building a real shared packet with opposite gate state also leaves the decision unchanged.
  assert.deepEqual(lite.project(packet({...signal,score:1,gates:{passed:false,failed:['FINAL_REJECT']}})),r.input);
});
test('future/missing groups, invalid clocks and stale sources explicitly unavailable without values',()=>{
  const p=packet();
  for(const field of ['quote_observed','quote_received','regime_observed','regime_received']) {
    const [group,key]=field.startsWith('quote')?['quote',field.endsWith('observed')?'observed_at_utc':'available_to_system_at_utc']:['regime',field.endsWith('observed')?'observed_at_utc':'available_to_system_at_utc'];
    for(const value of [iso(at+1),null,'invalid']) {
      const bad=altered(p,s=>{(group==='quote'?s.planned_trade.quote_evidence:s.regime)[key]=value;});
      const r=lite.evaluate(bad);assert.equal(r.status,'INPUT_UNAVAILABLE');assert.equal(r.decision,'ABSTAIN');assert.equal(r.input,null);
    }
  }
  assert.equal(lite.evaluate(packet(signal,{...context,ticker:null})).status,'INPUT_UNAVAILABLE');
  assert.equal(lite.evaluate(packet(signal,{...context,ticker:{...context.ticker,observedAt:at+1}})).status,'INPUT_UNAVAILABLE');
  assert.equal(lite.evaluate(packet(signal,{...context,ticker:{...context.ticker,observedAt:at-15001}})).reason_codes[0],'SOURCE_STALE');
  assert.equal(lite.evaluate(null).status,'INPUT_UNAVAILABLE');
  assert.equal(lite.unavailable(birth,'EPOCH','EVALUATOR_ERROR',p).status,'CENSORED_OPERATIONAL');
  assert.equal(lite.unavailable(birth,'EPOCH','EVALUATOR_ERROR',p).shared_context_hash,p.identity.shared_context_hash);
});
test('policy loads and evaluates without any network, acquisition, timers or provider dependencies',()=>{
  const source=fs.readFileSync(require.resolve('../lib/metaLite'),'utf8');let imports=0;
  const sandbox={module:{exports:{}},require:()=>{imports++;throw Error('I/O forbidden');},fetch:()=>{throw Error('network');},setTimeout:()=>{throw Error('timer');},setInterval:()=>{throw Error('timer');}};
  vm.runInNewContext(source,sandbox);assert.equal(sandbox.module.exports.evaluate(packet()).status,'OK_RETAIN');assert.equal(imports,0);
});
test('existing canonical append embeds result once, restart/replay dedupes, outcomes stay native',async t=>{
  const minimal=require('../lib/minimalCapture'),{ResearchStore}=require('../lib/researchStore'),archive=require('../lib/researchArchive');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'meta-lite-')),old={current:minimal.current,researchEnabled:minimal.researchEnabled};
  let c=new ResearchStore(dir,{epochId:'EPOCH',reserveBytes:0});minimal.current=()=>c;minimal.researchEnabled=()=>true;
  t.after(()=>{Object.assign(minimal,old);fs.rmSync(dir,{recursive:true,force:true});});
  c.emit('definitions',{definitionId:'CFG',config:{mode:'paper'}});
  const r=lite.evaluate(packet());minimal.native(signal,birth,context.settings,r);const seq=c.state.sequence;
  minimal.native(signal,birth,context.settings,r);assert.equal(c.state.sequence,seq);
  c.flush();c=new ResearchStore(dir,{epochId:'IGNORED',reserveBytes:0});const resumed=c.state.sequence;
  minimal.native(signal,birth,context.settings,r);assert.equal(c.state.sequence,resumed);
  const rows=[];await archive.rows(c,row=>rows.push(row));const births=rows.filter(x=>x.meta_lite);
  assert.equal(births.length,1);assert.equal(births[0].stream,'decisions');assert.deepEqual(births[0].meta_lite,r);
  assert.equal(rows.filter(x=>x.stream==='outcomes').length,0,'no hypothetical outcome created');
  assert.equal(c.status().lostRows,0);assert.equal(c.status().health,'HEALTHY');
  // Native admission/lifecycle may proceed independently; comparator is not reattached.
  minimal.nativeOutcome({candidateId:'C',episodeId:'EP',event:'ORDER_INTENT',at:at+1,signature:'N'},null);
  const after=[];await archive.rows(c,row=>after.push(row));assert.equal(after.filter(x=>x.meta_lite).length,1);
});
test('real canonical birth hook runs once; updates do not create another comparator',t=>{
  const minimal=require('../lib/minimalCapture'),capture=require('../lib/researchCapture');
  const old={enabled:minimal.enabled,native:minimal.native};let evaluated=0;const outputs=[];
  minimal.enabled=()=>true;minimal.native=(s,b,settings,r)=>outputs.push(r);
  t.after(()=>Object.assign(minimal,old));
  const ctx={...context,scanId:'SCAN',candles:[],snapshot:null,birthResearch:b=>{evaluated++;assert.equal(b.kind,'candidate_birth');return lite.evaluate(payload.sharedBirth(signal,b,context,'EPOCH'));}};
  const s={...signal,id:'HOOK',symbol:'HOOKUSDT'};capture.birth(s,ctx);capture.birth(s,ctx);
  assert.equal(evaluated,1);assert.equal(outputs.filter(Boolean).length,1);
});
test('100k varied births retain no policy state; reason enum bounded and output compact',()=>{
  if(global.gc)global.gc();const before=process.memoryUsage().heapUsed,start=performance.now();let maxBytes=0;
  const packets=[packet(),packet({...signal,tp:102}),packet({...signal,sl:101})];
  for(let n=0;n<100000;n++) {
    const p={...packets[n%3],identity:{...packets[n%3].identity,opportunity_id:'E'+n}};const r=lite.evaluate(p);
    for(const code of r.reason_codes)assert.ok(lite.REASONS.includes(code));
    if(n<100)maxBytes=Math.max(maxBytes,Buffer.byteLength(JSON.stringify(r)));
  }
  if(global.gc)global.gc();const growth=process.memoryUsage().heapUsed-before;
  assert.ok(growth<8*1024*1024,'no retained per-birth state');assert.ok(maxBytes<2048);
  console.log(JSON.stringify({births:100000,totalMs:performance.now()-start,postGcHeapGrowth: growth,maxResultBytes:maxBytes}));
});
