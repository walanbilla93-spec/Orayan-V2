'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto');
const meta=require('../lib/metaBrainV1'),{EvidenceStore}=require('../lib/metaBrainResearch'),feedback=require('../lib/aiPostTradeFeedback');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const text=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8').replace(/\r\n/g,'\n');
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'resource-reset-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function packet(at=10000){return {identity:{source_epoch:'E',opportunity_id:'EP',cohort_id:'C',shared_context_hash:'H',birth_cutoff:new Date(at).toISOString()},
 snapshot:{symbol:'TESTUSDT',side:'BUY',candidate_birth_at_utc:new Date(at).toISOString(),planned_trade:{entry:100,sl:98,tp:104,quote_evidence:{bid:99.99,ask:100.01}},regime:{label:'BULL_TREND'},score:{value:75}}};}
function birth(at=10000){const p=packet(at);return {identity:p.identity,context:{side:'BUY',symbol:'TESTUSDT',regime:'BULL_TREND'},meta_lite:{decision:'RETAIN'},decision:{decision:'ABSTAIN',execution_authority:'NONE'}};}
function closed(at=20000){return {id:'T',mode:'paper',status:'CLOSED',symbol:'TESTUSDT',side:'BUY',filledAt:11000,closedAt:at,fillPrice:100,realisedRR:-1,fees:0.02,netPnl:-0.25};}
test('native management/admission and protected trading/comparator modules retain baseline bytes',()=>{
 const b=require('./fixtures/resourceResetBaseline.json'),s=text('lib/engine.js');
 for(const f of ['signals.js','gates.js','risk.js','executor.js','metaLite.js','researchPayload.js'])assert.equal(hash(text('lib/'+f)),b[f],f);
 const a=s.indexOf('async function manageOpenTrades(settings) {'),end=s.indexOf('async function scanOnce() {',a);
 assert.equal(hash(s.slice(a,end).trim()),b.native_management);
 const c=s.indexOf('    const blockReason = !settings.tradingEnabled'),d=s.indexOf('    for (const signal of journalSignals) {\n      if (signal.gates?.passed',c);
 assert.equal(hash(s.slice(c,d).trim()),b.native_admission);
});
test('no Marci acquisition, resident history, writes, discovery or UI polling remain',()=>{
 const s=text('lib/engine.js');
 for(const word of ['manageMarciCounterfactuals','manageShadowTrades','persistShadowTrades','shadowCandidates',"require('./marciIndependent')","require('./marciShadow')"])assert.ok(!s.includes(word),word);
 assert.ok(!/store\.read\('marci/.test(s));assert.ok(!/atomic\([^\n]*marci/.test(s));
 const ui=fs.readFileSync(path.join(__dirname,'../../frontend/app.js'),'utf8'),html=fs.readFileSync(path.join(__dirname,'../../frontend/index.html'),'utf8');
 assert.ok(!ui.includes('/api/shadow/trades'));assert.ok(!html.includes('data-view="shadow"'));
});
test('historical Marci read and retired reset never rewrite or rename evidence',t=>{
 const vm=require('vm'),dir=temp(t),file=path.join(dir,'marciShadowTrades.json'),rows=[{id:'old',status:'OPEN',createdAt:10}];fs.writeFileSync(file,JSON.stringify(rows));
 const s=text('lib/engine.js'),scope={require,store:{DATA_DIR:dir}};
 vm.createContext(scope);vm.runInContext(s.slice(s.indexOf('function historicalMarci()'),s.indexOf('let lastStopRecoveryBackfillAt'))+s.slice(s.indexOf('function getShadowTrades('),s.indexOf('function resetTrades()')),scope);
 const before=fs.readFileSync(file);assert.equal(scope.getShadowTrades()[0].id,'old');assert.equal(scope.resetShadowTrades().ok,false);assert.deepEqual(fs.readFileSync(file),before);
 fs.writeFileSync(file,'broken');assert.throws(()=>scope.getShadowTrades());assert.equal(fs.readFileSync(file,'utf8'),'broken');
});
test('feature allowlist excludes all future outcome fields and inference abstains without frozen model',()=>{
 const p=packet(),a=meta.project(p,{decision:'RETAIN'});p.snapshot.realized_r=999;p.snapshot.future={profit:100};
 assert.deepEqual(meta.project(p,{decision:'RETAIN'}),a);assert.equal(a.missing.length,0);
 const out=meta.infer(a,null,10001);assert.equal(out.decision,'ABSTAIN');assert.equal(out.execution_authority,'NONE');assert.equal(out.learning_influence,0);
});
test('frozen model validation rejects hash tampering, missing input and training after birth',()=>{
 const body={contract:meta.CONTRACT,features:meta.FEATURES,training_status:'DEVELOPMENT_TRAINED',execution_authority:'NONE',training_cutoff:new Date(100).toISOString(),weights:[0,0,0,0,0,0],means:[0,0,0,0,0,0],scales:[1,1,1,1,1,1],bias:2,retain_threshold:0.6,skip_threshold:0.4};
 const m={...body,model_id:meta.hash(body)},input=meta.project(packet(),{decision:'RETAIN'});
 assert.equal(meta.infer(input,m,10001).decision,'RETAIN');assert.throws(()=>meta.validate({...m,bias:99}));
 assert.equal(meta.infer({...input,missing:['native_score']},m,10001).decision,'ABSTAIN');
 const future={...body,training_cutoff:new Date(15000).toISOString()};assert.equal(meta.infer(input,{...future,model_id:meta.hash(future)},20000).decision,'ABSTAIN');
});
test('native PAPER close produces supported immutable feedback; loss is never false-signal assertion',t=>{
 const dir=temp(t),store=new EvidenceStore(dir),f=feedback.build(closed(),birth(),{}, {mfeR:2,maeR:-1},21000);
 assert.equal(f.lesson_category,'NEGATIVE_NET_R');assert.equal(f.false_signal_taxonomy,'AMBIGUOUS_UNSUPPORTED');assert.equal(f.path.intrabar_order,'UNKNOWN');assert.equal(f.original_ai.Qwen.status,'UNAVAILABLE');
 const bytes=JSON.stringify(closed());assert.equal(feedback.build({...closed(),mode:'live'},birth(),{}, {},21000),null);assert.equal(feedback.build({...closed(),engine:'MARCI_SHADOW'},birth(),{}, {},21000),null);
 store.put('feedback','T',f);assert.deepEqual(store.put('feedback','T',f),f);assert.throws(()=>store.put('feedback','T',{...f,lesson_category:'FALSE_SIGNAL'}));assert.equal(JSON.stringify(closed()),bytes);
 const restarted=new EvidenceStore(dir);assert.equal(restarted.lessons.length,1);assert.deepEqual(restarted.read('feedback','T'),f);
});
test('bounded deterministic retrieval excludes future availability, wrong epoch, own episode',t=>{
 const store=new EvidenceStore(temp(t));
 for(let i=0;i<300;i++){
  const b=birth();b.identity={...b.identity,opportunity_id:'prior'+i};const f=feedback.build({...closed(15000+i),id:'t'+i},b,{}, {},16000+i);
  store.put('feedback',i,f);
 }
 assert.equal(store.lessons.length,256);
 const p=packet(30000),ctx=birth().context,d=store.retrieve(ctx,p.identity);
 assert.ok(d.lessons.length>0&&d.lessons.length<=5);assert.ok(d.token_upper_bound<=1024);assert.deepEqual(store.retrieve(ctx,p.identity),d);
 assert.equal(store.retrieve(ctx,{...p.identity,source_epoch:'OTHER'}).lessons.length,0);
 assert.equal(store.retrieve(ctx,{...p.identity,birth_cutoff:new Date(15999).toISOString()}).lessons.length,0);
 const one=new EvidenceStore(temp(t)),b=birth(),f=feedback.build(closed(),b,{}, {},21000);one.put('feedback','own',f);
 assert.equal(one.retrieve(ctx,{...b.identity,birth_cutoff:new Date(30000).toISOString()}).lessons.length,0);
});
test('storage pressure preserves existing evidence and rejects additional oversized write',t=>{
 const store=new EvidenceStore(temp(t));store.put('birth','one',{v:1});const before=fs.readFileSync(store.file('birth','one'));
 assert.throws(()=>store.put('birth','huge',{v:'x'.repeat(9000)}));store.files=8192;assert.throws(()=>store.put('birth','two',{v:2}));assert.deepEqual(fs.readFileSync(store.file('birth','one')),before);
});
test('disabled feedback modes preserve exact base provider request bytes',()=>{
 const r=require('../lib/metaBrainResearch'),request={messages:[{role:'system',content:'frozen'},{role:'user',content:'{"candidate":{}}'}]};
 assert.strictEqual(r.decorate('QWEN',request,{},{}),request);assert.strictEqual(r.decorate('GROQ',request,{},{}),request);
});
test('enabled birth/AI/close plumbing survives restart, exports evidence, routes one bounded request per cohort/day',async t=>{
 const dir=temp(t),storage=require('../lib/store'),minimal=require('../lib/minimalCapture'),oldRoot=storage.DATA_DIR,oldCurrent=minimal.current;
 const keys=['META_BRAIN_V1_SHADOW','QWEN_FEEDBACK_ENABLED','QWEN_FEEDBACK_PERCENT','QWEN_FEEDBACK_MAX_REQUESTS_DAY'];
 const oldEnv=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 storage.DATA_DIR=dir;minimal.current=()=>({state:{epochId:'E',extremes:{T:{mfeR:0.2,maeR:-1}}}});
 process.env.META_BRAIN_V1_SHADOW='true';process.env.QWEN_FEEDBACK_ENABLED='true';process.env.QWEN_FEEDBACK_PERCENT='10';process.env.QWEN_FEEDBACK_MAX_REQUESTS_DAY='1';
 const mod=require.resolve('../lib/metaBrainResearch');delete require.cache[mod];let r=require(mod);
 t.after(()=>{storage.DATA_DIR=oldRoot;minimal.current=oldCurrent;for(const k of keys)if(oldEnv[k]===undefined)delete process.env[k];else process.env[k]=oldEnv[k];delete require.cache[mod];});
 const p=packet(Date.now()-100000),cutoff=Date.parse(p.identity.birth_cutoff);
 assert.equal(r.observeBirth(p,{decision:'RETAIN'},'candidate').decision,'ABSTAIN');
 r.observeAI({...p.identity,provider:'Alibaba',model:'frozen-qwen'},{status:'OK',decision:{decision:'SKIP',confidence:0.6}});
 const trade={...closed(Date.now()-50000),filledAt:cutoff+1000};
 const row={event:'CLOSED',episodeId:'EP'};const f=r.observeClose(row,trade);
 assert.equal(f.identity.shared_context_hash,'H');assert.equal(f.original_ai.Qwen.decision,'SKIP');assert.equal(f.path.mfe_r,0.2);
 assert.deepEqual(r.observeClose(row,trade),f);
 delete require.cache[mod];r=require(mod);assert.deepEqual(r.observeClose(row,trade),f);
 const request={model:'frozen-qwen',messages:[{role:'system',content:'frozen base prompt'},{role:'user',content:'{"candidate":{"side":"BUY"}}'}]};
 const choose=(start)=>{for(let i=start;i<start+10000;i++){const id='c'+i;if(parseInt(meta.hash(['QWEN',id]).slice(0,8),16)%100<10)return {id,next:i+1};}throw Error('no fixture cohort');};
 const chosen=choose(0),s={side:'BUY',symbol:'TESTUSDT',regime:{label:'BULL_TREND'},shared_context:{...p.identity,opportunity_id:'NEW',cohort_id:chosen.id,birth_cutoff:new Date(Date.now()+1000).toISOString()}};
 const decorated=r.decorate('QWEN',request,s);assert.notEqual(decorated,request);assert.equal(decorated.messages[0].content,request.messages[0].content);
 const memory=JSON.parse(decorated.messages[1].content).reflection_memory;assert.equal(memory.mode,'QWEN_FEEDBACK');assert.ok(memory.lessons.length<=5);assert.ok(Buffer.byteLength(JSON.stringify(memory))<2048);
 assert.deepEqual(r.decorate('QWEN',request,s),decorated);
 delete require.cache[mod];r=require(mod);assert.deepEqual(r.decorate('QWEN',request,s),decorated);
 const next=choose(chosen.next);assert.strictEqual(r.decorate('QWEN',request,{...s,shared_context:{...s.shared_context,cohort_id:next.id,opportunity_id:'NEW2'}}),request);
 let exported='';for await(const chunk of r.download().stream)exported+=chunk;
 const rows=exported.trim().split('\n').map(JSON.parse);assert.ok(rows.some(x=>x.contract==='AI_POST_TRADE_FEEDBACK_V1'));assert.ok(rows.some(x=>x.decision?.version==='META_BRAIN_V1'));
 assert.equal(r.status().execution_authority,'NONE');
});
test('reproducible offline development fit accepts only prior, resolved curriculum and never overwrites output',async t=>{
 const dir=temp(t),file=path.join(dir,'input.jsonl'),train=require('../tools/train-meta-brain-v1').train;
 const rows=Array.from({length:30},(_,i)=>({contract:meta.CONTRACT,episode_id:'e'+i,birth_cutoff:new Date(100).toISOString(),resolved_at:200,available_at:300,realized_r:i%2?1:-1,values:{reward_risk:2,spread_risk:0.01,native_score:50+i,side:1,regime_alignment:1,meta_lite:1}}));
 fs.writeFileSync(file,rows.map(JSON.stringify).join('\n'));
 const a=await train(file,new Date(1000).toISOString(),path.join(dir,'a.json')),b=await train(file,new Date(1000).toISOString(),path.join(dir,'b.json'));
 assert.deepEqual(a,b);assert.equal(a.training_status,'DEVELOPMENT_TRAINED');await assert.rejects(train(file,new Date(1000).toISOString(),path.join(dir,'a.json')));
 rows[0].available_at=2000;fs.writeFileSync(file,rows.map(JSON.stringify).join('\n'));await assert.rejects(train(file,new Date(1000).toISOString(),path.join(dir,'bad.json')));
});
