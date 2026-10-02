'use strict';
const fs=require('fs'),path=require('path'),zlib=require('zlib'),crypto=require('crypto');
const {encode:compact,SCHEMA}=require('./v34bCodec');
const {CaptureLedger,priority,atomic,CHANNELS}=require('./v34bCapture');
const HOUR=3600000,MIN_RETAIN=30*HOUR,MAX_BYTES=128*1048576,HOUR_BYTES=3.25*1048576;
const BLOCK_BYTES=65536,ROW_BYTES=8192,TRADE_ROW_BYTES=32768;
const FILE=/^(v2|v3|ai|trades|errors|paths|arms)-(\d{4}-\d{2}-\d{2}-\d{2})-(\d{5})\.jsonl\.gz$/;
const hourOf=at=>new Date(at).toISOString().slice(0,13).replace('T','-');
const hourAt=hour=>Date.parse(hour.slice(0,10)+'T'+hour.slice(11)+':00:00Z');
class Archive {
  constructor(dir,options={}) {
    this.dir=dir;fs.mkdirSync(dir,{recursive:true});
    this.ledger=new CaptureLedger(dir);this.sessions=new Map();
    const txn=path.join(dir,'archive-transaction.json');
    if(fs.existsSync(txn)){
      const pending=JSON.parse(fs.readFileSync(txn,'utf8'));
      for(const name of pending.names){const file=path.join(dir,name);if(fs.existsSync(file+'.tmp'))fs.renameSync(file+'.tmp',file);}
      this.ledger.state=pending.ledger;this.ledger.save();
      for(const [h,bucket] of pending.hours)atomic(path.join(this.ledger.dir,h+'.json'),bucket);
      fs.unlinkSync(txn);
    }
    this.ledger.reconcileInterrupted();
    this.maxBytes=options.maxBytes??MAX_BYTES;this.hourBytes=options.hourBytes??HOUR_BYTES;
    this.files=new Map();this.heads=new Map();this.definitions=new Set();this.leases=new Map();
    this.skipped=0;this.pausedUntil=null;this.summaryHours={};
    for(const name of fs.readdirSync(dir)) {
      const m=FILE.exec(name);if(!m)continue;
      const item={path:path.join(dir,name),size:fs.statSync(path.join(dir,name)).size,channel:m[1],hour:m[2],sequence:Number(m[3])};
      this.files.set(name,item);const key=item.channel+':'+item.hour;
      if(!this.heads.has(key)||item.sequence>this.heads.get(key).sequence)this.heads.set(key,item);
    }
    // Crash-left export links are temporary snapshots, never research originals.
    for(const name of fs.readdirSync(dir))if(/^export-[a-f0-9]{24}-(\d+|[a-z]+-manifest)\.gz$/.test(name))fs.unlinkSync(path.join(dir,name));
  }
  total(){return [...this.files.values()].reduce((n,f)=>n+f.size,0);}
  expireSessions(now){for(const [id,s] of this.sessions)if(s.expiresAt<now){for(const v of Object.values(s.channels))v.cleanup();this.sessions.delete(id);}}
  prune(now) {
    this.expireSessions(now);
    this.daily(now);
    const hours=[...new Set([...this.files.values()].map(f=>f.hour))].sort();
    // Whole hours preserve candidate/definition joins. Never evict within the protected 30h window.
    for(const hour of hours) {
      if(hourAt(hour)+HOUR>now-MIN_RETAIN)continue;
      const group=[...this.files.values()].filter(f=>f.hour===hour);
      if(group.some(f=>this.leases.has(f.path)))continue;
      for(const f of group){fs.unlinkSync(f.path);this.files.delete(path.basename(f.path));this.heads.delete(f.channel+':'+hour);}
      delete this.summaryHours[hour];
    }
  }
  write(entries) {
    if(!entries.length)return;
    const klass=priority(entries);this.ledger.account(entries,'attempted',klass);
    try{return this.commit(entries,klass);}catch(e){
      // A prepared durable transaction is recoverable, not a skipped write.
      if(!fs.existsSync(path.join(this.dir,'archive-transaction.json')))this.ledger.account(entries,'skipped',klass);
      throw e;
    }
  }
  commit(entries,klass) {
    const now=Math.max(...entries.map(e=>e.row.capturedAt));this.prune(now);
    const groups=new Map(),newDefinitions=[];
    for(const {channel,row} of entries) {
      if(!CHANNELS.includes(channel))throw Error('INVALID_ARCHIVE_CHANNEL');
      const hour=hourOf(row.capturedAt),key=channel+':'+hour;
      const c=compact(row),lines=groups.get(key)||[];
      for(const d of c.definitions) {
        const definitionKey=key+':'+d.referenceId;
        if(this.definitions.has(definitionKey)||newDefinitions.includes(definitionKey))continue;
        lines.push(JSON.stringify({...d,archiveChannel:channel})+'\n');
        newDefinitions.push(definitionKey);
      }
      const line=JSON.stringify({...c.row,archiveChannel:channel,priorityClass:klass,
        captureGeneration:this.ledger.state.generation+1,exposureCount:1})+'\n';
      if(Buffer.byteLength(line)>(['trades','paths'].includes(channel)?TRADE_ROW_BYTES:ROW_BYTES))throw Error('COMPACT_ROW_TOO_LARGE');
      lines.push(line);groups.set(key,lines);
    }
    const changes=[],hourDeltas=new Map();let delta=0;
    for(const [key,lines] of groups) {
      const split=key.indexOf(':'),channel=key.slice(0,split),hour=key.slice(split+1);
      let head=this.heads.get(key),raw=head?zlib.gunzipSync(fs.readFileSync(head.path),{maxOutputLength:BLOCK_BYTES}):Buffer.alloc(0);
      let sequence=head?.sequence??0,oldSize=head?.size??0;
      const flush=()=>{
        if(!raw.length)return;
        const name=`${channel}-${hour}-${String(sequence).padStart(5,'0')}.jsonl.gz`,bytes=zlib.gzipSync(raw);
        const item={path:path.join(this.dir,name),size:bytes.length,channel,hour,sequence};
        changes.push({name,item,bytes});const growth=bytes.length-oldSize;
        delta+=growth;hourDeltas.set(hour,(hourDeltas.get(hour)||0)+growth);
      };
      for(const line of lines) {
        const bytes=Buffer.from(line);
        if(bytes.length>BLOCK_BYTES)throw Error('COMPACT_BLOCK_TOO_LARGE');
        if(raw.length+bytes.length>BLOCK_BYTES){flush();sequence++;raw=Buffer.alloc(0);oldSize=0;}
        raw=Buffer.concat([raw,bytes]);
      }
      flush();
    }
    const blocked=[...hourDeltas].some(([hour,growth])=>
      [...this.files.values()].filter(f=>f.hour===hour).reduce((n,f)=>n+f.size,0)+growth>this.hourBytes);
    const reserveBlocked=[...hourDeltas].some(([hour,growth])=>
      [...this.files.values()].filter(f=>f.hour===hour).reduce((n,f)=>n+f.size,0)+growth>this.hourBytes*.80);
    const reserve=Math.min(this.maxBytes*.20,31*this.hourBytes*.20);
    if(klass!=='PRIORITY'&&(blocked||reserveBlocked||this.total()+delta>this.maxBytes-reserve)) {
      this.skipped+=entries.length;this.pausedUntil=hourAt(hourOf(now))+HOUR;
      throw Object.assign(Error('V3_ARCHIVE_BUDGET_PAUSED'),{reasonCode:'V3_ARCHIVE_BUDGET_PAUSED'});
    }
    // Durable redo intent: restart completes every staged channel before reads.
    for(const c of changes)fs.writeFileSync(c.item.path+'.tmp',c.bytes);
    const txn=path.join(this.dir,'archive-transaction.json'),ledger=JSON.parse(JSON.stringify(this.ledger.state));
    const hours=new Map([...this.ledger.hours].map(([h,b])=>[h,JSON.parse(JSON.stringify(b))]));
    for(const {channel,row} of entries){
      const h=hourOf(row.capturedAt),key=[channel,row.outputType||'UNKNOWN',klass].join('|'),bytes=Buffer.byteLength(JSON.stringify(row)+'\n');
      for(const b of [ledger.totals[key],hours.get(h)[key]]){b.acceptedRows++;b.acceptedBytes+=bytes;}
      ledger.cursors[channel]=(ledger.cursors[channel]||0)+1;
    }
    ledger.generation++;
    atomic(txn,{names:changes.map(c=>c.name),ledger,hours:[...hours]});
    for(const c of changes) {
      fs.renameSync(c.item.path+'.tmp',c.item.path);
      this.files.set(c.name,c.item);this.heads.set(c.item.channel+':'+c.item.hour,c.item);
    }
    this.ledger.state=ledger;this.ledger.hours=hours;
    for(const [h,b] of hours)atomic(path.join(this.ledger.dir,h+'.json'),b);
    this.ledger.save();fs.unlinkSync(txn);
    for(const key of newDefinitions)this.definitions.add(key);
    while(this.definitions.size>16384)this.definitions.delete(this.definitions.values().next().value);
    if(this.pausedUntil && now>=this.pausedUntil)this.pausedUntil=null;
    for(const {channel,row} of entries) {
      const h=hourOf(row.capturedAt),stats=this.summaryHours[h]||(this.summaryHours[h]={v3:0,v2:0,ai:0,trades:0,accepted:0,rejected:0});
      stats[channel]=(stats[channel]||0)+1;if(channel==='v3')stats[row.v3Decision==='ACCEPT_SHADOW'?'accepted':'rejected']++;
    }
  }
  list(channel){return [...this.files.values()].filter(f=>f.channel===channel).sort((a,b)=>a.path.localeCompare(b.path));}
  snapshot(channel) {
    const token=crypto.randomBytes(12).toString('hex'),links=[],files=[],originals=[];
    try {
      for(const [i,f] of this.list(channel).entries()) {
        originals.push(f.path);this.leases.set(f.path,(this.leases.get(f.path)||0)+1);
        // Heads are replaced atomically on append. Hard links freeze their complete gzip members.
        const target=path.join(this.dir,`export-${token}-${i}.gz`);fs.linkSync(f.path,target);links.push(target);
        files.push({path:target,size:f.size});
      }
      if(!files.length){const target=path.join(this.dir,`export-${token}-0.gz`),bytes=zlib.gzipSync('');
        fs.writeFileSync(target,bytes);links.push(target);files.push({path:target,size:bytes.length});}
    }catch(e){for(const p of links)fs.unlinkSync(p);for(const p of originals)this.release(p);throw e;}
    return {files,cleanup:()=>{for(const p of links)if(fs.existsSync(p))fs.unlinkSync(p);for(const p of originals)this.release(p);}};
  }
  release(p){const n=(this.leases.get(p)||1)-1;if(n)this.leases.set(p,n);else this.leases.delete(p);}
  status(){return {captureSchema:SCHEMA,sizeBytes:this.total(),maxBytes:this.maxBytes,hourBudgetBytes:this.hourBytes,
    priorityReserveFraction:.20,priorityOverflowBytes:Math.max(0,this.total()-this.maxBytes),
    retentionHeadroomBytes:Math.max(0,this.maxBytes-this.total()),telemetry:this.ledger.status(),
    minimumRetentionHours:30,maximumBlockRawBytes:BLOCK_BYTES,maximumRowRawBytes:TRADE_ROW_BYTES,maximumCandidateRawBytes:ROW_BYTES,
    budgetSkippedRecords:this.skipped,capturePausedUntil:this.pausedUntil,
    earliestHour:[...this.files.values()].map(f=>f.hour).sort()[0]||null};}
  checkpoint(){return {definitions:[...this.definitions].slice(-512),summaryHours:this.summaryHours,skipped:this.skipped,pausedUntil:this.pausedUntil};}
  restore(saved){if(!saved)return;this.definitions=new Set((saved.definitions||[]).slice(-16384));
    this.summaryHours=saved.summaryHours||{};this.skipped=saved.skipped||0;this.pausedUntil=saved.pausedUntil||null;}
  cohort(now=Date.now()) {
    this.expireSessions(now);
    while(this.sessions.size>=3){const id=this.sessions.keys().next().value,s=this.sessions.get(id);for(const v of Object.values(s.channels))v.cleanup();this.sessions.delete(id);}
    const generation=crypto.randomBytes(12).toString('hex'),channels={};
    for(const channel of CHANNELS)channels[channel]=this.snapshot(channel);
    const retained={};
    for(const [channel,snapshot] of Object.entries(channels)){
      const stats=retained[channel]={physicalRows:0,logicalRows:0,definitionRows:0,byRecordType:{},compressedBytes:0};
      for(const f of snapshot.files){stats.compressedBytes+=f.size;
        const lines=zlib.gunzipSync(fs.readFileSync(f.path),{maxOutputLength:BLOCK_BYTES}).toString('utf8').split('\n');
        for(const line of lines)if(line){const row=JSON.parse(line),type=row.outputType||'UNKNOWN';stats.physicalRows++;
          stats.byRecordType[type]=(stats.byRecordType[type]||0)+1;
          if(type==='V3_IMMUTABLE_PAYLOAD'||type.endsWith('_DEFINITION'))stats.definitionRows++;else stats.logicalRows++;
        }
      }
    }
    const result={generation,sequence:this.ledger.state.generation,watermarkAt:now,
      cursors:{...this.ledger.state.cursors},retained,expiresAt:now+10*60000,channels};
    this.sessions.set(generation,result);return result;
  }
  daily(now) {
    const root=path.join(this.dir,'daily-snapshots');fs.mkdirSync(root,{recursive:true});
    const today=new Date(now).toISOString().slice(0,10),days=[...new Set([...this.files.values()].map(f=>f.hour.slice(0,10)))].filter(d=>d<today);
    for(const day of days){
      const target=path.join(root,day),manifest=path.join(target,'manifest.json');if(fs.existsSync(manifest))continue;
      fs.mkdirSync(target,{recursive:true});const items=[];
      for(const f of [...this.files.values()].filter(f=>f.hour.startsWith(day))){
        const name=path.basename(f.path),destination=path.join(target,name);if(!fs.existsSync(destination))fs.linkSync(f.path,destination);
        items.push({name,channel:f.channel,hour:f.hour,size:f.size,sha256:crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex')});
      }
      atomic(manifest,{version:'IMMUTABLE_UTC_DAILY_V1',day,createdAt:now,watermarkAt:Date.parse(day+'T00:00:00Z')+24*HOUR-1,
        metadata:this.snapshotMetadata?.()||null,
        sequence:this.ledger.state.generation,cursors:{...this.ledger.state.cursors},files:items,
        partialFirstDay:this.ledger.state.startedAt>=Date.parse(day+'T00:00:00Z')});
    }
  }
  dailyList(){const root=path.join(this.dir,'daily-snapshots');if(!fs.existsSync(root))return [];
    return fs.readdirSync(root).filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d)&&fs.existsSync(path.join(root,d,'manifest.json'))).map(day=>JSON.parse(fs.readFileSync(path.join(root,day,'manifest.json'),'utf8')));}
}
module.exports={Archive,HOUR_BYTES,MAX_BYTES,MIN_RETAIN,BLOCK_BYTES,ROW_BYTES,TRADE_ROW_BYTES,FILE};
