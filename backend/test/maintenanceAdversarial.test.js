'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const {execFileSync}=require('child_process');
function root(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'maintenance-regression-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function probe(mode,dir,arg='') {
  const output=execFileSync(process.execPath,[path.join(__dirname,'maintenanceProbe.js'),mode,dir,arg],{encoding:'utf8',timeout:20000});
  return JSON.parse(output.trim().split(/\r?\n/).at(-1));
}
test('real final PAPER close durably checkpoints symbolStats and consumes delayed timer',t=>{assert.equal(probe('stats',root(t)).changedAfterDelay,false);});
for(const failure of ['write','fsync'])test('real symbolStats '+failure+' failure fences full seal and explicit retry',t=>{assert.equal(probe('stats',root(t),failure).snapshotSafe,false);});
for(const provider of ['groq','alibaba'])for(const state of ['orphan','terminal'])test(provider+' restart '+state+' ledger recovers before seal, retains uncertainty/budget and polling is read-only',t=>{
  const dir=root(t);probe('provider-seed',dir,provider+'-'+state);assert.equal(probe('provider',dir,provider+'-'+state).calls,0);
});
const flags=['ABSENT','{','', '{}','null','false','[]','{"state":"SEALED"}','{"maintenance":false,"state":"SEALED"}',
  '{"maintenance":true,"state":"RUNNING"}','{"maintenance":false,"state":"FAILED"}','{"maintenance":true,"state":"ALIEN"}',
  '{"maintenance":true,"state":"ENTERING","maintenanceEpoch":0,"processBootId":"B"}',
  '{"maintenance":false,"state":"RUNNING","sealedWatermark":{"epoch":"E"}}',
  '{"maintenance":true,"state":"FAILED","maintenanceEpoch":"M","processBootId":"B"}',
  '{"maintenance":false,"state":"RUNNING","fullSealed":true}',
  '{"maintenance":true,"state":"FAILED","maintenanceEpoch":"00000000-0000-4000-8000-000000000001","processBootId":"00000000-0000-4000-8000-000000000002"}'];
for(const flag of flags)test('real maintenance file restart/retry: '+JSON.stringify(flag),t=>{assert.equal(probe('flag',root(t),flag).snapshotSafe,true);});
function fixture(){const d={capture:{epochId:'E',sequence:1,attemptedRows:1,acceptedRows:1,persistedRows:1,lostRows:0,pendingRows:0,pendingBytes:0},
  providers:{groq:{},qwen:{}},archiveIdle:true,managementObligations:{total:0},journalBytes:0,walFiles:0,symbolStats:{version:0}};
  const m=new(require('../lib/maintenance').Maintenance)({load:()=>undefined,save:()=>{},inspect:()=>d,flush:()=>{}});return {m,d};}
const disturbances={wal:f=>f.d.walFiles=1,journal:f=>f.d.journalBytes=1,counts:f=>f.d.capture.persistedRows=0,
  watermark:f=>f.d.capture.sequence++,epoch:f=>f.d.capture.epochId='OTHER',loss:f=>f.d.capture.lostRows=1,
  halt:f=>f.d.capture.captureHalted=true,failure:f=>f.d.capture.pendingFailure='IO',rows:f=>f.d.capture.pendingRows=1,
  bytes:f=>f.d.capture.pendingBytes=1,nativeTimer:f=>f.d.symbolStats.pending=true,nativeDirty:f=>f.d.symbolStats.dirty=true,
  nativeFailure:f=>f.d.symbolStats.failure='IO',nativeVersion:f=>f.d.symbolStats.version++,provider:f=>f.d.providers.groq.openRequests=1,
  recovery:f=>f.m.recoveryPending=true,recoveryFailure:f=>f.m.recoveryFailure='IO',archive:f=>f.d.archiveIdle=false,
  readers:f=>f.d.exportReaders=1,build:f=>f.d.archiveBuildActivity=1,management:f=>f.d.managementBusy=true,
  obligations:f=>f.d.managementObligations.total=1,research:f=>f.d.scanResearchBusy=true,section:f=>f.m.active.set('management:late',1),
  invalidation:f=>f.m.reason='INVALIDATED',flush:f=>f.m.flushState='FLUSHING'};
for(const [name,disturb]of Object.entries(disturbances))test('snapshotSafe rechecks full invariant: '+name,async()=>{
  const f=fixture();assert.equal((await f.m.enter()).snapshotSafe,true);disturb(f);assert.equal(f.m.status().snapshotSafe,false);
});
test('provider recovery publication failure fails closed without transport',async()=>{
  const f=fixture();f.m.hooks.recoverProviders=()=>{throw Error('LEDGER_IO');};const result=await f.m.enter();
  assert.equal(result.state,'FAILED');assert.equal(result.snapshotSafe,false);assert.match(result.providerRecoveryFailure,/LEDGER_IO/);assert.equal(f.m.fenced(),true);
});
