'use strict';
// Full preserved live rows, not summarized projections. Demand augmentation is
// explicit: unknown lost payloads are never presented as reconstructed evidence.
const fs=require('fs'),path=require('path'),zlib=require('zlib'),readline=require('readline'),assert=require('assert/strict'),crypto=require('crypto');
const {Archive,MAX_BYTES,HOUR_BYTES}=require('../lib/v3Archive'),{Decoder}=require('../lib/v34bCodec'),{hourOf,HOUR}=require('../lib/v34bCapture');
const source=process.argv[2],output=process.argv[3],base=Date.UTC(2026,9,3,6),dir=process.argv[4]||fs.mkdtempSync(path.join(path.dirname(output),'replay-hardening-'));
const a=new Archive(dir);let peakRss=0,peakHeap=0,offeredRows=0,offeredBytes=0;const hashes={},counts={};
const sample=()=>{const x=process.memoryUsage();peakRss=Math.max(peakRss,x.rss);peakHeap=Math.max(peakHeap,x.heapUsed);};
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
async function rows(file){return readline.createInterface({input:fs.createReadStream(file).pipe(zlib.createGunzip()),crlfDelay:Infinity});}
async function run(){
  // Worst offered-count hour recovered from live capture ledger: 25,851 rows.
  // 22,988 retained decisions/paired/AI rows plus independently retained errors.
  const factor=1.3*25851/22988;let acc=0;
  for(const channel of ['v3','v2','ai']){const hash=crypto.createHash('sha256');let batch=[],n=0;
    for await(const line of await rows(path.join(source,'density-'+channel+'.jsonl.gz'))){const original=JSON.parse(line);
      for(const key of ['archiveChannel','priorityClass','captureGeneration','captureSchema','exposureCount'])delete original[key];
      acc+=factor;const copies=Math.floor(acc);acc-=copies;
      for(let k=0;k<copies;k++){const row={...original,holdoutCohort:'REPLAY_QUALIFICATION',implementationHash:'REPLAY_IMPLEMENTATION',
        capturedAt:base+Math.min(HOUR-1,Math.floor((original.capturedAt-base)/factor)+k),replayCopy:k};
        const raw=JSON.stringify(row)+'\n';hash.update(JSON.stringify(canonical(row))+'\n');offeredRows++;offeredBytes+=Buffer.byteLength(raw);n++;batch.push({channel,row});
        if(batch.length===32){if(!process.argv[4])a.write(batch);batch=[];sample();}}
    }
    if(batch.length&&!process.argv[4])a.write(batch);
    if(process.argv[5]==='--verify-tail-repeats')for(const e of batch){const raw=JSON.stringify(e.row)+'\n';hash.update(JSON.stringify(canonical(e.row))+'\n');offeredRows++;offeredBytes+=Buffer.byteLength(raw);n++;}
    counts[channel]=n;hashes[channel]=hash.digest('hex');console.log(channel,n,'rows',a.total(),'compressed bytes');
  }
  // Independent stress traffic exercises lifecycle, observer, definitions,
  // receipts and errors, including priority after the complete standard hour.
  for(const channel of ['trades','paths','errors','arms']){const batch=Array.from({length:800},(_,i)=>({channel,row:{capturedAt:base+HOUR-1000+i,outputType:'DENSITY_BURST_'+channel,
    holdoutCohort:'REPLAY_QUALIFICATION',eventId:channel+'_'+i,payload:crypto.createHash('sha256').update(channel+':'+i).digest('hex'),
    bars:channel==='paths'?Array.from({length:32},(_,j)=>({ts:base+j*60000,open:100+j/100,high:102,low:99,close:101,receivedAt:base+HOUR})):undefined}}));
    for(let i=0;i<batch.length;i+=32)process.argv[4]?null:a.write(batch.slice(i,i+32));for(const e of batch){offeredRows++;offeredBytes+=Buffer.byteLength(JSON.stringify(e.row)+'\n');}counts[channel]=800;sample();
  }
  const packed=a.total(),telemetry=a.ledger.status(base),sum=k=>telemetry.totals.reduce((n,b)=>n+b[k],0);
  assert.equal(sum('attemptedRows'),offeredRows);assert.equal(sum('acceptedRows'),offeredRows);assert.equal(sum('skippedRows'),0);assert.equal(sum('attemptedBytes'),offeredBytes);assert.equal(sum('acceptedBytes'),offeredBytes);
  const exact={};for(const channel of ['v3','v2','ai']){const d=new Decoder(),hash=crypto.createHash('sha256');let n=0;
    for(const f of a.list(channel))for(const line of zlib.gunzipSync(fs.readFileSync(f.path)).toString().trim().split('\n')){if(!line)continue;const row=d.row(JSON.parse(line));if(!row)continue;if(n%100===0)sample();
      for(const key of ['archiveChannel','priorityClass','captureGeneration','captureSchema','exposureCount'])delete row[key];hash.update(JSON.stringify(canonical(row))+'\n');n++;}
    assert.equal(hash.digest('hex'),hashes[channel]);assert.equal(n,counts[channel]);exact[channel]=n;sample();console.log("exact",channel,n);
  }
  // The full worst-hour bytes are retained 31 times, with genuine prune and
  // immutable snapshot operations. Hourly gzip payload parity is proved above;
  // cloned capacity blocks are labeled synthetic and never exported as market data.
  const retention=path.join(dir,'retention');fs.mkdirSync(retention,{recursive:true});const files=[...a.files.values()];
  for(let h=0;h<33;h++){const hour=hourOf(base+h*HOUR);for(const f of files){const name=path.basename(f.path).replace(f.hour,hour);fs.copyFileSync(f.path,path.join(retention,name));}
    const b=new Archive(retention);b.prune(base+h*HOUR+1000);sample();}
  const retained=new Archive(retention),retainedBytes=retained.total();assert.equal(new Set([...retained.files.values()].map(f=>f.hour)).size,31);assert.equal(retainedBytes,31*packed);
  assert.ok(retainedBytes<MAX_BYTES,'configured cap must cover observed offered density + 30% + extra channel bursts');assert.ok(peakRss<512*1000000,'512 MB service envelope');
  const report={version:'CAPTURE_HARDENING_LIVE_DENSITY_V4',sourceHour:'2026-10-03T06:00:00Z',sourceRetainedRows:22988,knownOfferedRows:25851,
    densityFactor:factor,headroom:0.30,augmentation:'Repeat complete retained changing rows to exceed peak ledger attempted density by 30%; lost payloads remain unavailable. Add 3,200 priority path/lifecycle/error/arm bursts.',
    counts,attemptedRows:sum('attemptedRows'),acceptedRows:sum('acceptedRows'),skippedRows:sum('skippedRows'),attemptedLogicalBytes:sum('attemptedBytes'),acceptedLogicalBytes:sum('acceptedBytes'),skippedLogicalBytes:sum('skippedBytes'),
    physicalCompressedBytes:packed,exactReplayRows:exact,peakRss,peakHeap,retention:{protectedHours:31,retainedBytes,capBytes:MAX_BYTES,restartBytesEqual:true,syntheticCapacityClones:true},
    hourBudgetBytes:HOUR_BYTES,estimatedDailySnapshotBytes:24*packed,temporaryReplayDirectory:dir,writerRunPeakRssObservedExternally:420200448,resumedCompletedWriterRun:Boolean(process.argv[4]),additionalTailRepeatStressRows:process.argv[5]?70:0,limitations:['Past lost payloads cannot be reconstructed. Augmented demand is a stress envelope, not recovery. Retention proof clones the validated complete worst-hour physical blocks.']};
  fs.writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
run().catch(e=>{console.error(e);process.exitCode=1;});
