'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), util = require('util');
const { recoverySummary, compactStatus } = require('../lib/resourceSummary');
const { ResearchStore, atomic } = require('../lib/researchStore');
function temporary(t) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'resource-safety-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true})); return dir; }

test('recovery logger retains only frozen scalar counts for both provider shapes', () => {
  const logger=require('../lib/logger'), original=console.log; console.log=()=>{};
  try {
    logger.clear();
    for (const provider of ['Groq','Alibaba']) {
      const ids=Array.from({length:1418},(_,i)=>String(i).padStart(64,'0'));
      const result={initialized:true,requestIds:new Set(ids),terminalRequestIds:new Set(ids.slice(0,1400)),candidateInputs:new Map(ids.map(x=>[x,x])),openRequests:new Map([['open',{}]])};
      if(provider==='Alibaba')result.startedCandidates=new Set(ids);
      const summary=recoverySummary(provider,result,119000);
      logger.info(provider,'Startup recovery complete',summary);
      assert.ok(Object.isFrozen(summary));
      assert.ok(Object.values(summary).every(x=>['string','number','boolean'].includes(typeof x)));
      assert.equal(summary.requestIdsCount,1418); assert.equal(summary.terminalRequestIdsCount,1400);
      assert.equal(summary.candidateInputsCount,1418); assert.equal(summary.openRequestsCount,1);
      assert.equal(summary.startedCandidatesCount,provider==='Alibaba'?1418:undefined);
      console.error(JSON.stringify({provider,oldLogBytes:Buffer.byteLength(util.format(result)),newLogBytes:Buffer.byteLength(util.format(summary))}));
      result.requestIds.clear(); assert.equal(summary.requestIdsCount,1418);
    }
    assert.equal(logger.tail().length,2);
  } finally { console.log=original; }
});

test('ordinary status strips large metadata at both V3 paths and preserves UI fields without mutation', () => {
  const archive={day:'2026-10-14',bytes:123,published:true,verified:true,sha256:'hash',filename:'day.zip',manifest:{entries:Array.from({length:15000},(_,i)=>({id:i,hash:'x'.repeat(64)}))}};
  const capture={schemaVersion:'ORAYAN_RESEARCH_V2',health:'HEALTHY',lostRows:0,pendingRows:0,archives:[archive],segments:[{name:'part.jsonl',bytes:42}],reconciliation:{persisted:123},episodeStates:{OPEN:4}};
  const input={archive:{...capture,telemetry:{researchCapture:capture}},memory:{rss:12},shadowTrades:[{lastBarAt:123}]};
  const output=compactStatus(input);
  assert.equal(output.archive.health,'HEALTHY'); assert.equal(output.archive.lostRows,0);
  assert.deepEqual(output.archive.reconciliation,capture.reconciliation);
  assert.deepEqual(output.shadowTrades,input.shadowTrades);
  assert.equal(output.archive.archives[0].manifest,undefined);
  assert.equal(output.archive.telemetry.researchCapture.archives[0].manifest,undefined);
  assert.equal(output.archive.archives[0].bytes,123); assert.equal(output.archive.archives[0].published,true);
  assert.equal(output.archive.archiveSummary.bytes,123); assert.equal(output.archive.archiveSummary.latestDay,archive.day);
  assert.strictEqual(capture.archives[0],archive); assert.ok(archive.manifest.entries.length);
  const before=Buffer.byteLength(JSON.stringify(input)),after=Buffer.byteLength(JSON.stringify(output));
  assert.ok(after<before/100); console.error(JSON.stringify({fixtureStatusBefore:before,fixtureStatusAfter:after}));
});

test('checkpoint bytes match native JSON including ordering, escaping, sparse arrays and toJSON',t=>{
  const dir=temporary(t), file=path.join(dir,'status.json');
  const values=[{b:undefined,a:[,undefined,NaN,Infinity,'日本🌈\ud800'],nested:{'10':1,'2':2,'a"b':null},date:new Date(0)}, {x:{toJSON(){return undefined;}},y:{toJSON(){return {z:1};}}}];
  for(const value of values){atomic(file,value,true);assert.equal(fs.readFileSync(file,'utf8'),JSON.stringify(value));}
});

test('large checkpoint and restart retain exact sequence, dedupe, episodes, epoch and open obligations',t=>{
  const dir=temporary(t), c=new ResearchStore(dir,{reserveBytes:0,epochId:'E',checkpointEvery:1000000});
  c.emit('decision_episode',{sourceEpisodeId:'OPEN',boundary:'BIRTH'},{key:'birth:OPEN',signature:'OPEN'});
  c.nativeState('native',{episodeId:'OPEN',at:1});
  c.epoch('NEXT');
  c.state.aiAttempts={finished:{attemptId:'finished',aiEvent:'PARSED_RESPONSE',requestId:'R',tokens:42}};
  for(let i=0;i<75000;i++) {
    c.state.events['synthetic-'+i]={sequence:i,eventId:'event-'+i,sha256:'x'.repeat(64)};
    c.state.dedupe['synthetic-'+i]='signature-'+i;
  }
  c.state.archives.push({day:'2026-10-01',expired:true,published:false,manifest:{rows:75000}});
  const expected=JSON.stringify(c.state); c.flush();
  assert.equal(fs.readFileSync(c.file,'utf8'),expected);
  const restored=new ResearchStore(dir,{reserveBytes:0});
  assert.equal(JSON.stringify(restored.state),expected);
  assert.equal(restored.emit('decision_episode',{sourceEpisodeId:'OPEN'},{key:'birth:OPEN',signature:'OPEN'}),false);
  assert.equal(restored.state.nativeEpisodeIndex.native.episodeId,'OPEN');
  assert.equal(restored.state.epochId,'NEXT');
  assert.deepEqual(restored.state.aiAttempts,c.state.aiAttempts);
  assert.equal(restored.state.episodes['E:OPEN'].state,'OPEN');
  assert.equal(restored.state.lostRows,0);
});

for(const phase of ['write','fsync','rename']) test('checkpoint '+phase+' failure preserves previous file and replay journal',t=>{
  const c=new ResearchStore(temporary(t),{reserveBytes:0,epochId:'E',checkpointEvery:1000000});
  const previous=fs.readFileSync(c.file,'utf8');
  c.emit('decision_episode',{sourceEpisodeId:'A',boundary:'BIRTH'},{key:'birth:A',signature:'A'});
  const journal=fs.readFileSync(c.journal), fn={write:'writeSync',fsync:'fsyncSync',rename:'renameSync'}[phase], original=fs[fn];
  let writes=0;
  fs[fn]=(...args)=>{
    if(phase==='write' && writes++===0) { args[3]=Math.min(args[3],17); return original(...args); }
    throw Object.assign(Error('injected failure'),{code:'EIO'});
  };
  try{assert.throws(()=>c.flush(),/injected failure/);}finally{fs[fn]=original;}
  assert.equal(fs.readFileSync(c.file,'utf8'),previous); assert.deepEqual(fs.readFileSync(c.journal),journal);
  const restored=new ResearchStore(c.dir,{reserveBytes:0});
  assert.equal(restored.state.persistedRows,1); assert.equal(restored.state.episodes['E:A'].state,'OPEN');
  assert.equal(restored.emit('decision_episode',{sourceEpisodeId:'A'},{key:'birth:A',signature:'A'}),false);
});

test('actual read-only routes retain details and project ordinary status without hiding health',async t=>{
  const engine=require('../lib/engine'),v3=require('../lib/v3Shadow'),runtime=require('../lib/researchRuntime'),minimal=require('../lib/minimalCapture');
  const original=[engine.getState,v3.status,runtime.status,minimal.researchEnabled];
  t.after(()=>{[engine.getState,v3.status,runtime.status,minimal.researchEnabled]=original;});
  const capture={schemaVersion:'ORAYAN_RESEARCH_V2',health:'HEALTHY',lostRows:0,pendingRows:0,archives:[{day:'2026-10-14',bytes:1,published:true,verified:true,manifest:{evidence:'preserved'}}]};
  engine.getState=()=>({mode:'PAPER',researchCapture:capture});
  v3.status=()=>({archive:{...capture,telemetry:{researchCapture:capture}},shadowTrades:[{status:'OPEN',lastBarAt:123}]});
  runtime.status=()=>capture;minimal.researchEnabled=()=>true;
  const {routes}=require('../routes/api');
  assert.strictEqual(await routes['GET /api/capture/status/details'](),capture);
  for(const route of ['GET /api/capture/status','GET /api/status','GET /api/v3/status']) {
    const result=await routes[route](), c=result.researchCapture||result.archive||result;
    assert.equal(c.health,'HEALTHY');assert.equal(c.lostRows,0);assert.equal(c.pendingRows,0);
    assert.equal(c.archives[0].manifest,undefined);assert.equal(c.archives[0].verified,true);
    assert.equal(c.archiveSummary.detailAvailable,true);
    assert.ok(JSON.stringify(result).includes('HEALTHY'));
  }
  assert.equal(capture.archives[0].manifest.evidence,'preserved');
});
