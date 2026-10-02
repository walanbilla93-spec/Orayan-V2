'use strict';
const fs=require('fs'),zlib=require('zlib'),readline=require('readline'),assert=require('assert/strict');
const {Decoder,encode}=require('../lib/v34bCodec');
async function run(){
  const decoder=new Decoder(),samples=[],cutoff=Number(process.argv[3]);
  for await(const line of readline.createInterface({input:fs.createReadStream(process.argv[2]).pipe(zlib.createGunzip()),crlfDelay:Infinity})){
    if(!line)continue;const value=decoder.row(JSON.parse(line));if(!value||value.capturedAt<cutoff||!value.symbol)continue;
    const {archiveChannel,priorityClass,captureGeneration,captureSchema,...row}=value;samples.push(row);
  }
  const contexts=new Map(),refs=new Set(),decode=new Decoder();let block=Buffer.alloc(0),packed=0,rows=0;
  const append=text=>{const bytes=Buffer.from(text+'\n');assert.ok(bytes.length<=65536);
    if(block.length+bytes.length>65536){packed+=zlib.gzipSync(block).length;block=Buffer.alloc(0);}block=Buffer.concat([block,bytes]);};
  for(let round=0;round<40;round++)for(const sample of samples){
    // Repeat the observed changing surfaces with advanced clocks, never remove fields.
    const row={...sample,capturedAt:sample.capturedAt+round*120000,decisionAt:sample.decisionAt+round*120000};
    const key=sample.symbol+'|'+sample.side,context={previous:contexts.get(key)},result=encode(row,context);
    contexts.set(key,context.next);
    for(const d of result.definitions)if(!refs.has(d.referenceId)){refs.add(d.referenceId);append(JSON.stringify(d));decode.row(d);}
    const restored=decode.row(result.row);delete restored.captureSchema;assert.deepEqual(restored,row);
    append(JSON.stringify(result.row));rows++;
  }
  packed+=zlib.gzipSync(block).length;
  const report={version:'LIVE_CHANGING_SURFACE_EXACT_DELTA_REPLAY',sourceRows:samples.length,verifiedRows:rows,
    compressedBytes:packed,averageCompressedBytesPerExposure:packed/rows,projected12000ExposuresPerHour:packed/rows*12000,
    peakRss:process.memoryUsage().rss,limitation:'Observed two-minute changing surfaces replayed with advanced clocks; future market novelty and paths may require priority overflow. This is not ten-day live proof.'};
  fs.writeFileSync(process.argv[4],JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
run().catch(e=>{console.error(e);process.exitCode=1;});
