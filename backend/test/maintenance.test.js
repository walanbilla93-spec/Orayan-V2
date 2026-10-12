'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const control = require('../lib/maintenance');
const {Maintenance} = control;

function fixture(extra={}) {
  const detail = {capture:{epochId:'E',sequence:3,attemptedRows:3,acceptedRows:3,persistedRows:3,lostRows:0,
    pendingRows:0,pendingBytes:0,captureHalted:false,pendingFailure:null}, providers:{groq:{queueDepth:0},qwen:{queueDepth:0}},
    archiveIdle:true,scanResearchBusy:false,managementBusy:false,managementObligations:{total:0},journalBytes:0,walFiles:0};
  let saved, flushes=0;
  const m = new Maintenance({load:()=>undefined,save:value=>{saved=value;},inspect:()=>detail,
    flush:()=>{flushes++;detail.journalBytes=0;detail.walFiles=0;detail.capture.pendingRows=0;detail.capture.pendingBytes=0;},...extra});
  return {m,detail,get saved(){return saved;},get flushes(){return flushes;}};
}
function install(t,m) {
  const old={...control};
  Object.assign(control,{current:()=>m,fenced:()=>m.fenced(),run:m.run.bind(m),beforeAppend:m.beforeAppend.bind(m)});
  t.after(()=>Object.assign(control,old));
}
function deferred() {let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}

test('entry fences admissions before drain and repeated entry shares a single operation',async()=>{
  const f=fixture(), gate=deferred();
  const task=f.m.run('research','scan',()=>gate.promise);
  const first=f.m.enter(), second=f.m.enter();
  assert.equal(first,second);assert.equal(f.m.state,'ENTERING');assert.equal(f.saved.maintenance,true);
  assert.throws(()=>f.m.run('research','birth',()=>{}),/MAINTENANCE_FENCED/);
  assert.throws(()=>f.m.run('provider','new',()=>{}),/MAINTENANCE_FENCED/);
  gate.resolve();await task;
  assert.equal((await first).state,'SEALED');assert.equal(f.flushes,1);
  await f.m.enter();assert.equal(f.flushes,1);
});
test('unsettled callback times out FAILED without closure, deletion, or a watermark',async()=>{
  const f=fixture(), gate=deferred();const task=f.m.run('provider','groq',()=>gate.promise);
  const s=await f.m.enter({timeoutMs:5});
  assert.equal(s.state,'FAILED');assert.match(s.reason,/provider:groq/);assert.equal(s.sealedWatermark,null);
  assert.equal(s.snapshotSafe,false);assert.equal(f.flushes,0);assert.equal(f.m.active.size,1);
  gate.resolve();await task;
});
test('provider queues and open requests independently prevent fake seal',async()=>{
  for (const field of ['queueDepth','inFlight','reserved','initializing','openRequests']) {
    const f=fixture();f.detail.providers.qwen[field]=1;
    const s=await f.m.enter({timeoutMs:2});assert.equal(s.state,'FAILED');assert.match(s.reason,/qwen/);
  }
});
test('active archive drains and nested publication can finish while new exports are fenced',async()=>{
  const f=fixture(), gate=deferred();
  const task=f.m.run('archive','canonical',async()=>{await gate.promise;return f.m.run('archive','canonical',()=>42);});
  const entered=f.m.enter();assert.throws(()=>f.m.run('archive','export',()=>{}),/MAINTENANCE_FENCED/);
  gate.resolve();assert.equal(await task,42);assert.equal((await entered).state,'SEALED');
});
test('export reader and scan flags prevent seal until idle or timeout',async()=>{
  for (const field of ['archiveIdle','scanResearchBusy']) {
    const f=fixture();f.detail[field]=field!=='archiveIdle';
    assert.equal((await f.m.enter({timeoutMs:2})).state,'FAILED');
  }
});
test('writer flush commits WAL and journal before sealing; dirty failure never seals',async()=>{
  const f=fixture();f.detail.journalBytes=100;f.detail.walFiles=1;f.detail.capture.pendingRows=1;
  assert.equal((await f.m.enter()).state,'SEALED');assert.equal(f.flushes,1);
  for(const bad of [{captureHalted:true},{pendingFailure:{code:'IO'}},{persistedRows:2},{lostRows:1}]) {
    const g=fixture();Object.assign(g.detail.capture,bad);
    assert.equal((await g.m.enter()).state,'FAILED');
  }
  const g=fixture({flush:()=>{throw Error('FSYNC_FAILED');}});
  assert.equal((await g.m.enter()).reason,'FSYNC_FAILED');
});
test('research seal stays fixed while authorized management watermark advances',async()=>{
  const f=fixture();f.detail.managementObligations.total=1;
  const s=await f.m.enter();assert.equal(s.fullSealed,false);assert.equal(s.snapshotSafe,false);
  const before={...s.sealedWatermark};
  f.m.run('management','trade',()=>{f.m.beforeAppend();for(const key of ['sequence','attemptedRows','acceptedRows','persistedRows'])f.detail.capture[key]++;});
  assert.deepEqual(f.m.status().sealedWatermark,before);assert.equal(f.m.status().managementWatermark.sequence,4);
  assert.equal(f.m.status().state,'SEALED');
});
test('full snapshot promotion waits for zero obligations and a second clean flush',async()=>{
  const f=fixture();f.detail.managementObligations.total=1;await f.m.enter();
  const promoted=f.m.fullSeal();f.detail.managementObligations.total=0;
  const s=await promoted;assert.equal(s.snapshotSafe,true);assert.equal(f.flushes,2);
  const repeated=await f.m.fullSeal();assert.deepEqual(repeated.fullWatermark,s.fullWatermark);assert.equal(f.flushes,2);
});
test('remaining management obligations time out without being force-closed',async()=>{
  const f=fixture();f.detail.managementObligations.total=1;await f.m.enter();
  const s=await f.m.fullSeal({timeoutMs:2});assert.equal(s.state,'FAILED');assert.equal(s.snapshotSafe,false);
  assert.equal(f.detail.managementObligations.total,1);assert.match(s.reason,/FULL_SEAL_TIMEOUT/);
});
test('unexpected untracked publication invalidates research seal before append',async()=>{
  const f=fixture();f.detail.managementObligations.total=1;await f.m.enter();
  f.m.beforeAppend();assert.equal(f.m.status().state,'FAILED');assert.match(f.m.status().reason,/UNEXPECTED_APPEND_AFTER_SEAL/);
});
test('unexpected management publication invalidates a full seal',async()=>{
  const f=fixture();await f.m.enter();
  f.m.run('management','outcome',()=>f.m.beforeAppend());assert.equal(f.m.status().snapshotSafe,false);
});
test('enter/exit cycles preserve external run intent and never create workers or listeners',async()=>{
  const f=fixture(), intent={desiredRunning:true,providerEnabled:false,budget:7};
  const timer=setInterval(()=>{},100000);timer.unref();
  try {
    for(let i=0;i<4;i++){await f.m.enter();await f.m.exit();await f.m.exit();}
    assert.equal(f.flushes,4);assert.deepEqual(intent,{desiredRunning:true,providerEnabled:false,budget:7});
    assert.equal(f.m.active.size,0);assert.equal(f.m.fenced(),false);assert.equal(timer._destroyed,false);
  }finally{clearInterval(timer);}
});
test('persisted active flag and unreadable flag restart fenced with no stale seal',()=>{
  for(const load of [()=>({maintenance:true,state:'FAILED',maintenanceEpoch:'00000000-0000-4000-8000-000000000001',processBootId:'00000000-0000-4000-8000-000000000002'}),()=>{throw Error('bad JSON');}]) {
    const f=fixture({load});assert.equal(f.m.state,'FAILED');assert.equal(f.m.fenced(),true);
    assert.equal(f.m.sealedWatermark,null);assert.match(f.m.reason,/RESTART_REQUIRES_RESEAL|MAINTENANCE_FLAG_UNREADABLE/);
  }
});
test('explicit retry reseals after restart without opening an admission window',async()=>{
  const f=fixture({load:()=>({maintenance:true,state:'FAILED',maintenanceEpoch:'00000000-0000-4000-8000-000000000001',processBootId:'00000000-0000-4000-8000-000000000002'})});
  assert.equal((await f.m.enter()).state,'FAILED');
  const reseal=f.m.enter({retry:true});assert.equal(f.m.fenced(),true);
  assert.throws(()=>f.m.run('research','birth',()=>{}),/MAINTENANCE_FENCED/);
  assert.equal((await reseal).state,'SEALED');
});
test('real persisted maintenance flag survives a fresh Node process and reseals without changing evidence',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'maintenance-restart-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const {execFileSync}=require('child_process');
  const script=`const store=require('./lib/store');store.DATA_DIR=process.argv[1];
    const runtime=require('./lib/researchRuntime');runtime.prepare();
    const maintenance=require('./lib/maintenance').current();
    const before={state:maintenance.state,fenced:maintenance.fenced()};
    maintenance.enter({retry:true}).then(status=>{
      console.log(JSON.stringify({before,state:status.state,snapshotSafe:status.snapshotSafe,watermark:status.fullWatermark}));
    }).catch(error=>{console.error(error);process.exitCode=1;});`;
  const run=()=>JSON.parse(execFileSync(process.execPath,['-e',script,root],{cwd:path.resolve(__dirname,'..'),encoding:'utf8',timeout:15000}).trim().split(/\r?\n/).at(-1));
  const first=run(),second=run();
  assert.equal(first.state,'SEALED');assert.equal(first.snapshotSafe,true);
  assert.deepEqual(second.before,{state:'FAILED',fenced:true});assert.equal(second.state,'SEALED');
  assert.deepEqual(second.watermark,first.watermark);
});
test('existing SHADOW trades receive the same defended-level receipts during maintenance without new admissions',async t=>{
  const f=fixture();f.detail.managementObligations.total=1;install(t,f.m);await f.m.enter();
  const market=require('../lib/marketData'),old={...market};t.after(()=>Object.assign(market,old));
  const settings={...require('../lib/settings').effective(),testnet:false,timeframe:'15'};
  const at=Date.now(), candles=Array.from({length:200},(_,i)=>({ts:Math.floor(at/900000)*900000-(200-i)*900000,
    open:100+i*.1,high:102+i*.1,low:99+i*.1,close:101+i*.1,volume:100,turnover:10000}));
  const ticker={symbol:'TESTUSDT',observedAt:at,bid:120,ask:120.01,markPrice:120,turnover24h:1e8};
  market.getTickers=async()=>[ticker];market.getInstruments=async()=>new Map();
  const requested=[];market.getCandles=async symbol=>{requested.push(symbol);return candles;};
  const worker={activeTrades:new Map([['T',{symbol:'TESTUSDT'}]]),armWorkers:new Map(),receipts(row){this.row=row;},
    saveCheckpoint(){this.saved=true;},captureError(e){throw e;},record(){throw Error('new admission forbidden');}};
  const v3=require('../lib/v3Shadow'),btc={regime:'BULL_TREND'};
  await v3.refreshManagementContext(settings,async()=>btc,worker);
  assert.deepEqual(requested,['TESTUSDT']);assert.equal(worker.saved,true);
  const expected=v3.evaluate({symbol:'TESTUSDT',candles,ticker,btcRegime:btc,settings,decisionAt:worker.row.decisionAt,v2Signals:[]});
  assert.deepEqual(worker.row.research,expected.research);assert.equal(f.m.status().state,'SEALED');
});
test('failed flag publication never resumes admissions; later exit recovers',async()=>{
  let fail=false;const f=fixture({save:()=>{if(fail)throw Error('IO');}});await f.m.enter();
  fail=true;await assert.rejects(f.m.exit(),/IO/);assert.equal(f.m.fenced(),true);
  fail=false;await f.m.exit();assert.equal(f.m.fenced(),false);
});
test('operator auth requires configured credentials and both existing protections',()=>{
  const auth=require('../routes/api')._test.requireMaintenanceAuth;
  assert.throws(()=>auth({headers:{}},{}),/NOT_CONFIGURED/);
  const env={GROQ_SHADOW_EXPORT_TOKEN:'G',ALIBABA_SHADOW_EXPORT_TOKEN:'Q'};
  assert.throws(()=>auth({headers:{authorization:'Bearer G'}},env),/Alibaba/);
  assert.throws(()=>auth({headers:{'x-groq-shadow-export-token':'bad','x-alibaba-shadow-export-token':'Q'}},env),/Groq/);
  assert.doesNotThrow(()=>auth({headers:{'x-groq-shadow-export-token':'G','x-alibaba-shadow-export-token':'Q'}},env));
});
test('real admission, provider, archive and mutation entrypoints honor fences',async t=>{
  const f=fixture();install(t,f.m);await f.m.enter();
  assert.equal(require('../lib/researchRuntime').canAdmit('PAPER'),false);
  assert.equal(require('../lib/researchRuntime').canAdmit('SHADOW'),false);
  assert.equal(require('../lib/researchRuntime').canAdmit('LIVE'),true);
  assert.equal(require('../lib/researchCapture').birth({},{}),null);
  for(const name of ['groqShadowProducer','alibabaShadowProducer'])assert.equal(require('../lib/'+name).observeBirth({},{}),false);
  await assert.rejects(require('../lib/researchRuntime').downloadCurrent(),/MAINTENANCE_FENCED/);
  assert.throws(()=>require('../lib/researchArchive').build({}),/MAINTENANCE_FENCED/);
  await assert.rejects(require('../routes/api').routes['POST /api/control/start']({}),/MAINTENANCE_FENCED/);
});

test('real engine keeps PAPER/SHADOW outcome management and preserves its sole scheduled timer across cycles',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'maintenance-engine-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=require('../lib/store'), minimal=require('../lib/minimalCapture'), executor=require('../lib/executor');
  const settings=require('../lib/settings'), market=require('../lib/marketData'), bybit=require('../lib/bybit'), v3=require('../lib/v3Shadow');
  const stats=require('../lib/symbolStats');
  const modules=[store,minimal,executor,settings,market,bybit,v3,stats], originals=modules.map(m=>({...m}));
  t.after(()=>modules.forEach((m,i)=>Object.assign(m,originals[i])));
  const c=new (require('../lib/researchStore').ResearchStore)(dir,{reserveBytes:0});
  const native={id:'N',signalId:'NS',episodeId:'N-EP',symbol:'TESTUSDT',side:'BUY',mode:'paper',status:'OPEN',createdAt:1,filledAt:1,fillPrice:100,sl:98,tp:104};
  const shadow={...native,id:'S',signalId:'SS',episodeId:'S-EP',engine:'MARCI_SHADOW'};
  const data={trades:[native],marciShadowTrades:[shadow],engineControl:{desiredRunning:true}};
  store.read=(name,dflt)=>data[name]??dflt;store.write=(name,value)=>{data[name]=value;return true;};
  minimal.enabled=()=>true;minimal.researchEnabled=()=>true;minimal.current=()=>c;
  const frozen={...settings.effective(),mode:'paper',tradingEnabled:false};settings.effective=()=>frozen;
  market.getTickers=async()=>[];market.getInstruments=async()=>new Map();market.getCandles=async()=>[];
  bybit.syncClock=async()=>{};v3.observeScan=()=>{};stats.recordClose=()=>{};
  let close=false,steps=0;
  executor.stepPaperTrade=async trade=>{steps++;if(!close)return false;Object.assign(trade,{status:'CLOSED',closedAt:Date.now(),netPnl:1});return true;};
  const enginePath=require.resolve('../lib/engine'), cached=require.cache[enginePath];delete require.cache[enginePath];
  const engine=require('../lib/engine');t.after(()=>{require.cache[enginePath]=cached;});
  const f=fixture({inspect:()=>({...f.detail,capture:c.status()}),flush:()=>c.flush()});
  f.detail.managementObligations.total=2;install(t,f.m);
  const originalTimeout=global.setTimeout,originalClear=global.clearTimeout;let scheduled=0;
  global.setTimeout=(fn,ms)=>{scheduled++;return {fn,ms};};global.clearTimeout=()=>{};
  t.after(()=>{global.setTimeout=originalTimeout;global.clearTimeout=originalClear;});
  await engine.start();assert.equal(scheduled,1);assert.equal(engine.shouldAutoResume(),true);
  const researchScans=engine.state.scanCount;await f.m.enter();close=true;
  await engine.scanOnce();assert.equal(native.status,'CLOSED');assert.equal(shadow.status,'CLOSED');
  assert.equal(engine.state.scanCount,researchScans);assert.equal(f.m.state,'SEALED');
  const rows=[];await require('../lib/researchArchive').rows(c,row=>rows.push(row));
  assert.ok(rows.some(r=>r.tradeId==='N'&&r.stream==='lifecycle'));assert.ok(rows.some(r=>r.tradeId==='S'&&r.mode==='SHADOW'));
  assert.equal(c.status().lostRows,0);assert.equal(engine.state.running,true);
  for(let i=0;i<3;i++){await f.m.exit();await f.m.exit();await engine.start();await f.m.enter();}
  assert.equal(scheduled,1);assert.equal(steps,4);assert.equal(data.engineControl.desiredRunning,true);
  assert.deepEqual(settings.effective(),frozen);
});

test('HTTP remains available when sealed and maintenance routes enforce existing token protections',async t=>{
  const f=fixture();install(t,f.m);await f.m.enter();
  const runtime=require('../lib/researchRuntime'), minimal=require('../lib/minimalCapture'), reset=require('../lib/startupCaptureReset');
  const v3=require('../lib/v3Shadow'), oldManagementInit=v3.initializeManagement;
  v3.initializeManagement=()=>{};t.after(()=>{v3.initializeManagement=oldManagementInit;});
  const oldRuntime={prepare:runtime.prepare,start:runtime.start,enabled:minimal.researchEnabled,reset:reset.run};
  runtime.prepare=()=>{};runtime.start=()=>{};minimal.researchEnabled=()=>true;reset.run=()=>{};
  t.after(()=>{runtime.prepare=oldRuntime.prepare;runtime.start=oldRuntime.start;minimal.researchEnabled=oldRuntime.enabled;reset.run=oldRuntime.reset;});
  const envKeys=['GROQ_SHADOW_EXPORT_TOKEN','ALIBABA_SHADOW_EXPORT_TOKEN'];const oldEnv=envKeys.map(k=>process.env[k]);
  process.env.GROQ_SHADOW_EXPORT_TOKEN='G';process.env.ALIBABA_SHADOW_EXPORT_TOKEN='Q';
  t.after(()=>envKeys.forEach((k,i)=>{oldEnv[i]===undefined?delete process.env[k]:process.env[k]=oldEnv[i];}));
  const engine=require('../lib/engine'), groq=require('../lib/groqShadowProducer'), qwen=require('../lib/alibabaShadowProducer');
  const old={auto:engine.shouldAutoResume,g:groq.initialize,q:qwen.initialize};
  engine.shouldAutoResume=()=>false;groq.initialize=async()=>({});qwen.initialize=async()=>({});
  t.after(()=>{engine.shouldAutoResume=old.auto;groq.initialize=old.g;qwen.initialize=old.q;});
  const {server,startServer}=require('../server');startServer(0);
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const root='http://127.0.0.1:'+server.address().port, headers={'x-groq-shadow-export-token':'G','x-alibaba-shadow-export-token':'Q'};
  assert.equal((await fetch(root+'/api/maintenance/status')).status,401);
  const status=await fetch(root+'/api/maintenance/status',{headers});assert.equal(status.status,200);
  assert.equal((await status.json()).state,'SEALED');assert.equal(server.listening,true);
  const enter=await fetch(root+'/api/maintenance/enter',{method:'POST',headers});
  assert.equal(enter.status,200);assert.equal((await enter.json()).state,'SEALED');
  const full=await fetch(root+'/api/maintenance/seal',{method:'POST',headers});assert.equal((await full.json()).snapshotSafe,true);
  const archive=await fetch(root+'/api/capture/current.zip',{headers});assert.equal(archive.status,409);
  assert.equal(server.listening,true);
});

for(const provider of ['groq','alibaba'])test(provider+' real in-flight callback settles, new transport is fenced, event hashes remain unchanged',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'maintenance-provider-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const {ResearchStore,sha}=require('../lib/researchStore'), archive=require('../lib/researchArchive'), minimal=require('../lib/minimalCapture');
  const c=new ResearchStore(dir,{reserveBytes:0}), old={researchEnabled:minimal.researchEnabled,current:minimal.current};
  Object.assign(minimal,{researchEnabled:()=>true,current:()=>c});t.after(()=>Object.assign(minimal,old));
  const f=fixture({inspect:()=>({...f.detail,capture:c.status(),journalBytes:c.status().indexJournalBytes,walFiles:fs.readdirSync(c.wal).length}),flush:()=>c.flush()});
  f.detail.managementObligations.total=1;install(t,f.m);
  const advisor=require('../../research/'+provider+'-shadow/src/advisor');
  require('../../research/'+provider+'-shadow/src/ledger')._test.resetCaches();
  const snapshot=require('./fixtures/'+provider+'Candidate')();snapshot.candidate_episode_id='EP';
  c.emit('decisions',{sourceEpisodeId:'EP',boundary:'BIRTH'});
  const hashes=Object.fromEntries(Object.entries(c.state.events).map(([id,e])=>[id,e.sha256]));
  const gate=deferred(), started=deferred();let calls=0;
  const config={...advisor.configFromEnv({}),ledger:path.join(dir,'unused.jsonl'),allowedRoot:dir,apiKey:'fake',allowLive:true};
  const pending=advisor.advise(snapshot,{config,mode:'mock',nowMs:Date.parse('2026-09-28T10:00:05Z'),mockTransport:async()=>{
    calls++;started.resolve();await gate.promise;return {ok:false,status:'TIMEOUT',httpStatus:null,headers:{},body:{}};
  }});
  await started.promise;
  const entered=f.m.enter({timeoutMs:5000});
  const blocked=await advisor.advise(snapshot,{config,mode:'mock',mockTransport:()=>{throw Error('new dispatch');}});
  assert.equal(blocked.status,'MAINTENANCE_FENCED');gate.resolve();await pending;
  const s=await entered;assert.equal(s.state,'SEALED');assert.equal(calls,1);
  assert.equal(c.status().lostRows,0);assert.equal(c.status().pendingRows,0);assert.equal(fs.readdirSync(c.wal).length,0);
  assert.equal(c.status().indexJournalBytes,0);
  for(const [id,hash]of Object.entries(hashes))assert.equal(c.state.events[id].sha256,hash);
  const rows=[];await archive.rows(c,r=>rows.push(r));
  for(const row of rows)assert.equal(sha(Buffer.from(JSON.stringify(row))),c.state.events[row.eventId].sha256);
  const before={...s.sealedWatermark};
  await f.m.run('management','outcome',()=>c.emit('trade_lifecycle',{sourceEpisodeId:'EP',tradeId:'T',status:'CLOSED',outcomeComplete:true}));
  assert.deepEqual(f.m.status().sealedWatermark,before);assert.ok(f.m.status().managementWatermark.sequence>before.sequence);
  assert.equal(f.m.status().state,'SEALED');
});
