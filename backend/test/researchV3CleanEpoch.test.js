'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const {ResearchStore}=require('../lib/researchStore'),M=require('../lib/researchV3Migration'),B=require('../lib/researchV3Abandon'),IO=require('../lib/researchV3/io');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'orayan-clean-v3-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const c=new ResearchStore(path.join(root,'research-canonical-v2'),{reserveBytes:0,admissionHeadroom:0});c.emit('decisions',{sourceEpisodeId:'closed',admission:'REJECT'});c.emit('decisions',{sourceEpisodeId:'open',admission:'ELIGIBLE'});c.flush();return {root,c};}
test('abandonment audit seals zero-write proof, fences bulk import, and removes only isolated staging',async t=>{
  const {root,c}=fixture(t),hash=IO.hashFile(c.file),prior=process.env.ORAYAN_V3_OFFLINE;process.env.ORAYAN_V3_OFFLINE='true';t.after(()=>{if(prior===undefined)delete process.env.ORAYAN_V3_OFFLINE;else process.env.ORAYAN_V3_OFFLINE=prior;});
  await assert.rejects(M.migrate(root,{afterStep:s=>{if(s==='stage:2')throw Error('STOP_STAGING');}}),/STOP_STAGING/);
  const audit=B.audit(root);assert.equal(audit.authoritativeV3Writes,0);assert.equal(audit.activationMarkerAbsent,true);assert.equal(audit.stagingIsolation.sharedFiles,0);
  await assert.rejects(M.migrate(root),/PERMANENTLY_ABANDONED/);
  const result=B.remove(root);assert.ok(result.reclaimedAllocatedBytes>0);assert.equal(fs.existsSync(path.join(root,'research-canonical-v3')),false);assert.equal(IO.hashFile(c.file),hash);assert.equal(B.read(audit.receipt).body.state,'ABANDONED_BEFORE_ACTIVATION');
});
test('abandonment refuses a staging hard link into V2',async t=>{
  const {root,c}=fixture(t);await assert.rejects(M.migrate(root,{afterStep:s=>{if(s==='stage:2')throw Error('STOP');}}),/STOP/);
  const alias=path.join(root,'research-canonical-v3','unsafe-copy');fs.linkSync(c.file,alias);
  assert.throws(()=>B.inventory(path.dirname(alias)),/NOT_EXCLUSIVE/);fs.unlinkSync(alias);
});

test('clean epoch carries only owned unresolved operations, excludes old outputs and boots with disk state',async t=>{
  const {root,c:source}=fixture(t),prior=process.env.ORAYAN_V3_OFFLINE;process.env.ORAYAN_V3_OFFLINE='true';t.after(()=>{if(prior===undefined)delete process.env.ORAYAN_V3_OFFLINE;else process.env.ORAYAN_V3_OFFLINE=prior;});
  source.emit('lifecycle',{sourceEpisodeId:'open',tradeId:'T',status:'OPEN',excursion:{mfeR:2,maeR:-1}});
  source.emit('ai_calls',{attemptId:'pending',evaluationId:'pending-eval',provider:'Groq',event:'REQUEST_PREPARED'});
  source.emit('ai_calls',{attemptId:'old-done',provider:'Groq',event:'PARSED_RESPONSE',parsed:'OLD_AI_OUTPUT_MUST_NOT_IMPORT'});
  source.nativeState('open-map',{episodeId:'open',at:Date.now()});source.flush();
  fs.writeFileSync(path.join(root,'trades.json'),JSON.stringify([{id:'T',episodeId:'open',mode:'paper',status:'OPEN'},{id:'old-closed',episodeId:'closed',mode:'paper',status:'CLOSED'}]));
  await assert.rejects(M.migrate(root,{afterStep:s=>{if(s==='stage:2')throw Error('STOP');}}),/STOP/);B.audit(root);
  const Clean=require('../lib/researchV3CleanEpoch'),A=require('../lib/researchV3Activation'),r=await Clean.prepare(root);
  assert.notEqual(r.epochId,source.state.epochId);assert.equal(r.obligations.native,1);assert.equal(r.obligations.episodes,1);assert.equal(r.obligations.uncertainAttempts,1);
  assert.equal(r.completedV2HistoryImported,false);assert.equal(r.feedbackMemoryStartedEmpty,true);assert.equal(fs.readdirSync(path.join(r.prepared,'feedback-memory')).length,0);
  B.remove(root);Clean.publish(root);A.activate(root);
  const V3=require('../lib/researchStoreV3').ResearchStoreV3,c=new V3(path.join(root,'research-canonical-v3'),{reserveBytes:0});
  assert.equal(c.state.cleanProspectiveExperiment,true);assert.equal(c.state.epochId,r.epochId);assert.equal(c.get('sourceEpisodes','closed'),undefined);assert.equal(c.get('aiAttempts','old-done'),undefined);
  assert.equal(c.get('aiAttempts','pending').aiEvent,'INTERRUPTED_UNCERTAIN');assert.equal(c.get('nativeEpisodeIndex','open-map').episodeId,'open');assert.deepEqual(c.get('extremes','T'),source.state.extremes.T);
  for(const m of c.values('events')){assert.ok(m.eventId.startsWith(r.epochId+':'));assert.equal(JSON.stringify(c.readRow(m)).includes('OLD_AI_OUTPUT_MUST_NOT_IMPORT'),false);}
  assert.equal(c.emit('outcomes',{sourceEpisodeId:'open',tradeId:'T',status:'CLOSED',outcomeComplete:true}),true);assert.equal(c.get('episodes',r.epochId+':open').state,'COMPLETE');
  assert.equal(c.memory().structures.historyDictionaries.count,0);assert.equal(c.enumerationAttempts,0);await c.close();
  const restarted=new V3(path.join(root,'research-canonical-v3'),{reserveBytes:0});assert.equal(restarted.get('episodes',r.epochId+':open').state,'COMPLETE');await restarted.close();
});

test('clean feedback namespace rejects lessons from a previous epoch before writing',t=>{
  const {root}=fixture(t),{EvidenceStore}=require('../lib/metaBrainResearch'),{hash}=require('../lib/metaBrainV1');
  const memory=new EvidenceStore(path.join(root,'new-feedback'),{epochId:'new'}),old={contract:'AI_POST_TRADE_FEEDBACK_V1',trade_id:'old',closed_at:1,identity:{source_epoch:'old',opportunity_id:'x',shared_context_hash:'h'}};
  old.feedback_id=hash(['AI_POST_TRADE_FEEDBACK_V1','old',1,'old']);
  assert.equal(memory.lessons.length,0);assert.throws(()=>memory.put('feedback',['old',1,'old'],old),/EPOCH_MISMATCH/);assert.equal(memory.lessons.length,0);assert.equal(memory.files,1);
});

test('inode exhaustion can seal abandonment using only disposable launcher PID slots',async t=>{
  const {root}=fixture(t),prior=process.env.ORAYAN_V3_OFFLINE;process.env.ORAYAN_V3_OFFLINE='true';t.after(()=>{if(prior===undefined)delete process.env.ORAYAN_V3_OFFLINE;else process.env.ORAYAN_V3_OFFLINE=prior;});
  await assert.rejects(M.migrate(root,{afterStep:s=>{if(s==='stage:2')throw Error('STOP');}}),/STOP/);
  for(const name of ['orayan-v3-migration.pid','orayan-v3-migration-batch.pid','orayan-v3-migration-final.pid'])fs.writeFileSync(path.join(root,name),'999999\n');
  const open=fs.openSync;fs.openSync=function(file,flags,...args){if(flags==='wx'&&(String(file).includes('research-cutover-receipts')||String(file).endsWith('research-v3-bulk-migration-abandoned.json'))){const e=Error('full');e.code='ENOSPC';throw e;}return open.call(this,file,flags,...args);};
  try{const r=B.audit(root);assert.equal(B.read(r.receipt).body.authoritativeV3Writes,0);assert.equal(fs.existsSync(path.join(root,'research-v3-bulk-migration-abandoned.json')),true);}finally{fs.openSync=open;}
});
