'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const {ResearchStore}=require('../lib/researchStore'),{ResearchStoreV3}=require('../lib/researchStoreV3');
const {migrate}=require('../lib/researchV3Migration'),A=require('../lib/researchV3Activation');
const Archive=require('../lib/researchArchiveV3'),IO=require('../lib/researchV3/io');
function root(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'orayan-production-v3-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
function fixture(d,n=12){const at=Date.now()-3*86400000,c=new ResearchStore(path.join(d,'research-canonical-v2'),{epochId:'fixture',startedAt:at,now:()=>at,reserveBytes:0,admissionHeadroom:0});
  assert.equal(c.emit('definitions',{definitionId:'config',definition:{test:true}},{key:'config:exact',signature:'1'}),true);
  for(let i=0;i<n;i++){assert.equal(c.emit('decisions',{sourceEpisodeId:'episode:'+i,admission:i===n-1?'ELIGIBLE':'REJECT',symbol:'X',configHash:'config',at:at+i},{key:'decision:'+i,signature:String(i)}),true);}
  c.emit('lifecycle',{sourceEpisodeId:'episode:'+(n-1),tradeId:'T',status:'OPEN',excursion:{mfeR:2,maeR:-1}});
  c.emit('ai_calls',{sourceEpisodeId:'episode:'+(n-1),attemptId:'attempt',evaluationId:'evaluation',provider:'Groq',event:'REQUEST_PREPARED'});
  c.nativeState('native:key',{episodeId:'episode:'+(n-1),at:Date.now(),signature:'native'});c.flush();return c;
}
test('real V2 migration preserves bytes and projections; V3 dedupe, outcomes and recovery survive restart',async t=>{
  const d=root(t),v2=fixture(d),before=IO.hashFile(v2.file),receipt=await migrate(d);
  assert.equal(receipt.state,'VERIFIED_NOT_ACTIVE');assert.equal(IO.hashFile(v2.file),before);assert.equal(receipt.reconciled.openAttempts,1);
  assert.equal(A.select(d,'v2'),'v2');assert.throws(()=>A.select(d,'v3'),/ACTIVATION/);A.activate(d);
  let c=new ResearchStoreV3(path.join(d,'research-canonical-v3'),{reserveBytes:0,admissionHeadroom:0});
  assert.equal(c.state.sequence,v2.state.sequence+1);assert.equal(c.state.aiAttempts.attempt.aiEvent,'INTERRUPTED_UNCERTAIN');
  assert.deepEqual(c.state.extremes.T,v2.state.extremes.T);assert.deepEqual(c.state.nativeEpisodeIndex['native:key'],v2.state.nativeEpisodeIndex['native:key']);
  assert.equal(c.emit('decisions',{},{key:'decision:0',signature:'0'}),false);
  const markerFile=path.join(d,'research-backend-activation.json'),markerBytes=fs.readFileSync(markerFile);fs.unlinkSync(markerFile);
  assert.throws(()=>A.select(d,'v2'),/AMBIGUOUS/);assert.throws(()=>A.rollback(d),/FIX_FORWARD/);fs.writeFileSync(markerFile,markerBytes);
  assert.equal(c.emit('outcomes',{sourceEpisodeId:'episode:11',tradeId:'T',status:'CLOSED',outcomeComplete:true}),true);
  assert.equal(c.state.episodes['fixture:episode:11'].state,'COMPLETE');
  assert.equal(c.enumerationAttempts,0);assert.equal(c.memory().structures.historyDictionaries.count,0);
  assert.throws(()=>A.select(d,'v2'),/FIX_FORWARD/);assert.throws(()=>A.rollback(d),/FIX_FORWARD/);
  await c.close();c=new ResearchStoreV3(path.join(d,'research-canonical-v3'),{reserveBytes:0,admissionHeadroom:0});
  assert.equal(c.state.episodes['fixture:episode:11'].state,'COMPLETE');assert.equal(c.evaluation('evaluation').count,1);
  assert.equal(c.emit('decisions',{},{key:'decision:0',signature:'0'}),false);await c.close();
});
test('checkpoint migration restarts mid-stage and resumes exact keys without duplication',async t=>{
  const d=root(t),v2=fixture(d);let interrupted=false;
  await assert.rejects(migrate(d,{afterStep:step=>{if(step==='entry:20'&&!interrupted){interrupted=true;throw Error('INJECTED_STOP');}}}),/INJECTED_STOP/);
  const r=await migrate(d);assert.equal(r.eventSequence,v2.state.sequence);assert.equal(r.acceptedRows,v2.state.acceptedRows);
  assert.equal(r.sourceHashesBefore,r.sourceHashesAfter);assert.equal((await migrate(d)).sha256,r.sha256);
});

test('checkpoint batching bounds work and durably resumes at group boundaries',async t=>{
  const d=root(t),v2=fixture(d,70),{Index}=require('../lib/researchV3/index');
  const commit=Index.prototype.commit;let commits=0,largest=0;
  Index.prototype.commit=function(ops,state){commits++;largest=Math.max(largest,ops.length);return commit.call(this,ops,state);};
  try{
    await assert.rejects(migrate(d,{afterStep:step=>{if(step==='entry:20')throw Error('BATCH_STOP');}}),/BATCH_STOP/);
    const dir=path.join(d,'research-canonical-v3','index'),index=new Index(dir);
    assert.equal(index.root.state.migrationCursor,64);
    index.handles.close();index.cache.clear();
    assert.ok(commits<10);assert.ok(largest<=64);
    const receipt=await migrate(d);assert.equal(receipt.eventSequence,v2.state.sequence);
    assert.equal(receipt.sourceHashesBefore,receipt.sourceHashesAfter);
  }finally{Index.prototype.commit=commit;}
});

test('offline import amortizes folds with a fixed cap and publishes a normal bounded runtime root',t=>{
  const d=root(t),{Index}=require('../lib/researchV3/index'),dir=path.join(d,'index');
  let index=new Index(dir,{create:true,offlineImport:true});
  for(let start=0;start<4096;start+=64){const ops=[];for(let i=start;i<start+64;i++)ops.push(['dedupe',String(i),{signature:'x'.repeat(512),eventId:String(i)},false]);index.commit(ops,{});}
  assert.ok(index.overlayBytes>4*1024*1024);
  assert.ok(index.overlayBytes<=index.metrics().overlay.capBytes);
  index.handles.close();index.cache.clear();
  index=new Index(dir,{offlineImport:true});assert.equal(index.get('dedupe','4095').eventId,'4095');index.close();
  index=new Index(dir);assert.equal(index.metrics().overlay.capBytes,4*1024*1024);
  assert.equal(index.get('dedupe','0').eventId,'0');assert.equal(index.overlayBytes,0);index.close();
});
test('archive causal closure, streaming manifest, compaction and boot reject historical enumeration',async t=>{
  const d=root(t);fixture(d,25);await migrate(d);A.activate(d);
  const c=new ResearchStoreV3(path.join(d,'research-canonical-v3'),{reserveBytes:0,admissionHeadroom:0});
  const target=path.join(d,'bounded.zip');const b=await Archive.build(c,{sinceAt:0,target});const manifest=await Archive.verify(target);
  assert.equal(manifest.eventCount,b.manifest.eventCount);assert.equal(manifest.eventCount,c.state.retainedRows);
  const day=require('../lib/researchStore').dayAt(Date.now()-3*86400000,c.timezone);
  await Archive.closeDay(c,day);await Archive.compactIndex(c);
  assert.equal(c.enumerationAttempts,0);assert.equal(c.archiveTraversal.membership,'DISK_EXACT');assert.equal(c.archiveTraversal.residentHistoryRecordCap,1);
  assert.ok(c.archiveTraversal.selectedCount>c.archiveTraversal.residentHistoryRecordCap);const metrics=c.memory().structures;assert.ok(metrics.pageCache.bytes<=metrics.pageCache.capBytes);assert.ok(metrics.overlay.bytes<=metrics.overlay.capBytes);
  assert.throws(()=>Object.values(c.state.events),/ENUMERATION_FORBIDDEN/);
  await c.close();
});
test('selector ambiguity fences, and a verified un-written namespace can revert to V2',async t=>{
  const d=root(t);fixture(d);await migrate(d);A.activate(d);assert.equal(A.select(d,'v3'),'v3');A.rollback(d);assert.equal(A.select(d,'v2'),'v2');
  fs.writeFileSync(path.join(d,'research-backend-activation.json'),'torn');assert.throws(()=>A.select(d,'v2'),/AMBIGUOUS/);
});
test('activation rejects V2 changes after migration and leaves pre-write V2 selectable',async t=>{
  const d=root(t),v2=fixture(d,2);await migrate(d);fs.appendFileSync(v2.file,' ');assert.throws(()=>A.activate(d),/SOURCE_CHANGED/);assert.equal(A.select(d,'v2'),'v2');
});
test('migration replays a native-only journal and committed but unapplied WAL without writing V2',async t=>{
  const d=root(t),v2=fixture(d,3),seq=v2.state.sequence;
  v2.nativeState('journal-only',{episodeId:'episode:2',at:Date.now()});
  const recover=v2.recover.bind(v2);let calls=0;v2.recover=()=>{if(calls++===0)recover();};
  assert.equal(v2.emit('outcomes',{sourceEpisodeId:'episode:2',tradeId:'T',status:'CLOSED',outcomeComplete:true}),true);
  const files=require('../lib/researchV3Migration').files,before=new Map();for(const name of files(v2.dir))before.set(name,IO.hashFile(path.join(v2.dir,name)));
  const r=await migrate(d);assert.equal(r.eventSequence,seq+1);
  const c=new ResearchStoreV3(path.join(d,'research-canonical-v3'),{offline:true});
  assert.deepEqual(c.state.nativeEpisodeIndex['journal-only'],{episodeId:'episode:2',at:v2.state.nativeEpisodeIndex['journal-only'].at});
  assert.equal(c.state.episodes['fixture:episode:2'].state,'COMPLETE');
  for(const [name,hash]of before)assert.equal(IO.hashFile(path.join(v2.dir,name)),hash);c.index.handles.close();
});
test('physical-row stage resumes and source mutation never gets a VERIFIED receipt',async t=>{
  const d=root(t);fixture(d,4);let stop=true;
  await assert.rejects(migrate(d,{afterStep:step=>{if(step==='row:2'&&stop){stop=false;throw Error('STOP_PHYSICAL');}}}),/STOP_PHYSICAL/);
  assert.equal((await migrate(d)).state,'VERIFIED_NOT_ACTIVE');
  const other=root(t),source=fixture(other,2);await assert.rejects(migrate(other,{afterStep:step=>{if(step==='stage:1'){fs.appendFileSync(source.file,' ');throw Error('MUTATED');}}}),/MUTATED/);
  await assert.rejects(migrate(other),/SOURCE_CHANGED/);assert.equal(fs.existsSync(path.join(other,'research-canonical-v3','migration-receipt.json')),false);
});
test('disk provider projections hydrate budgets and recover open ledger requests without history reads',async t=>{
  const d=root(t),v2=fixture(d,2),now=Date.now(),iso=new Date(now).toISOString();
  v2.emit('ai_calls',{provider:'Alibaba',event:'PROVIDER_LEDGER',sourceEpisodeId:'episode:1',ledgerRecord:{record_type:'REQUEST_STARTED',request_id:'request-open',candidate_id:'candidate',input_snapshot_hash:'input',requested_at_utc:iso,estimated_tokens_reserved:50,estimated_cost_usd_reserved:.1}});v2.flush();
  await migrate(d);A.activate(d);const c=new ResearchStoreV3(path.join(d,'research-canonical-v3'),{reserveBytes:0,admissionHeadroom:0});
  const minimal=require('../lib/minimalCapture'),old={current:minimal.current,researchEnabled:minimal.researchEnabled};minimal.current=()=>c;minimal.researchEnabled=()=>true;
  try {
    const ledger=require('../../research/alibaba-shadow/src/ledger');ledger._test.resetCaches();const start=c.index.cursorReads.events||0;
    const index=await ledger.ledgerIndex(path.join(d,'never.jsonl'),now+1,{canonical:require('../lib/researchAI').canonical('Alibaba')});
    assert.equal(c.index.cursorReads.events||0,start);assert.equal(index.openRequests.size,0);assert.equal(index.state(now+1).dayRequests,1);assert.equal(index.state(now+1).dayTokens,50);assert.equal(index.state(now+1).requestIds.has('request-open'),true);
    assert.equal(index.summary.localAbstains,1);assert.equal(c.enumerationAttempts,0);
  }finally{Object.assign(minimal,old);await c.close();}
});
test('bounded archive retention keeps seven verified daily files and preserves open closure',async t=>{
  const d=root(t),v2=fixture(d,2);v2.state.startedAt=Date.now()-9*86400000;v2.flush();await migrate(d);A.activate(d);
  const c=new ResearchStoreV3(path.join(d,'research-canonical-v3'),{reserveBytes:0,admissionHeadroom:0});await Archive.tick(c);
  assert.equal(c.archiveStatus().length,7);assert.equal(c.get('episodes','fixture:episode:1').state,'OPEN');assert.equal(c.enumerationAttempts,0);
  let previous=0;await Archive.rows(c,row=>{assert.ok(row.sequence>previous);previous=row.sequence;});await c.close();
});
test('a real process exit recovers acknowledged V3 WAL, discards only torn tail and keeps exact dedupe',async t=>{
  const d=root(t);fixture(d,2);await migrate(d);A.activate(d);
  const script=`const fs=require('fs');const {ResearchStoreV3}=require(${JSON.stringify(require.resolve('../lib/researchStoreV3'))});const c=new ResearchStoreV3(${JSON.stringify(path.join(d,'research-canonical-v3'))},{reserveBytes:0,admissionHeadroom:0});if(!c.emit('outcomes',{sourceEpisodeId:'episode:1',tradeId:'T',status:'CLOSED',outcomeComplete:true},{key:'crash-outcome',signature:'exact'}))throw Error('not accepted');c.nativeState('crash-native',{at:123,value:'exact'});console.log(JSON.stringify({sequence:c.state.sequence,lsn:c.index.root.lsn}));fs.appendFileSync(c.index.wal,'{"torn":');process.exit(0);`;
  const child=require('child_process').spawnSync(process.execPath,['-e',script],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);const accepted=JSON.parse(child.stdout.trim());
  const c=new ResearchStoreV3(path.join(d,'research-canonical-v3'),{reserveBytes:0,admissionHeadroom:0});
  assert.equal(c.state.sequence,accepted.sequence);assert.ok(c.index.root.lsn>=accepted.lsn);assert.equal(c.state.episodes['fixture:episode:1'].state,'COMPLETE');assert.deepEqual(c.state.nativeEpisodeIndex['crash-native'],{at:123,value:'exact'});
  assert.equal(c.emit('outcomes',{},{key:'crash-outcome',signature:'exact'}),false);await c.close();
});
test('streaming visitors never return historical arrays, including archived membership and Marci ledger',t=>{
  const d=root(t),f=path.join(d,'input.json'),read=require('../lib/readCheckpointJson');fs.writeFileSync(f,JSON.stringify({archives:[{day:'2026-01-01',eventIds:Array.from({length:200},(_,i)=>'id'+i)}],events:{a:{eventId:'a'},b:{eventId:'b'}}}));
  let ids=0,events=0;assert.equal(read.visitCheckpointJson(f,(field,key,value)=>{if(field==='archiveEventIds')ids++;if(field==='events')events++;if(field==='archives')assert.equal(Array.isArray(value.eventIds),false);}),undefined);assert.equal(ids,200);assert.equal(events,2);
  fs.writeFileSync(f,'[{"id":"a"},{"id":"b"}]');let rows=0;read.visitJsonArray(f,()=>rows++);assert.equal(rows,2);fs.writeFileSync(f,'{}');assert.throws(()=>read.visitJsonArray(f,()=>{}));
});
