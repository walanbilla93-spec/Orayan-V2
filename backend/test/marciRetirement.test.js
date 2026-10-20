'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const retirement=require('../lib/marciRetirement');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'retirement-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const rows=[{id:'M',status:'OPEN',createdAt:1,netPnl:null},{id:'CF',status:'CLOSED',createdAt:1,netPnl:-2,marciCounterfactual:{tracking:true}}];
 fs.writeFileSync(path.join(root,'marciShadowTrades.json'),JSON.stringify(rows,null,2));
 const c={state:{epochId:'E',sequence:3,episodes:{M:{controlResolved:false,controls:{M:false},arms:{}},N:{controlResolved:false,controls:{N:false},arms:{}}},events:{
  E1:{eventId:'E1',episodeId:'M',sha256:'H1',at:1},E2:{eventId:'E2',episodeId:'M',sha256:'H2',at:2},E3:{eventId:'E3',episodeId:'N',sha256:'H3',at:3}}}};
 const records=[{episodeId:'M',eventId:'E1',strategy:'MARCI'},{episodeId:'M',eventId:'E2',strategy:'MARCI'},{episodeId:'N',eventId:'E3',strategy:'NEW_ORAYAN'}];
 const visit=async f=>{for(const r of records)f(r);};
 return {root,c,records,visit,rows,commit:'a'.repeat(40)};
}
test('retirement censors observation only; bytes, outcomes, epoch and native obligations remain unchanged',async t=>{
 const f=fixture(t),before=fs.readFileSync(path.join(f.root,'marciShadowTrades.json')),state=JSON.stringify(f.c.state);
 assert.equal(retirement.accounting(f.c,f.root).coveredRows.size,0);
 const receipt=await retirement.build(f.c,f.root,f.commit,f.visit,10);retirement.publish(f.root,receipt);
 assert.equal(receipt.outcome_claim,'NONE');assert.equal(receipt.obligations.length,2);
 assert.deepEqual(receipt.episodes.map(x=>x.id),['M']);
 const a=retirement.accounting(f.c,f.root);assert.equal(a.failure,null);assert.equal(a.coveredRows.size,2);assert.deepEqual([...a.coveredEpisodes],['M']);
 assert.equal(retirement.unresolved(f.c.state.episodes.N),true);assert.equal(retirement.unresolved(f.c.state.episodes.M),true);
 assert.equal(JSON.stringify(f.c.state),state);assert.deepEqual(fs.readFileSync(path.join(f.root,'marciShadowTrades.json')),before);
 // Receipt is independently exportable/reloadable, with identical accounting after process reload.
 delete require.cache[require.resolve('../lib/marciRetirement')];const restarted=require('../lib/marciRetirement');
 assert.deepEqual(restarted.read(f.root),receipt);assert.equal(restarted.accounting(f.c,f.root).coveredEpisodes.size,1);
 assert.throws(()=>retirement.publish(f.root,receipt),/EEXIST/);
});
test('mixed, unknown or missing canonical provenance cannot retire an episode',async t=>{
 for(const change of [f=>f.records[1].strategy='NEW_ORAYAN',f=>delete f.records[1].strategy,f=>f.records.pop()&&f.records.pop()]){
  const f=fixture(t);change(f);const r=await retirement.build(f.c,f.root,f.commit,f.visit,10);assert.equal(r.episodes.length,0);
 }
});
test('audit movement refuses publication and needs exact implementation provenance',async t=>{
 const f=fixture(t);await assert.rejects(retirement.build(f.c,f.root,'bad',f.visit,10),/PROVENANCE/);
 await assert.rejects(retirement.build(f.c,f.root,f.commit,async v=>{await f.visit(v);f.c.state.sequence++;},10),/AUDIT_MOVED/);
 assert.equal(retirement.read(f.root),null);
});
test('changed history, epoch, episode, event manifest, corrupt receipt all fail closed',async t=>{
 for(const mutate of [f=>fs.appendFileSync(path.join(f.root,'marciShadowTrades.json'),' '),f=>f.c.state.epochId='NEW',
  f=>f.c.state.episodes.M.controls.M=true,f=>f.c.state.events.E2.sha256='CHANGED',
  f=>fs.writeFileSync(path.join(f.root,'marci-retirement-v1.json'),'{')]){
  const f=fixture(t),r=await retirement.build(f.c,f.root,f.commit,f.visit,10);retirement.publish(f.root,r);mutate(f);
  const a=retirement.accounting(f.c,f.root);assert.ok(a.failure);assert.equal(a.coveredRows.size,0);assert.equal(a.coveredEpisodes.size,0);
 }
});
test('retirement failure prevents even an otherwise clean full seal',async()=>{
 const d={capture:{epochId:'E',sequence:0,attemptedRows:0,acceptedRows:0,persistedRows:0,lostRows:0},providers:{},archiveIdle:true,
  managementObligations:{total:0},marciRetirement:{failure:'CORRUPT_RECEIPT'}};
 const m=new(require('../lib/maintenance').Maintenance)({load:()=>undefined,save:()=>{},inspect:()=>d,flush:()=>{}});
 const result=await m.enter({timeoutMs:2});assert.equal(result.snapshotSafe,false);assert.equal(result.state,'FAILED');
});
