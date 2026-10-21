'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const {Readable,Transform}=require('stream'),{pipeline}=require('stream/promises');
const yazl=require('yazl');
const {sha,CHUNK,SCHEMA,dayAt}=require('./researchStore');
const {Scratch}=require('./researchV3/scratch');
const {visitCheckpointJson}=require('./readCheckpointJson');
const IO=require('./researchV3/io');
const streams=['definitions','decisions','lifecycle','outcomes','experiments','ai_calls','integrity','telemetry','experiment_paths'];
const yieldLoop=()=>new Promise(r=>setImmediate(r));
function choose(store,work,q,id,watermark) {
  if(work.has('chosen',id))return false;
  const m=store.get('events',id);if(!m||m.sequence>watermark)throw Error('MISSING_EVENT_DEPENDENCY:'+id);
  work.put('chosen',id,m);q.push(id);return true;
}
async function closure(store,work,{day=null,sinceAt=null,untilAt=Date.now(),provider=null,watermark=store.state.sequence,compactCutoff=null}={}) {
  const q=work.queue();let steps=0;
  try {
    for(const m of store.values('events')) {
      const selected=m.sequence<=watermark&&(compactCutoff?(m.day>=compactCutoff||m.definitionId===store.writerDefinitionId):(day?m.day===day:m.at>=sinceAt&&m.at<=untilAt))&&(!provider||m.provider===provider);
      if(selected){work.put('window',m.eventId,true);choose(store,work,q,m.eventId,watermark);}
      if(++steps%128===0)await yieldLoop();
    }
    if(day||compactCutoff)for(const [,e]of store.openEpisodes())choose(store,work,q,e.originEventId,watermark);
    let changed=true;
    while(changed) {
      changed=false;let id;
      while((id=q.next())!==null) {
        const m=work.get('chosen',id);if(m.episodeId)changed=work.put('episodes',m.episodeId,true)||changed;
        for(const ref of m.dependencyIds||[])choose(store,work,q,store.get('definitions',ref)||ref,watermark);
        if(++steps%128===0)await yieldLoop();
      }
      if(changed)for(const m of store.values('events'))if(m.sequence<=watermark&&m.episodeId&&work.has('episodes',m.episodeId)&&(!provider||m.stream!=='ai_calls'||m.provider===provider)) {
        choose(store,work,q,m.eventId,watermark);if(++steps%128===0)await yieldLoop();
      }
    }
    store.archiveTraversal={membership:'DISK_EXACT',queue:'DISK_FIFO',residentHistoryRecords:1,residentHistoryRecordCap:1,selectedCount:work.counts.chosen||0,enumerationAttempts:store.enumerationAttempts};
    return work;
  } finally {q.close();}
}
function append(fd,value){IO.write(fd,Buffer.from(value));}
function writeManifest(file,header,work) {
  const fd=fs.openSync(file,'w',0o600);
  try {
    append(fd,JSON.stringify(header).slice(0,-1));
    for(const [field,table,project]of [['windowEventIds','window',(id)=>id],['dependencyEventIds','chosen',(id)=>work.has('window',id)?undefined:id],['events','chosen',(_,m)=>m]]) {
      append(fd,',"'+field+'":[');let comma=false;
      for(const [id,m]of work.entries(table)){const v=project(id,m);if(v===undefined)continue;if(comma)append(fd,',');append(fd,JSON.stringify(v));comma=true;}
      append(fd,']');
    }
    append(fd,'}');fs.fsyncSync(fd);
  }finally{fs.closeSync(fd);}
}
async function build(store,{day=null,sinceAt=null,untilAt=Date.now(),target=null,provider=null}={}) {
  if(!target)throw Error('EXPORT_SCRATCH_TARGET_REQUIRED');
  const work=new Scratch(os.tmpdir(),'orayan-v3-archive-'),watermark=store.state.sequence;
  let pumping,zip;
  try {
    await closure(store,work,{day,sinceAt,untilAt,provider,watermark});
    zip=new yazl.ZipFile();zip.on('error',e=>zip.outputStream.destroy(e));
    pumping=pipeline(zip.outputStream,fs.createWriteStream(target+'.building',{flags:'wx',mode:0o600}));pumping.catch(()=>{});
    const manifest={schemaVersion:SCHEMA,boundedTraversal:true,timezone:store.timezone,day,window:{sinceAt,untilAt,provider},watermark,complete:true,counts:{},entries:[],integrity:{reconciliation:store.status().reconciliation,episodeStates:store.state.episodeStates,criticalLoss:store.state.lostRows,optionalSuppression:store.state.optionalSuppressed,populationComplete:store.state.populationComplete}};
    for(const stream of streams) {
      let has=false;for(const [,m]of work.entries('chosen'))if(m.stream===stream){has=true;break;}if(!has)continue;
      const name='records/'+stream+'.jsonl';
      zip.addReadStreamLazy(name,cb=>{
        let bytes=0,count=0;const hash=crypto.createHash('sha256');
        async function* pieces(){for(const [,m]of work.entries('chosen'))if(m.stream===stream){
          const file=store.rowPath(m);if(IO.hashFile(file)!==m.sha256||fs.statSync(file).size!==m.bytes)throw Error('V3_ROW_CHECKSUM');
          const fd=fs.openSync(file,'r');try{for(let i=0;i<m.chunks;i++){const b=IO.read(fd,Buffer.alloc(Math.min(CHUNK,m.bytes-i*CHUNK)),i*CHUNK);yield Buffer.from(JSON.stringify({meta:m,index:i,data:b.toString('base64')})+'\n');}}finally{fs.closeSync(fd);}count++;await yieldLoop();
        }}
        const meter=new Transform({transform(b,_,done){bytes+=b.length;hash.update(b);done(null,b);},flush(done){manifest.counts[stream]=count;manifest.entries.push({name,bytes,sha256:hash.digest('hex')});done();}});
        pipeline(Readable.from(pieces()),meter).catch(e=>meter.destroy(e));cb(null,meter);
      });
    }
    const schema=Buffer.from(JSON.stringify({schemaVersion:SCHEMA,encoding:'lossless-base64-chunks',chunkChecksum:'sha256',streams}));
    manifest.entries.push({name:'schema.json',bytes:schema.length,sha256:sha(schema)});zip.addBuffer(schema,'schema.json');
    zip.addReadStreamLazy('manifest.json',cb=>{try{const file=path.join(work.dir,'manifest.json');writeManifest(file,manifest,work);cb(null,fs.createReadStream(file));}catch(e){cb(e);}});
    zip.end();await pumping;
    const fd=fs.openSync(target+'.building','r+');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    await verify(target+'.building');fs.renameSync(target+'.building',target);if(process.platform!=='win32')IO.syncDir(path.dirname(target));
    return {manifest:{...manifest,eventCount:work.counts.chosen||0,windowCount:work.counts.window||0},sha256:IO.hashFile(target),bytes:fs.statSync(target).size};
  }catch(e){zip?.outputStream.destroy(e);if(pumping)await pumping.catch(()=>{});throw e;}finally{work.close();}
}
async function manifestTo(file,work) {
  const A=require('./researchArchive');let found=false;
  await A.zipEntries(file,async(name,s)=>{if(name==='manifest.json'){if(found)throw Error('DUPLICATE_MANIFEST');found=true;await pipeline(s,fs.createWriteStream(path.join(work.dir,'manifest.json')));}else s.resume();});
  if(!found)throw Error('ARCHIVE_MANIFEST_MISSING');
  const result={counts:{},entries:[]};
  visitCheckpointJson(path.join(work.dir,'manifest.json'),(field,key,value)=>{
    if(field==='events'&&key!==null){if(!work.put('manifestEvents',value.eventId,value))throw Error('MANIFEST_DUPLICATE_EVENT');if(value.definitionId)work.put('definitions',value.definitionId,value.eventId);}
    else if(field==='windowEventIds'&&key!==null)work.put('window',value,true);
    else if(field==='dependencyEventIds'&&key!==null)work.put('dependencies',value,true);
    else if(field==='entries'&&key!==null){if(result.entries.length>=16)throw Error('ARCHIVE_ENTRY_CAP');result.entries.push(value);}
    else if(!['events','windowEventIds','dependencyEventIds'].includes(field)){if(key===null)result[field]=value;else {result[field]??={};result[field][key]=value;}}
  });
  result.eventCount=work.counts.manifestEvents||0;result.windowCount=work.counts.window||0;return result;
}
async function verify(file) {
  const work=new Scratch(os.tmpdir(),'orayan-v3-verify-'),A=require('./researchArchive');
  try {
    const m=await manifestTo(file,work),actual=Object.create(null),counts=Object.create(null);
    if(!m.complete)throw Error('ARCHIVE_NOT_COMPLETE');
    await A.zipEntries(file,async(name,s)=>{
      const h=crypto.createHash('sha256');let bytes=0;
      if(name.startsWith('records/')) {
        const meter=new Transform({transform(b,_,done){h.update(b);bytes+=b.length;done(null,b);}});s.pipe(meter);
        for await(const p of A.lines(meter)) {
          const meta=work.get('manifestEvents',p.meta.eventId);
          if(!meta||JSON.stringify(meta)!==JSON.stringify(p.meta)||!Number.isInteger(p.index)||p.index<0||p.index>=meta.chunks)throw Error('ARCHIVE_EVENT_METADATA');
          const key=meta.eventId+':'+p.index;if(!work.put('pieces',key,p.data))throw Error('ARCHIVE_DUPLICATE_CHUNK');
          const n=(work.get('pieceCounts',meta.eventId)||0)+1;work.put('pieceCounts',meta.eventId,n);
          if(n===meta.chunks) {
            const eventFile=path.join(work.dir,'event.json'),fd=fs.openSync(eventFile,'w'),eh=crypto.createHash('sha256');let length=0;
            try {for(let i=0;i<meta.chunks;i++){const data=work.get('pieces',meta.eventId+':'+i);if(data===undefined)throw Error('ARCHIVE_MISSING_CHUNK');const b=Buffer.from(data,'base64');eh.update(b);length+=b.length;IO.write(fd,b);}}finally{fs.closeSync(fd);}
            if(length!==meta.bytes||eh.digest('hex')!==meta.sha256)throw Error('ARCHIVE_EVENT_CHECKSUM_FAILED');
            let id;visitCheckpointJson(eventFile,(f,k,v)=>{if(f==='eventId'&&k===null)id=v;});if(id!==meta.eventId)throw Error('ARCHIVE_EVENT_ID_MISMATCH');
            work.put('seen',meta.eventId,true);counts[meta.stream]=(counts[meta.stream]||0)+1;
          }
        }
      } else for await(const b of s){h.update(b);bytes+=b.length;}
      if(name!=='manifest.json'){if(actual[name])throw Error('ARCHIVE_DUPLICATE_ENTRY');if(Object.keys(actual).length>=16)throw Error('ARCHIVE_ENTRY_CAP');actual[name]={bytes,sha256:h.digest('hex')};}
    });
    if((work.counts.seen||0)!==m.eventCount)throw Error('ARCHIVE_EVENT_RECONCILIATION_FAILED');
    for(const e of m.entries)if(!actual[e.name]||actual[e.name].bytes!==e.bytes||actual[e.name].sha256!==e.sha256)throw Error('ARCHIVE_CHECKSUM_FAILED');
    for(const [s,n]of Object.entries(m.counts))if(counts[s]!==n)throw Error('ARCHIVE_STREAM_COUNT_MISMATCH');
    for(const [id,e]of work.entries('manifestEvents')){if(!work.has('seen',id))throw Error('ARCHIVE_EVENT_RECONCILIATION_FAILED');for(const ref of e.dependencyIds||[])if(!work.has('manifestEvents',ref)&&!work.has('definitions',ref))throw Error('ARCHIVE_DEPENDENCY_MISSING');}
    return m;
  }finally{work.close();}
}
async function rows(store,visit) {
  const work=new Scratch(os.tmpdir(),'orayan-v3-rows-'),A=require('./researchArchive');
  const Spool=require('./researchV3/spool'),C=require('./researchV3/codec');
  const refs=new Spool.Output(path.join(work.dir,'rows.run'));
  const ref=(m,file)=>refs.add(C.record(C.key('E','record',[m.eventId]),Buffer.from(JSON.stringify({sequence:m.sequence,file,sha256:m.sha256,bytes:m.bytes})),m.sequence));
  store.exportReaders=(store.exportReaders||0)+1;
  try {
    // Retained archives may contain rows whose hot canonical metadata has been
    // compacted. Preserve the old provider-ledger/export visibility of those rows.
    for(const a of store.values('archives'))if(!a.expired)await A.zipEntries(path.join(store.dir,'archives',a.filename),async(name,s)=>{
      if(!name.startsWith('records/')){s.resume();return;}
      for await(const p of A.lines(s)) {
        const id=p.meta.eventId;if(work.has('seen',id))continue;
        const key=id+':'+p.index;if(!work.put('pieces',key,p.data))continue;
        const count=(work.get('counts',id)||0)+1;work.put('counts',id,count);
        if(count===p.meta.chunks){
          const chunks=[];for(let i=0;i<p.meta.chunks;i++){const data=work.get('pieces',id+':'+i);if(data===undefined)throw Error('INCOMPLETE_CRITICAL_CHUNKS');chunks.push(Buffer.from(data,'base64'));}
          const b=Buffer.concat(chunks);if(sha(b)!==p.meta.sha256)throw Error('EVENT_CHECKSUM_MISMATCH');
          const file=path.join(work.dir,sha(id)+'.row');fs.writeFileSync(file,b);ref(p.meta,file);work.put('seen',id,true);
        }
      }
    });
    for(const m of store.values('events'))if(!work.has('seen',m.eventId))ref(m,store.rowPath(m));
    refs.close();
    for(const [id]of work.entries('counts'))if(!work.has('seen',id))throw Error('INCOMPLETE_CRITICAL_CHUNKS');
    const source=new Spool.Input(path.join(work.dir,'rows.run'));
    const records={*[Symbol.iterator](){let r;while((r=source.next()))yield r;}};
    let sorted;try{sorted=Spool.sort(path.join(work.dir,'ordered'),records,(a,b)=>JSON.parse(a.value).sequence-JSON.parse(b.value).sequence||Buffer.compare(a.key,b.key));}finally{source.close();}
    const input=new Spool.Input(sorted);let r,n=0;
    try{while((r=input.next())){const descriptor=JSON.parse(r.value),b=fs.readFileSync(descriptor.file);if(b.length!==descriptor.bytes||sha(b)!==descriptor.sha256)throw Error('EVENT_CHECKSUM_MISMATCH');await visit(JSON.parse(b));if(++n%64===0)await yieldLoop();}}finally{input.close();}
  }finally{if(refs.fd!==null){try{refs.close();}catch{}}store.exportReaders--;work.close();}
}
async function closeDay(store,day) {
  const old=store.get('archives',day);if(old&&!old.expired)return old;
  if(day>=dayAt(Date.now(),store.timezone))throw Error('DAY_NOT_COMPLETED');
  const filename='orayan-research-'+day+'.zip',target=path.join(store.dir,'archives',filename);
  if(fs.existsSync(target+'.building'))fs.unlinkSync(target+'.building');
  const result=fs.existsSync(target)?{manifest:await verify(target),bytes:fs.statSync(target).size,sha256:IO.hashFile(target)}:await build(store,{day,target});
  const receipt={day,filename,sha256:result.sha256,bytes:result.bytes,verified:true,published:true,eventCount:result.manifest.windowCount};
  store.transaction(()=>{store.put('archives',day,receipt);store.state.lastClosedDay=day;store.state.archivedRows+=receipt.eventCount;store.state.archivedByStream??={};
    for(const e of store.values('events'))if(e.day===day)store.state.archivedByStream[e.stream]=(store.state.archivedByStream[e.stream]||0)+1;});
  store.flush();return receipt;
}
async function prune(store,work,remove) {
  for(const [id,m]of store.entries('events'))if(remove(m)) {
    work.put('removed',id,true);store.transaction(()=>{store.remove('events',id);store.state.retainedRows--;store.state.retainedBytes-=m.bytes;});
    // Blob deletion follows a durable index checkpoint; interrupted cleanup leaks
    // disk space, never evidence referenced by the current root.
    work.put('blobs',m.sha256,m);await yieldLoop();
  }
  for(const [key,d]of store.entries('dedupe'))if(work.has('removed',d.eventId))store.remove('dedupe',key);
  for(const m of store.values('events')){if(m.episodeId)work.put('liveEpisodes',m.episodeId,true);if(m.tradeId)work.put('liveTrades',m.tradeId,true);}
  for(const [id,e]of store.entries('episodes'))if(!work.has('liveEpisodes',id)&&e.state!=='OPEN') store.transaction(()=>{store.remove('episodes',id);store.remove('openEpisodes',id);store.state.episodeStates[e.state]--;});
  for(const [key,id]of store.entries('sourceEpisodes'))if(!store.get('episodes',id)){store.remove('sourceEpisodes',key);store.remove('episodeMetadata',key);}
  for(const [key,v]of store.entries('nativeEpisodeIndex'))if(v.episodeId&&!store.get('sourceEpisodes',v.episodeId))store.remove('nativeEpisodeIndex',key);
  for(const [id,a]of store.entries('aiAttempts'))if(!store.get('events',a.eventId)){store.remove('aiAttempts',id);store.remove('openAttempts',id);}
  for(const [id]of store.entries('extremes'))if(!work.has('liveTrades',id))store.remove('extremes',id);
  store.flush();
  // A content hash may be shared. Disk membership prevents removing a live blob.
  for(const m of store.values('events'))work.put('liveBlobs',m.sha256,true);
  for(const [hash,m]of work.entries('blobs'))if(!work.has('liveBlobs',hash)&&fs.existsSync(store.rowPath(m)))fs.unlinkSync(store.rowPath(m));
}
async function retention(store) {
  if(require('./researchArchive').preservationEnabled()||store.exportReaders)return;
  const work=new Scratch(os.tmpdir(),'orayan-v3-retain-');
  try {
    // Select the oldest expired candidate by cursor; at most seven survivor
    // descriptors are needed, even after a long offline migration.
    for(;;){let count=0,old;for(const a of store.values('archives'))if(!a.expired){count++;if(!old||a.day<old.day)old=a;}if(count<=7)break;
      const file=path.join(store.dir,'archives',old.filename);await verify(file);if(IO.hashFile(file)!==old.sha256||!old.verified||!old.published)throw Error('RETENTION_PUBLICATION_GATE');
      const survivors=new Scratch(os.tmpdir(),'orayan-v3-survivors-');try {
        for(const a of store.values('archives'))if(!a.expired&&a.day>old.day){const one=new Scratch(os.tmpdir(),'orayan-v3-manifest-');try{await verify(path.join(store.dir,'archives',a.filename));await manifestTo(path.join(store.dir,'archives',a.filename),one);for(const [id]of one.entries('manifestEvents'))survivors.put('ids',id,true);}finally{one.close();}}
        for(const e of store.values('events'))if(e.day===old.day&&!survivors.has('ids',e.eventId)&&e.episodeId&&require('./researchStoreV3').unresolved(store.get('episodes',e.episodeId)||{}))throw Error('RETENTION_OPEN_EPISODE_DEPENDENCY');
        store.put('archives',old.day,{...old,expired:true});store.flush();
        await prune(store,work,m=>m.day<=old.day&&!survivors.has('ids',m.eventId));
        fs.unlinkSync(file);
      }finally{survivors.close();}
    }
  }finally{work.close();}
}
async function compactIndex(store) {
  if(require('./researchArchive').preservationEnabled()||!store.state.lastClosedDay||store.state.indexCompactedThroughDay===store.state.lastClosedDay||store.exportReaders)return;
  const work=new Scratch(os.tmpdir(),'orayan-v3-compact-');
  try {
    const cutoff=new Date(Date.parse(store.state.lastClosedDay+'T12:00:00Z')-2*86400000).toISOString().slice(0,10);
    await closure(store,work,{compactCutoff:cutoff});
    // Existing V2 keeps metadata for unsealed physical segments. V3 row blobs
    // remain the live source until a verified archive owns that day.
    await prune(store,work,m=>!work.has('chosen',m.eventId)&&!!store.get('archives',m.day)?.published);
    store.state.indexCompactedThroughDay=store.state.lastClosedDay;store.flush();
  }finally{work.close();}
}
async function tick(store,now=Date.now()) {
  const today=dayAt(now,store.timezone),next=d=>new Date(Date.parse(d+'T12:00:00Z')+86400000).toISOString().slice(0,10);
  let day=store.state.lastClosedDay?next(store.state.lastClosedDay):dayAt(store.state.startedAt,store.timezone);
  while(day<today){await closeDay(store,day);await retention(store);day=next(day);}
  await retention(store);await compactIndex(store);await collectGarbage(store);
}
async function collectGarbage(store){if(require('./researchArchive').preservationEnabled()||store.exportReaders)return;for(const a of store.values('archives'))if(a.expired){const file=path.join(store.dir,'archives',a.filename);if(fs.existsSync(file)){if(IO.hashFile(file)!==a.sha256)throw Error('GARBAGE_ARCHIVE_CHECKSUM');fs.unlinkSync(file);}}store.index.collectFiles();}
async function isV3Archive(file){let v3=false;await require('./researchArchive').zipEntries(file,async(name,s)=>{if(name!=='manifest.json'){s.resume();return;}let prefix='';for await(const b of s)if(prefix.length<1024)prefix+=b.toString('utf8',0,Math.min(b.length,1024-prefix.length));v3=/"boundedTraversal":true/.test(prefix);});return v3;}
module.exports={build,closure,verify,rows,closeDay,retention,compactIndex,tick,manifestTo,prune,writeManifest,collectGarbage,isV3Archive};
