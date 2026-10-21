'use strict';
const fs=require('node:fs'),path=require('node:path'),{performance,monitorEventLoopDelay}=require('node:perf_hooks');
const {Harness}=require('../test/helpers/researchV3Publication'),Q=require('../lib/researchV3/cooperative'),C=require('../lib/researchV3/codec'),{create}=require('../test/helpers/researchV3NativeReplay');
const root=path.resolve(process.argv[2]||'native-scratch'),cadence=Number(process.argv[3]||15000),mode=process.argv[4]||'baseline',duration=Number(process.env.V3_NATIVE_DURATION||900000);
if(![15000,60000].includes(cadence)||!['baseline','fold'].includes(mode)||!Number.isSafeInteger(duration)||duration<cadence)throw Error('native parameters');
fs.mkdirSync(root,{recursive:true});const replay=create(),origin=performance.now()+2000,count=Math.floor(duration/cadence),hist=monitorEventLoopDelay({resolution:10});let index=0,running=false,done=false,store,cycles=0,cycleActive=false,writerActive=false,error=null,startMax=0,completeMax=0,drift=0,barrierMax=0,writeCount=0,ordinaryFences=0;
let dueOrigin=Infinity;const s=new Q.Scheduler({native:()=>({ready:index<count&&performance.now()>=dueOrigin+index*cadence,running,due:index<count?dueOrigin+index*cadence:Infinity})});
const budget={reserve:{encoded:2*1024*1024,accounted:4*1024*1024,entries:4096},completionBoundMs:600000};let fixture;
function trace(file,row){fs.appendFileSync(path.join(root,file),JSON.stringify(row)+'\n');}
async function invoke(i){const due=dueOrigin+i*cadence;await new Promise(resolve=>setTimeout(resolve,Math.max(0,due-performance.now())));running=true;const start=performance.now(),actual=await replay.run(i);startMax=Math.max(startMax,Math.max(0,start-due));
  if(mode==='fold'){const reference=JSON.parse(fs.readFileSync(path.join(root,'baseline-'+i+'.json')));if(reference.digest!==actual.digest)drift++;
    // Single bounded pending protected transaction; never enqueue multiple retries.
    while(writerActive)await new Promise(r=>setImmediate(r));writerActive=true;
    try{await store.transaction(actual.body.outcomes.map((v,n)=>({key:C.key('O','record',['outcome/'+i+'/'+n]),value:Buffer.from(JSON.stringify(v))})),{protectedWrite:true});}finally{writerActive=false;}
  }else{while(writerActive)await Q.immediate();writerActive=true;try{await store.transaction(actual.body.outcomes.map((v,n)=>({key:C.key('O','record',['outcome/'+i+'/'+n]),value:Buffer.from(JSON.stringify(v))})),{protectedWrite:true});}finally{writerActive=false;}fs.writeFileSync(path.join(root,'baseline-'+i+'.json'),JSON.stringify({digest:actual.digest,startDelay:Math.max(0,start-due)}));}
  const complete=performance.now();completeMax=Math.max(completeMax,complete-due);trace(mode+'-probes.jsonl',{i,due:due-dueOrigin,start:start-dueOrigin,complete:complete-dueOrigin,startDelay:Math.max(0,start-due),digest:actual.digest});running=false;index=i+1;
}
let cyclePromise=null;
async function work(){let nextCycle=performance.now();while(!done){
    if(mode==='fold'&&!cycleActive&&!writerActive&&!running&&performance.now()>=nextCycle){cycleActive=true;cyclePromise=store.cycle().then(r=>{cycles++;barrierMax=Math.max(barrierMax,r.barrierMs);nextCycle=performance.now()+1000;}).catch(e=>{error=e;done=true;}).finally(()=>{cycleActive=false;});}
    if(!writerActive&&!store.barrier&&!running&&(!store.cycleBusy||store.budget.P)){writerActive=true;try{const i=writeCount++;await store.transaction([{key:Buffer.from(fixture.representative[i%fixture.representative.length],'hex'),value:Buffer.alloc(128,i%255)}]);}catch(e){if(['OVERLAY_CAPACITY','ENVELOPE_UNQUALIFIED','FOLD_STARVED','WRITER_BUSY'].includes(e.code))ordinaryFences++;else throw e;}finally{writerActive=false;}}
    await new Promise(r=>setTimeout(r,100));
  }}
(async()=>{const fixtureHelper=require('../test/helpers/researchV3PhysicalFixture');fixture=fixtureHelper.prepare(root);const dir=path.join(root,mode+'-store');fixtureHelper.attach(root,dir,fixture);store=await new Harness(dir,{scheduler:s,budget,fixture}).init();
  await store.transaction(fixture.representative.map(key=>({key:Buffer.from(key,'hex'),value:Buffer.alloc(128,66)})));dueOrigin=performance.now()+2000;hist.enable();const start=performance.now(),sampler=setInterval(()=>trace(mode+'-memory.jsonl',{at:performance.now()-start,...process.memoryUsage(),maxRSS:process.resourceUsage().maxRSS*1024,budget:store?.budget.status(),phase:s.phase}),100);let worker;
  try{worker=work().catch(e=>{error=e;done=true;});for(let i=0;i<count;i++){if(error)throw error;await invoke(i);}await new Promise(r=>setTimeout(r,Math.max(0,dueOrigin+duration-performance.now())));}finally{done=true;if(worker)await worker;if(cyclePromise)await cyclePromise;clearInterval(sampler);hist.disable();}
  if(error)throw error;let increase=0;const probes=fs.readFileSync(path.join(root,mode+'-probes.jsonl'),'utf8').trim().split('\n').map(JSON.parse);if(mode==='fold')for(const p of probes){const baseline=JSON.parse(fs.readFileSync(path.join(root,'baseline-'+p.i+'.json')));increase=Math.max(increase,p.startDelay-baseline.startDelay);}
  const row={mode,cadence,duration,minimumDurationQualified:duration>=900000,probes:probes.length,expectedProbes:count,cycles,startMax,completeMax,increase,drift,barrierMax,ordinaryFences,writeCount,eventLoopP95:hist.percentile(95)/1e6,eventLoopP99:hist.percentile(99)/1e6,eventLoopMax:hist.max/1e6,metrics:s.metrics,nativeSource:replay.identity};
  row.status=probes.length===count&&drift===0&&startMax<=(mode==='baseline'?500:750)&&increase<=250&&barrierMax<=750&&s.metrics.sliceMaxMs<=250&&row.eventLoopP95<=100&&row.eventLoopP99<=250&&(mode==='baseline'||cycles>=3)?'PASS':'FAIL';if(duration<900000)row.status='NOT_RUN_MINIMUM_DURATION';
  fs.writeFileSync(path.join(root,mode+'-results.json'),JSON.stringify(row,null,2));if(store)await store.close();console.log('NATIVE_RESULT',JSON.stringify(row));if(row.status!=='PASS')process.exitCode=2;
})().catch(e=>{fs.writeFileSync(path.join(root,mode+'-results.json'),JSON.stringify({status:'FAIL',error:e.stack}));console.error(e);process.exitCode=1;});
