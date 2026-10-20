'use strict';
// Standalone primitive gate, no ResearchStore constructor, network or provider.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {performance}=require('node:perf_hooks'),C=require('../lib/researchV3/codec'),S=require('../lib/researchV3/shard'),IO=require('../lib/researchV3/io'),Spool=require('../lib/researchV3/spool');
const root=path.resolve(process.argv[2]||'v3-benchmark-scratch'),H=215336,scales=(process.env.V3_SCALES||'1,10,100').split(',').map(Number);
fs.mkdirSync(root,{recursive:true});const results=[],traceFile=path.join(root,'memory.jsonl'),identity={node:process.version,platform:process.platform,arch:process.arch,cpus:os.availableParallelism(),cpuMax:read('/sys/fs/cgroup/cpu.max'),memoryMax:read('/sys/fs/cgroup/memory.max'),kernel:os.release(),seed:'sequential-key-v1',H};
function read(file){try{return fs.readFileSync(file,'utf8').trim();}catch{return null;}}
const deadline=15000; // minimum configurable scan interval in unchanged settings.js
function sample(scale,stage){const m=process.memoryUsage(),r={scale,stage,at:Date.now(),...m,maxRSS:process.resourceUsage().maxRSS*1024,cgroupCurrent:read('/sys/fs/cgroup/memory.current'),cgroupPeak:read('/sys/fs/cgroup/memory.peak')};fs.appendFileSync(traceFile,JSON.stringify(r)+'\n');return r;}
function save(){fs.writeFileSync(path.join(root,'identity.json'),JSON.stringify(identity,null,2));fs.writeFileSync(path.join(root,'results.json'),JSON.stringify(results,null,2));}
function* generate(n,scale){const value=Buffer.alloc(128,65);for(let i=0;i<n;i++){const key=C.key('D','record',['fixture/'+i]);yield C.record(key,value,i+1);if(i%1000===0)sample(scale,'generate');}}
function build(dir,file,scale){const input=new Spool.Input(file),descriptors=Array.from({length:256},(_,b)=>S.emptyDescriptor('D',b));let r,w,b=-1;try{while((r=input.next())){if(r.digest[0]!==b){if(w)descriptors[b]=w.finish();b=r.digest[0];w=new S.Writer(dir,'D',b);}w.add(r);if(r.lsn%1000===0)sample(scale,'build');}if(w)descriptors[b]=w.finish();}finally{input.close();}return descriptors;}
function lookup(dir,descriptors,scale,n){const handles=new IO.Handles(),cache=new IO.Cache(),readers=new Map(),latencies=[];try{for(let i=0;i<512;i++){const k=C.key('D','record',['fixture/'+(i%2?String(n+i):String((i*104729)%n))]),digest=C.sha(k),b=digest[0];let reader=readers.get(b);if(!reader){reader=new S.Reader(dir,descriptors[b],{handles,cache});readers.set(b,reader);}const t=performance.now(),found=reader.get(k);latencies.push(performance.now()-t);if(Boolean(found)!==!(i%2))throw Error('dedupe false answer');sample(scale,'lookup');}return {max:Math.max(...latencies),mean:latencies.reduce((a,b)=>a+b,0)/latencies.length};}finally{handles.close();cache.clear();}}
try{
 for(const scale of scales){if(![1,10,100].includes(scale))throw Error('invalid scale');const n=H*scale,dir=path.join(root,'scale-'+scale),disk=fs.statfsSync(root);if(disk.bavail*disk.bsize<n*900){results.push({scale,records:n,status:'NOT_RUN_SCRATCH_CAPACITY',freeBytes:disk.bavail*disk.bsize,requiredConservativeBytes:n*900});save();break;}fs.mkdirSync(dir);sample(scale,'start');console.log('V3_STAGE',scale,'sort',n);
  const sortAt=performance.now(),file=Spool.sort(path.join(dir,'sort'),generate(n,scale)),sortMs=performance.now()-sortAt;sample(scale,'sort');console.log('V3_STAGE',scale,'build');
  const buildAt=performance.now(),d=build(dir,file,scale),buildMs=performance.now()-buildAt;fs.writeFileSync(path.join(dir,'descriptors.json'),JSON.stringify(d));sample(scale,'built');
  const look=lookup(dir,d,scale,n);console.log('V3_STAGE',scale,'fold-all-touched');
  // One exact update in each populated shard: bounded batch touching all 256.
  let maxShardMs=0,readBytes=0,proofBytes=0,totalBytes=0;const foldAt=performance.now();
  for(const desc of d){if(desc.empty)continue;const reader=new S.Reader(dir,desc),first=reader.at(0,true);reader.close();const o=new S.Overlay();o.set({...first,lsn:n+1,value:Buffer.alloc(128,66)});const start=performance.now(),f=S.fold(dir,desc,o);maxShardMs=Math.max(maxShardMs,performance.now()-start);readBytes+=f.readBytes;proofBytes+=f.proofBytes;totalBytes+=desc.slots.bytes+desc.values.bytes;sample(scale,'fold');}
  const foldMs=performance.now()-foldAt,m=sample(scale,'complete'),qualified=process.platform==='linux'&&Number(identity.memoryMax)<=512*1024*1024&&identity.cpuMax==='20000 100000'&&process.versions.node.startsWith('20.');
  const row={scale,records:n,sortMs,buildMs,lookupMaxMs:look.max,lookupMeanMs:look.mean,foldMs,maxShardMs,readBytes,proofBytes,logicalIndexBytes:totalBytes,maxRSS:m.maxRSS,heapUsed:m.heapUsed,cgroupPeak:m.cgroupPeak,deadlineMs:deadline,qualifiedEnvironment:qualified,latencyGate:foldMs<=deadline?'PASS':'FAIL',scope:'D primitive only; not full-service acceptance'};results.push(row);save();console.log('V3_RESULT',JSON.stringify(row));
  if(foldMs>deadline){console.log('V3_STOP_STATIC_FOLD_DEADLINE');break;}
 }
}catch(e){results.push({error:e.stack});save();console.error(e);process.exitCode=1;}finally{save();console.log('V3_ARTIFACTS_READY');}
