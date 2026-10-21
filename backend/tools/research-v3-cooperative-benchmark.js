'use strict';
// Physical primitive workload; setup remains explicitly offline/synchronous.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{performance,monitorEventLoopDelay}=require('node:perf_hooks');
const C=require('../lib/researchV3/codec'),S=require('../lib/researchV3/shard'),Spool=require('../lib/researchV3/spool'),Q=require('../lib/researchV3/cooperative');
const root=path.resolve(process.argv[2]||'cooperative-scratch'),H=215336,scales=(process.env.V3_SCALES||'1,10,100').split(',').map(Number),results=[];
fs.mkdirSync(root,{recursive:true});
function read(file){try{return fs.readFileSync(file,'utf8').trim();}catch{return null;}}
const identity={node:process.version,platform:process.platform,arch:process.arch,oldSpace:process.execArgv,kernel:os.release(),seed:'sequential-key-v1',H,cpuMax:read('/sys/fs/cgroup/cpu.max'),memoryMax:read('/sys/fs/cgroup/memory.max'),cpuset:read('/sys/fs/cgroup/cpuset.cpus.effective'),mountinfo:read('/proc/self/mountinfo')};
fs.writeFileSync(path.join(root,'identity.json'),JSON.stringify(identity,null,2));
function save(){fs.writeFileSync(path.join(root,'results.json'),JSON.stringify(results,null,2));}
let lastSample=performance.now(),sampleGapMax=0,samples=0,heapPeak=0,rssPeak=0;
const sample=(scale,phase)=>{const now=performance.now(),memory=process.memoryUsage();heapPeak=Math.max(heapPeak,memory.heapUsed);rssPeak=Math.max(rssPeak,memory.rss);sampleGapMax=Math.max(sampleGapMax,now-lastSample);lastSample=now;samples++;fs.appendFileSync(path.join(root,'memory.jsonl'),JSON.stringify({at:Date.now(),mono:now,scale,phase,...memory,maxRSS:process.resourceUsage().maxRSS*1024,cgroupPeak:read('/sys/fs/cgroup/memory.peak'),cgroupCurrent:read('/sys/fs/cgroup/memory.current'),cpuStat:read('/sys/fs/cgroup/cpu.stat')})+'\n');};
function* records(n,scale){const value=Buffer.alloc(128,65);for(let i=0;i<n;i++){yield C.record(C.key('D','record',['fixture/'+i]),value,i+1);if(i%1000===0)sample(scale,'setup_generate');}}
function build(dir,file,scale){const input=new Spool.Input(file),d=Array.from({length:256},(_,b)=>S.emptyDescriptor('D',b));let r,w,b=-1;try{while((r=input.next())){if(r.digest[0]!==b){if(w)d[b]=w.finish();b=r.digest[0];w=new S.Writer(dir,'D',b);}w.add(r);if(r.lsn%1000===0)sample(scale,'setup_build');}if(w)d[b]=w.finish();}finally{input.close();}return d;}
(async()=>{for(const scale of scales){if(![1,10,100].includes(scale))throw Error('scale');const n=H*scale,disk=fs.statfsSync(root),freeBytes=disk.bavail*disk.bsize,requiredConservativeBytes=n*900;
    const plan=require('./research-v3-capacity-plan.json').find(x=>x.scale===scale),allocatedScratchBytes=Number(process.env.V3_SCRATCH_LIMIT_BYTES||2000000000);
    if(!Number.isSafeInteger(allocatedScratchBytes)||allocatedScratchBytes<=0)throw Error('missing declared scratch allocation');
    if(Math.min(freeBytes,allocatedScratchBytes)<plan.requiredBytes){results.push({scale,records:n,status:'NOT_RUN',reason:'SCRATCH_CAPACITY',filesystemFreeBytes:freeBytes,allocatedScratchBytes,requiredConservativeBytes:plan.requiredBytes});save();continue;}
    const dir=path.join(root,'scale-'+scale);fs.mkdirSync(dir);console.log('COOP_SETUP',scale,n);sample(scale,'setup_start');const setupAt=performance.now(),file=Spool.sort(path.join(dir,'sort'),records(n,scale)),descriptors=build(dir,file,scale),setupMs=performance.now()-setupAt;
    fs.writeFileSync(path.join(dir,'base-descriptors.json'),JSON.stringify(descriptors));let logicalIndexBytes=0;for(const d of descriptors)if(!d.empty)logicalIndexBytes+=d.slots.bytes+d.values.bytes+d.slots.treeBytes+d.values.treeBytes;
    const repeatCount=Number(process.env.V3_REPEATS||1);
    for(let repeat=0;repeat<repeatCount;repeat++){
      const s=new Q.Scheduler(),hist=monitorEventLoopDelay({resolution:10});hist.enable();const t=performance.now(),timer=setInterval(()=>sample(scale,s.phase),100);let count=0;
      try{for(const d of descriptors){if(d.empty)continue;const source=await new Q.Reader(s,dir,d).init();let first;try{first=await source.next();}finally{await source.close();}
          const update={...first,value:Buffer.alloc(128,66),lsn:n+1};await Q.fold(s,dir,d,[update]);count++;if(count%16===0)console.log('COOP_PROGRESS',scale,repeat,count,Math.round(performance.now()-t));
        }}finally{clearInterval(timer);hist.disable();}
      sample(scale,'complete');const row={scale,repeat,records:n,setupMs,foldMs:performance.now()-t,maxSliceMs:s.metrics.sliceMaxMs,sliceViolations:s.metrics.sliceViolationCount,yields:s.metrics.yieldCount,ioMax:s.metrics.ioMax,eventLoopP95Ms:hist.percentile(95)/1e6,eventLoopP99Ms:hist.percentile(99)/1e6,eventLoopMaxMs:hist.max/1e6,eventLoopSamples:hist.count,logicalIndexBytes,...process.memoryUsage(),sampledHeapPeak:heapPeak,sampledRssPeak:rssPeak,maxRSS:process.resourceUsage().maxRSS*1024,cgroupPeak:read('/sys/fs/cgroup/memory.peak'),sampleGapMax,samples,scope:'physical D primitive; native timing/publication qualified separately'};
      const environment=process.platform==='linux'&&process.versions.node.startsWith('20.')&&identity.cpuMax==='20000 100000'&&identity.memoryMax==='512000000';
      row.status=row.maxSliceMs<=250&&row.eventLoopP95Ms<=100&&row.eventLoopP99Ms<=250&&row.maxRSS<=300*1024*1024&&row.sampledHeapPeak<=160*1024*1024&&(!row.cgroupPeak||Number(row.cgroupPeak)<=400*1024*1024)?'PASS':'FAIL';row.qualifiedEnvironment=environment;results.push(row);save();console.log('COOP_RESULT',JSON.stringify(row));if(row.status==='FAIL')process.exitCode=1;
    }
  }
  if(results.some(x=>x.status==='NOT_RUN'))process.exitCode=2;
})().catch(e=>{results.push({status:'FAIL',error:e.stack});process.exitCode=1;}).finally(save);
