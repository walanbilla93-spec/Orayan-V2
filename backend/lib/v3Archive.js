'use strict';
const minimal=require('./minimalCapture');

const fs=require('fs'),path=require('path'),zlib=require('zlib'),crypto=require('crypto');
const {encode:compact,SCHEMA}=require('./v34bCodec');
const {CaptureLedger,priority,atomic,CHANNELS,POLICY,digest}=require('./v34bCapture');
const HOUR=3600000,MIN_RETAIN=30*HOUR,MAX_BYTES=320*1048576,HOUR_BYTES=10*1048576;
const BLOCK_BYTES=262144,ROW_BYTES=8192,TRADE_ROW_BYTES=32768;
const FILE=/^(v2|v3|ai|trades|errors|paths|arms)-(\d{4}-\d{2}-\d{2}-\d{2})-(\d{5})\.jsonl\.gz$/;
const hourOf=at=>new Date(at).toISOString().slice(0,13).replace('T','-');
const hourAt=hour=>Date.parse(hour.slice(0,10)+'T'+hour.slice(11)+':00:00Z');
class Archive {
  constructor(dir,options={}) {
    this.dir=dir;fs.mkdirSync(dir,{recursive:true});
    if(minimal.researchEnabled()){
      const file=path.join(dir,'capture-ledger','totals.json'),legacy=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
      const c=()=>minimal.current(),status=()=>require('./researchRuntime').status();
      this.ledger={state:{...legacy,cursors:legacy.cursors||{},generation:legacy.generation||0},measurement(){},receiptPulse(){},error(){},recovered(){},beginCohort(){},save(){},records:()=>[],identity:()=>status().reconciliation,status:()=>({skipCounters:{},researchCapture:status()})};
      this.sessions=new Map();this.files=new Map();this.heads=new Map();this.definitions=new Set();this.leases=new Map();this.deltaContexts=new Map();this.skipped=0;this.pausedUntil=null;this.summaryHours={};this.maxBytes=Infinity;this.hourBytes=Infinity;return;
    }
    this.ledger=new CaptureLedger(dir);this.sessions=new Map();
    if(minimal.enabled())for(const method of ['measurement','receiptPulse','error','recovered','beginCohort'])this.ledger[method]=()=>{};
    const txn=path.join(dir,'archive-transaction.json');
    if(fs.existsSync(txn)){
      const pending=JSON.parse(fs.readFileSync(txn,'utf8'));
      for(const name of pending.names){const file=path.join(dir,name);if(fs.existsSync(file+'.tmp'))fs.renameSync(file+'.tmp',file);}
      this.ledger.state=pending.ledger;this.ledger.save();
      for(const [h,bucket] of pending.hours)atomic(path.join(this.ledger.dir,h+'.json'),bucket);
      fs.unlinkSync(txn);
    }
    this.pending=path.join(dir,'capture-pending.json');
    const redo=fs.existsSync(this.pending)?JSON.parse(fs.readFileSync(this.pending,'utf8')):null;
    if(redo&&this.ledger.state.generation===redo.before.generation){
      this.ledger.state=redo.before;this.ledger.save();for(const [h,b] of redo.hours)atomic(path.join(this.ledger.dir,h+'.json'),b);
    }
    if(!redo)this.ledger.reconcileInterrupted();
    this.maxBytes=options.maxBytes??MAX_BYTES;this.hourBytes=options.hourBytes??HOUR_BYTES;
    this.files=new Map();this.heads=new Map();this.definitions=new Set();this.leases=new Map();this.deltaContexts=new Map();
    this.skipped=0;this.pausedUntil=null;this.summaryHours={};
    for(const name of fs.readdirSync(dir)) {
      const m=FILE.exec(name);if(!m)continue;
      const item={path:path.join(dir,name),size:fs.statSync(path.join(dir,name)).size,channel:m[1],hour:m[2],sequence:Number(m[3])};
      this.files.set(name,item);const key=item.channel+':'+item.hour;
      if(!this.heads.has(key)||item.sequence>this.heads.get(key).sequence)this.heads.set(key,item);
    }
    // Crash-left export links are temporary snapshots, never research originals.
    for(const name of fs.readdirSync(dir))if(/^export-[a-f0-9]{24}-(\d+|[a-z]+-manifest)\.gz$/.test(name))fs.unlinkSync(path.join(dir,name));
    if(redo){if(this.ledger.state.generation===redo.before.generation)this.write(redo.entries,true);else fs.unlinkSync(this.pending);}
  }
  total(){return [...this.files.values()].reduce((n,f)=>n+f.size,0);}
  expireSessions(now){for(const [id,s] of this.sessions)if(s.expiresAt<now){for(const v of Object.values(s.channels))v.cleanup();for(const p of s.extraExports||[])if(fs.existsSync(p))fs.unlinkSync(p);this.sessions.delete(id);}}
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
  write(entries,replaying=false) {
    if(minimal.enabled()){for(const e of entries){const ok=minimal.observe(e.channel,e.row);if(ok===false&&minimal.researchEnabled()&&minimal.current().state.captureHalted)throw Error('RESEARCH_CAPTURE_HALTED');}return;}

    if(!entries.length)return;
    if(!replaying&&fs.existsSync(this.pending)){
      const p=JSON.parse(fs.readFileSync(this.pending,'utf8')),txn=path.join(this.dir,'archive-transaction.json');
      if(fs.existsSync(txn)){
        const prepared=JSON.parse(fs.readFileSync(txn,'utf8'));for(const name of prepared.names){const file=path.join(this.dir,name);if(fs.existsSync(file+'.tmp'))fs.renameSync(file+'.tmp',file);
          const m=FILE.exec(name),item={path:file,size:fs.statSync(file).size,channel:m[1],hour:m[2],sequence:Number(m[3])};this.files.set(name,item);this.heads.set(item.channel+':'+item.hour,item);}
        this.ledger.state=prepared.ledger;for(const [h,b] of prepared.hours){this.ledger.hours.set(h,b);atomic(path.join(this.ledger.dir,h+'.json'),b);}this.ledger.save();fs.unlinkSync(txn);
        this.deltaContexts.clear();this.definitions.clear();
      }
      if(this.ledger.state.generation>p.before.generation)fs.unlinkSync(this.pending);
      else {this.ledger.state=p.before;this.ledger.save();for(const [h,b] of p.hours){this.ledger.hours.set(h,b);atomic(path.join(this.ledger.dir,h+'.json'),b);}this.write(p.entries,true);}
    }
    const klass=priority(entries),before=JSON.parse(JSON.stringify(this.ledger.state));
    const hours=[...new Set(entries.map(e=>hourOf(e.row.capturedAt)))].map(h=>[h,JSON.parse(JSON.stringify(this.ledger.bucket(h)))]);
    atomic(this.pending,{entries,before,hours});
    this.ledger.detailedAccount(entries,'attempted',klass);
    try{return this.commit(entries,klass);}catch(e){
      // A prepared durable transaction is recoverable, not a skipped write.
      if(!fs.existsSync(path.join(this.dir,'archive-transaction.json'))&& !['ENOSPC','EIO','EACCES'].includes(e.code)){
        this.ledger.tombstone(entries,klass,e.reasonCode||e.code||e.message);this.ledger.detailedAccount(entries,'skipped',klass,e.reasonCode||e.code||e.message);
        this.skipped+=entries.length;fs.unlinkSync(this.pending);e.permanentLoss=true;
      }
      throw e;
    }
  }
  commit(entries,klass) {
    const now=Math.max(...entries.map(e=>e.row.capturedAt));this.prune(now);
    const groups=new Map(),newDefinitions=[],nextContexts=new Map();
    for(const {channel,row} of entries) {
      if(!CHANNELS.includes(channel))throw Error('INVALID_ARCHIVE_CHANNEL');
      const hour=hourOf(row.capturedAt),key=channel+':'+hour;
      const deltaKey=['v3','v2','trades','arms'].includes(channel)&&(row.symbol||row.tradeId)?key+':'+(row.symbol||row.tradeId)+':'+(row.side||''):null;
      const context=deltaKey?{previous:nextContexts.get(deltaKey)||this.deltaContexts.get(deltaKey)}:null;
      const c=compact(row,context),lines=groups.get(key)||[];
      if(context)nextContexts.set(deltaKey,context.next);
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
        const name=`${channel}-${hour}-${String(sequence).padStart(5,'0')}.jsonl.gz`,bytes=zlib.gzipSync(raw,{level:9});
        const item={path:path.join(this.dir,name),size:bytes.length,channel,hour,sequence};
        changes.push({name,item,bytes,growth:bytes.length-oldSize});const growth=bytes.length-oldSize;
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
    // Every listed channel is required for population research. Soft budgets are
    // alarms, never a reason to throw away a durable attempted observation.
    if(blocked||this.total()+delta>this.maxBytes) {
      this.ledger.state.envelopeExceedances=(this.ledger.state.envelopeExceedances||0)+1;
      this.ledger.state.lastEnvelopeExceedance={at:now,scope:blocked?'UTC_HOUR':'ROLLING',projectedBytes:this.total()+delta,policy:POLICY};
    }
    // Durable redo intent: restart completes every staged channel before reads.
    for(const c of changes){const fd=fs.openSync(c.item.path+'.tmp','w');try{fs.writeFileSync(fd,c.bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
    const txn=path.join(this.dir,'archive-transaction.json'),ledger=JSON.parse(JSON.stringify(this.ledger.state));
    // Only touched buckets belong to this redo transaction. Rewriting every
    // historical ledger on each row caused unnecessary synchronous disk work.
    const hours=new Map([...new Set(entries.map(e=>hourOf(e.row.capturedAt)))].map(h=>[h,JSON.parse(JSON.stringify(this.ledger.bucket(h)))]));
    const allocations=new Map();
    for(const [i,{channel,row}] of entries.entries()){
      const h=hourOf(row.capturedAt),key=this.ledger.key(channel,row,klass),bytes=Buffer.byteLength(JSON.stringify(row)+'\n');
      const peers=entries.filter(e=>e.channel===channel&&hourOf(e.row.capturedAt)===h),weight=bytes/peers.reduce((n,e)=>n+Buffer.byteLength(JSON.stringify(e.row)+'\n'),0);
      const physical=changes.filter(c=>c.item.channel===channel&&c.item.hour===h),allocationKey=channel+':'+h,used=allocations.get(allocationKey)||{written:0,growth:0};
      const last=!entries.slice(i+1).some(e=>e.channel===channel&&hourOf(e.row.capturedAt)===h),writtenTotal=physical.reduce((n,c)=>n+c.bytes.length,0),growthTotal=physical.reduce((n,c)=>n+c.growth,0);
      const written=last?writtenTotal-used.written:Math.floor(weight*writtenTotal),growth=last?growthTotal-used.growth:Math.floor(weight*growthTotal);
      allocations.set(allocationKey,{written:used.written+written,growth:used.growth+growth});
      for(const b of [ledger.totals[key],hours.get(h)[key]]){b.acceptedRows++;b.acceptedBytes+=bytes;b.firstAcceptedAt??=row.capturedAt;b.lastAcceptedAt=row.capturedAt;
        b.physicalCompressedBytesWritten+=written;b.physicalCompressedGrowthBytes+=growth;b.physicalByteAttribution='INTEGER_LOGICAL_BYTE_WEIGHT_LAST_ROW_REMAINDER';}
      ledger.cursors[channel]=(ledger.cursors[channel]||0)+1;
    }
    ledger.generation++;
    atomic(txn,{names:changes.map(c=>c.name),ledger,hours:[...hours]});
    for(const c of changes) {
      fs.renameSync(c.item.path+'.tmp',c.item.path);
      this.files.set(c.name,c.item);this.heads.set(c.item.channel+':'+c.item.hour,c.item);
    }
    this.ledger.state=ledger;
    for(const [h,b] of hours){this.ledger.hours.set(h,b);atomic(path.join(this.ledger.dir,h+'.json'),b);}
    this.ledger.save();fs.unlinkSync(txn);fs.unlinkSync(this.pending);
    for(const [key,value] of nextContexts)this.deltaContexts.set(key,value);
    for(const key of this.deltaContexts.keys())if(!key.includes(':'+hourOf(now)+':'))this.deltaContexts.delete(key);
    while(this.deltaContexts.size>512)this.deltaContexts.delete(this.deltaContexts.keys().next().value);
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
        files.push({path:target,size:f.size,sourceItem:f});
      }
      if(!files.length){const target=path.join(this.dir,`export-${token}-0.gz`),bytes=zlib.gzipSync('');
        fs.writeFileSync(target,bytes);links.push(target);files.push({path:target,size:bytes.length});}
    }catch(e){for(const p of links)fs.unlinkSync(p);for(const p of originals)this.release(p);throw e;}
    return {files,cleanup:()=>{for(const p of links)if(fs.existsSync(p))fs.unlinkSync(p);for(const p of originals)this.release(p);}};
  }
  release(p){const n=(this.leases.get(p)||1)-1;if(n)this.leases.set(p,n);else this.leases.delete(p);}
  status(){if(minimal.researchEnabled()){const s=minimal.current().status();return {...s,captureSchema:s.schemaVersion,capturePolicy:s.schemaVersion,sizeBytes:s.retainedBytes,maxBytes:null,minimumRetentionDays:7,hourBudgetBytes:null,budgetSkippedRecords:0,skipCounters:{},telemetry:this.ledger.status()};}if(minimal.enabled())return {...minimal.current().status(),captureSchema:minimal.SCHEMA,capturePolicy:minimal.SCHEMA,sizeBytes:minimal.current().state.retainedBytes,maxBytes:minimal.LIMITS.totalBytes,hourBudgetBytes:0,telemetry:this.ledger.status(),budgetSkippedRecords:0,skipCounters:this.ledger.status().skipCounters,reconciliation:this.ledger.identity(0),minimumRetentionHours:0};return {captureSchema:SCHEMA,capturePolicy:POLICY,budgetEnforcement:'ALERT_ONLY_REQUIRED_CHANNELS_NEVER_DROPPED',sizeBytes:this.total(),maxBytes:this.maxBytes,hourBudgetBytes:this.hourBytes,
    priorityReserveFraction:0,priorityReserveScope:'SHARED_REQUIRED_CHANNELS_NO_REJECTION',priorityOverflowBytes:Math.max(0,this.total()-this.maxBytes),
    retentionHeadroomBytes:Math.max(0,this.maxBytes-this.total()),telemetry:this.ledger.status(),
    minimumRetentionHours:30,maximumBlockRawBytes:BLOCK_BYTES,maximumRowRawBytes:TRADE_ROW_BYTES,maximumCandidateRawBytes:ROW_BYTES,
    budgetSkippedRecords:this.skipped,skipCounters:this.ledger.status().skipCounters,reconciliation:this.ledger.identity(this.skipped),capturePausedUntil:this.pausedUntil,
    earliestHour:[...this.files.values()].map(f=>f.hour).sort()[0]||null};}
  checkpoint(){return {definitions:[...this.definitions].slice(-512),summaryHours:this.summaryHours,skipped:this.skipped,pausedUntil:this.pausedUntil};}
  restore(saved){if(!saved)return;this.definitions=new Set((saved.definitions||[]).slice(-16384));this.ledger.identity(saved.skipped||0);
    this.summaryHours=saved.summaryHours||{};this.skipped=saved.skipped||0;this.pausedUntil=saved.pausedUntil||null;}
  cohort(now=Date.now()) {
    if(this.snapshotBuilding)return this.snapshotBuilding;
    this.snapshotBuilding=this.buildCohort(now).finally(()=>{this.snapshotBuilding=null;});return this.snapshotBuilding;
  }
  async buildCohort(now) {
    const enumerationStartedAt=Date.now();
    this.expireSessions(now);
    while(this.sessions.size>=3){const id=this.sessions.keys().next().value,s=this.sessions.get(id);for(const v of Object.values(s.channels))v.cleanup();for(const p of s.extraExports||[])if(fs.existsSync(p))fs.unlinkSync(p);this.sessions.delete(id);}
    const generation=crypto.randomBytes(12).toString('hex'),channels={};
    for(const channel of CHANNELS)channels[channel]=this.snapshot(channel);
    // Freeze audit metadata before yielding: later writes belong to a later watermark.
    const captureLedger=this.ledger.records(),reconciliation=this.ledger.identity(this.skipped),sequence=this.ledger.state.generation,
      cursors={...this.ledger.state.cursors},tombstones=fs.readdirSync(this.ledger.tombstones).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(path.join(this.ledger.tombstones,n),'utf8')));
    const retained={};
    try {
    for(const [channel,snapshot] of Object.entries(channels)){
      const stats=retained[channel]={physicalRows:0,logicalRows:0,definitionRows:0,byRecordType:{},compressedBytes:0};
      for(const f of snapshot.files){stats.compressedBytes+=f.size;
        let counted=f.sourceItem?.retainedStats;
        if(!counted){counted={physicalRows:0,logicalRows:0,definitionRows:0,byRecordType:{}};
          const lines=zlib.gunzipSync(fs.readFileSync(f.path),{maxOutputLength:BLOCK_BYTES}).toString('utf8').split('\n');
          for(const line of lines)if(line){const row=JSON.parse(line),type=row.outputType||'UNKNOWN';counted.physicalRows++;
            counted.byRecordType[type]=(counted.byRecordType[type]||0)+1;
            if(type==='V3_IMMUTABLE_PAYLOAD'||type.endsWith('_DEFINITION'))counted.definitionRows++;else counted.logicalRows++;
          }
          // Immutable file objects retain counts; replacing a mutable head creates
          // a new object, so neither same-size rewrites nor concurrent appends reuse stale counts.
          if(f.sourceItem)f.sourceItem.retainedStats=counted;
        }
        for(const k of ['physicalRows','logicalRows','definitionRows'])stats[k]+=counted[k];
        for(const [k,n] of Object.entries(counted.byRecordType))stats.byRecordType[k]=(stats.byRecordType[k]||0)+n;
        // Counting legacy retained blocks must never stop decision/path capture for minutes.
        await new Promise(resolve=>setImmediate(resolve));
      }
    }
    }catch(e){for(const v of Object.values(channels))v.cleanup();throw e;}
    const result={generation,sequence,watermarkAt:now,captureLedger,tombstones,reconciliation,ledgerChecksum:digest(captureLedger),
      cursors,retained,enumerationDurationMs:Date.now()-enumerationStartedAt,expiresAt:now+(Date.now()-enumerationStartedAt)+10*60000,channels};
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
        metadata:this.snapshotMetadata?.()||null,captureLedger:this.ledger.records().filter(r=>r.hour.startsWith(day)),reconciliation:this.ledger.identity(this.skipped),
        sequence:this.ledger.state.generation,cursors:{...this.ledger.state.cursors},files:items,
        partialFirstDay:this.ledger.state.startedAt>=Date.parse(day+'T00:00:00Z')});
    }
  }
  dailyList(){if(minimal.researchEnabled())return minimal.current().state.archives.filter(a=>!a.expired&&a.published).map(a=>({...a,files:[a.filename]}));const root=path.join(this.dir,'daily-snapshots');if(!fs.existsSync(root))return [];
    return fs.readdirSync(root).filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d)&&fs.existsSync(path.join(root,d,'manifest.json'))).map(day=>JSON.parse(fs.readFileSync(path.join(root,day,'manifest.json'),'utf8')));}
}
module.exports={Archive,HOUR_BYTES,MAX_BYTES,MIN_RETAIN,BLOCK_BYTES,ROW_BYTES,TRADE_ROW_BYTES,FILE};
