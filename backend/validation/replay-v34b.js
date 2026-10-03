'use strict';
// Run against preserved exploratory exports. Streaming replay never materializes
// the decompressed 200+ MB archive and verifies every offered serialized value.
const fs=require('fs'),path=require('path'),zlib=require('zlib'),readline=require('readline'),assert=require('assert/strict');
const {encode,decode}=require('../lib/v34bCodec'),{Archive,HOUR_BYTES,MAX_BYTES,BLOCK_BYTES}=require('../lib/v3Archive');
const input=process.argv[2],output=process.argv[3];
async function run(){
  const hours={},counts={},heads=new Map();let peakRss=process.memoryUsage().rss,totalRaw=0,totalPacked=0;
  for(const channel of ['v3','v2','trades','paths','errors','ai']){
    const file=path.join(input,`baseline-${channel}.jsonl.gz`);let previousHour=null,definitions=new Set();counts[channel]=0;
    const stream=readline.createInterface({input:fs.createReadStream(file).pipe(zlib.createGunzip()),crlfDelay:Infinity});
    for await(const line of stream){if(!line)continue;const row=JSON.parse(line),c=encode(row);
      const restored=decode([...c.definitions,c.row])[0];delete restored.captureSchema;
      const original={...row};delete original.captureSchema;assert.deepEqual(restored,original);
      const hour=new Date(row.capturedAt).toISOString().slice(0,13),key=channel+':'+hour;
      if(hour!==previousHour){definitions=new Set();previousHour=hour;}
      const lines=[];for(const d of c.definitions)if(!definitions.has(d.referenceId)){definitions.add(d.referenceId);lines.push(JSON.stringify(d)+'\n');}
      lines.push(JSON.stringify(c.row)+'\n');
      let raw=heads.get(key)||Buffer.alloc(0);
      const h=hours[hour]||(hours[hour]={logicalRows:0,rawBytes:0,compressedBytes:0});
      h.logicalRows++;h.rawBytes+=Buffer.byteLength(line+'\n');totalRaw+=Buffer.byteLength(line+'\n');counts[channel]++;
      for(const text of lines){const bytes=Buffer.from(text);assert.ok(bytes.length<=BLOCK_BYTES,'bounded immutable payload');
        if(raw.length+bytes.length>BLOCK_BYTES){const n=zlib.gzipSync(raw).length;h.compressedBytes+=n;totalPacked+=n;raw=Buffer.alloc(0);}
        raw=Buffer.concat([raw,bytes]);}
      heads.set(key,raw);if(counts[channel]%1000===0)peakRss=Math.max(peakRss,process.memoryUsage().rss);
    }
    for(const [key,raw] of heads){const hour=key.slice(key.indexOf(':')+1),n=zlib.gzipSync(raw).length;hours[hour].compressedBytes+=n;totalPacked+=n;}
    heads.clear();
  }
  const report={version:'V34B_ALL_RETAINED_ROWS_EXACT_REPLAY',counts,totalRawBytes:totalRaw,losslessCompressedBytes:totalPacked,
    maxObservedHourBytes:Math.max(...Object.values(hours).map(h=>h.compressedBytes)),hours,peakRss,
    limitations:['Historical budget-skipped rows are unavailable; retained replay is not offered-demand proof.','Legacy compact rows already include V3.4A rounding/projections; this verifies exact preservation of available serialized evidence.']};
  const stressDir=fs.mkdtempSync(path.join(path.dirname(output),'capacity-stress-'));
  const a=new Archive(stressDir),start=Date.UTC(2026,9,1),crypto=require('crypto');let stressPeak=process.memoryUsage().rss;
  for(let h=0;h<33;h++){
    const entries=Array.from({length:2000},(_,i)=>({channel:'v3',row:{capturedAt:start+h*3600000+i,outputType:'STANDARD_FULL_ENVELOPE_VALIDATION',
      tradeId:'SYNTHETIC',bars:[{ts:start+h*3600000+i}],entropy:crypto.randomBytes(4000).toString('base64')}}));
    a.write(entries);a.write([{channel:'paths',row:{capturedAt:start+h*3600000+3000,outputType:'PRIORITY_AFTER_FULL_STANDARD_ENVELOPE',tradeId:'SYNTHETIC',bars:[{ts:start+h*3600000}]}}]);
    stressPeak=Math.max(stressPeak,process.memoryUsage().rss);
  }
  assert.ok(a.total()<MAX_BYTES);assert.ok(a.total()>230*1048576);assert.equal(new Set([...a.files.values()].map(f=>f.hour)).size,31);
  const before=a.total(),b=new Archive(stressDir);assert.equal(b.total(),before);
  report.capacity={hourBudgetBytes:HOUR_BYTES,capBytes:MAX_BYTES,protectedHours:31,retainedBytes:a.total(),rows:33*2001,
    peakRss:stressPeak,restartBytesEqual:true,standardSkipped:b.ledger.status().totals.filter(x=>x.priority==='STANDARD').reduce((n,x)=>n+x.skippedRows,0),
    prioritySkipped:b.ledger.status().totals.filter(x=>x.priority==='PRIORITY').reduce((n,x)=>n+x.skippedRows,0),dailySnapshots:b.dailyList().length,
    note:'33 full standard near-envelope UTC hours with an additional priority path each hour, under the same 352 MiB V8 heap limit; disk-backed gzip heads remain bounded.'};
  assert.equal(report.capacity.standardSkipped,0);assert.equal(report.capacity.prioritySkipped,0);
  fs.writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify({...report,hours:undefined},null,2));
}
run().catch(e=>{console.error(e);process.exitCode=1;});
