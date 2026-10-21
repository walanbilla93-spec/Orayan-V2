'use strict';
const {Harness}=require('./researchV3Publication'),Q=require('../../lib/researchV3/cooperative'),C=require('../../lib/researchV3/codec');
const dir=process.argv[2],target=process.argv[3],mode=process.argv[4]||'build';
const budget={reserve:{encoded:65536,accounted:262144,entries:128},completionBoundMs:120000};
const row=(family,value,flags=0)=>({key:C.key(family,'record',['same']),value:Buffer.from(value),flags});
let armed=false,sent=false,post=false;
const pause=async phase=>{if(armed&&!sent&&phase===target){sent=true;if(process.send)process.send({phase});await new Promise(()=>{});}};
class CrashScheduler extends Q.Scheduler {async io(fn){const v=await super.io(fn);if(armed&&['BUILD_SHARD','PROOF_slots','HASH_slots','PREPARE_SUFFIX'].includes(target)&&this.phase===target){this.targetIO=(this.targetIO||0)+1;if(this.targetIO>=({BUILD_SHARD:10,PROOF_slots:5,HASH_slots:4,PREPARE_SUFFIX:5}[target]))await pause(target);}return v;}}
(async()=>{const s=new CrashScheduler(),h=await new Harness(dir,{scheduler:s,budget,hook:async(phase,store)=>{
    if(armed&&phase==='CYCLE_DURABLE'&&!post){post=true;await store.transaction([row('D','',1),row('O','after')],{scalar:5,protectedWrite:true});}
    await pause(phase);
  }}).init();
  if(mode==='build'){
    await h.transaction([row('D','before'),row('O','before')],{scalar:3});await h.transaction([],{scalar:2});armed=true;
    if(['WAL_ACCEPTED','CANONICAL_DURABLE','JOURNAL_DURABLE'].includes(target))await h.transaction([row('D','',1),row('O','after')],{scalar:5,protectedWrite:true});else await h.cycle();
  }else{
    // Recovery twice has an independent fixed expected-state oracle.
    if(h.lsn<2||h.lsn>3)throw Error('lost accepted transaction');
    const after=h.lsn===3;if(h.scalar!==(after?10:5))throw Error('scalar replay drift');
    const d=await h.get(row('D','').key),o=await h.get(row('O','').key);
    if((d?.toString()??null)!==(after?null:'before')||o.toString()!==(after?'after':'before'))throw Error('model parity');
    if(mode==='resume'&&h.pendingCycle)await h.cycle();
    await h.close();process.send?.({ok:true,lsn:h.lsn,scalar:h.scalar,C:h.C,reused:h.lastReuse||false,reusedShards:h.reusedShards||0});
  }
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(()=>{if(process.connected&&!sent)process.disconnect();});
