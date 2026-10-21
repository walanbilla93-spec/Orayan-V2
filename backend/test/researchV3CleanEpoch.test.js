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
