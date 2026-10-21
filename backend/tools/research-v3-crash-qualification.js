'use strict';
// Isolated child-process fault matrix. Leaves all scratch/evidence in place.
const fs=require('node:fs'),path=require('node:path'),{fork}=require('node:child_process');
const root=path.resolve(process.argv[2]||'v3-crash-scratch');fs.mkdirSync(root,{recursive:true});
const targets=['WAL_ACCEPTED','CANONICAL_DURABLE','JOURNAL_DURABLE','CYCLE_DURABLE','BUILD_SHARD','FINALIZE_SHARD','PROOF_slots','HASH_slots','SHARD_RECEIPT','VERIFY_GENERATION','PREPARE_SUFFIX','PREPARE_CHECKPOINT','BEFORE_CUTOVER_FENCE','CUTOVER_FENCE','BEFORE_CURRENT_RENAME','AFTER_CURRENT_RENAME','AFTER_CURRENT_DIRSYNC','INSTALL_VIEW','RETIRE_PREFIX','DONE'];
const helper=path.join(__dirname,'../test/helpers/researchV3CrashChild.js'),rows=[];
function child(dir,target,mode){return new Promise((resolve,reject)=>{const c=fork(helper,[dir,target,mode],{execArgv:['--max-old-space-size=352'],stdio:['ignore','pipe','pipe','ipc']});let reached=false,reply=null,errors='';const timeout=setTimeout(()=>{c.kill('SIGKILL');reject(Error('child timeout '+target+' '+mode));},30000);c.stderr.on('data',b=>{errors=(errors+b).slice(-8192);});c.on('error',reject);c.on('message',m=>{reply=m;if(mode==='build'&&m.phase===target){reached=true;c.kill('SIGKILL');}});c.on('exit',(code,signal)=>{clearTimeout(timeout);if(mode==='build'?!reached:code!==0||!reply?.ok)return reject(Error(JSON.stringify({target,mode,code,signal,errors})));resolve({code,signal,reply});});});}
(async()=>{for(const target of targets){const dir=path.join(root,target);fs.mkdirSync(dir);const at=Date.now();try{const killed=await child(dir,target,'build');
    // Supervisor proves child termination first. Remove only its empty ownership
    // directory; no library TTL-based lock stealing and no evidence deletion.
    const lock=path.join(dir,'WRITER.lock');if(fs.existsSync(lock))fs.rmdirSync(lock);
    const first=await child(dir,target,'recover'),second=await child(dir,target,'recover');if(first.reply.lsn!==second.reply.lsn||first.reply.scalar!==second.reply.scalar)throw Error('second restart drift');
    const resumed=await child(dir,target,'resume');rows.push({target,status:'PASS',platform:process.platform,killed,first:first.reply,second:second.reply,resumed:resumed.reply,elapsedMs:Date.now()-at});
  }catch(e){rows.push({target,status:'FAIL',error:e.stack});process.exitCode=1;}
  fs.writeFileSync(path.join(root,'crash-results.json'),JSON.stringify(rows,null,2));console.log(target,rows.at(-1).status);
}})().catch(e=>{console.error(e);process.exitCode=1;});
