'use strict';
const fs=require('fs'),path=require('path'),zlib=require('zlib'),crypto=require('crypto');
const {compact,SCHEMA}=require('./v3Compact');
const HOUR=3600000,MIN_RETAIN=30*HOUR,MAX_BYTES=24*1048576,HOUR_BYTES=768*1024;
const BLOCK_BYTES=65536,ROW_BYTES=8192,TRADE_ROW_BYTES=32768;
const FILE=/^(v2|v3|ai|trades)-(\d{4}-\d{2}-\d{2}-\d{2})-(\d{5})\.jsonl\.gz$/;
const hourOf=at=>new Date(at).toISOString().slice(0,13).replace('T','-');
const hourAt=hour=>Date.parse(hour.slice(0,10)+'T'+hour.slice(11)+':00:00Z');
class Archive {
  constructor(dir,options={}) {
    this.dir=dir;fs.mkdirSync(dir,{recursive:true});
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
    for(const name of fs.readdirSync(dir))if(/^export-[a-f0-9]{24}-\d+\.gz$/.test(name))fs.unlinkSync(path.join(dir,name));
  }
  total(){return [...this.files.values()].reduce((n,f)=>n+f.size,0);}
  prune(now) {
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
    const now=Math.max(...entries.map(e=>e.row.capturedAt));this.prune(now);
    const groups=new Map(),newDefinitions=[];
    for(const {channel,row} of entries) {
      if(!['v2','v3','ai','trades'].includes(channel))throw Error('INVALID_ARCHIVE_CHANNEL');
      const hour=hourOf(row.capturedAt),key=channel+':'+hour;
      const c=compact(row),lines=groups.get(key)||[];
      for(const d of c.definitions) {
        const definitionKey=key+':'+d.definitionId;
        if(this.definitions.has(definitionKey)||newDefinitions.includes(definitionKey))continue;
        lines.push(JSON.stringify({captureSchema:SCHEMA,outputType:'V3_LEVEL_DEFINITION',capturedAt:row.capturedAt,...d})+'\n');
        newDefinitions.push(definitionKey);
      }
      const line=JSON.stringify(c.row)+'\n';
      if(Buffer.byteLength(line)>(channel==='trades'?TRADE_ROW_BYTES:ROW_BYTES))throw Error('COMPACT_ROW_TOO_LARGE');
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
    if(blocked||this.total()+delta>this.maxBytes) {
      this.skipped+=entries.length;this.pausedUntil=hourAt(hourOf(now))+HOUR;
      throw Object.assign(Error('V3_ARCHIVE_BUDGET_PAUSED'),{reasonCode:'V3_ARCHIVE_BUDGET_PAUSED'});
    }
    for(const c of changes) {
      const tmp=c.item.path+'.tmp';fs.writeFileSync(tmp,c.bytes);fs.renameSync(tmp,c.item.path);
      this.files.set(c.name,c.item);this.heads.set(c.item.channel+':'+c.item.hour,c.item);
    }
    for(const key of newDefinitions)this.definitions.add(key);
    while(this.definitions.size>2048)this.definitions.delete(this.definitions.values().next().value);
    if(this.pausedUntil && now>=this.pausedUntil)this.pausedUntil=null;
    for(const {channel,row} of entries) {
      const h=hourOf(row.capturedAt),stats=this.summaryHours[h]||(this.summaryHours[h]={v3:0,v2:0,ai:0,trades:0,accepted:0,rejected:0});
      stats[channel]++;if(channel==='v3')stats[row.v3Decision==='ACCEPT_SHADOW'?'accepted':'rejected']++;
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
    minimumRetentionHours:30,maximumBlockRawBytes:BLOCK_BYTES,maximumRowRawBytes:TRADE_ROW_BYTES,maximumCandidateRawBytes:ROW_BYTES,
    budgetSkippedRecords:this.skipped,capturePausedUntil:this.pausedUntil,
    earliestHour:[...this.files.values()].map(f=>f.hour).sort()[0]||null};}
  checkpoint(){return {definitions:[...this.definitions],summaryHours:this.summaryHours,skipped:this.skipped,pausedUntil:this.pausedUntil};}
  restore(saved){if(!saved)return;this.definitions=new Set((saved.definitions||[]).slice(-2048));
    this.summaryHours=saved.summaryHours||{};this.skipped=saved.skipped||0;this.pausedUntil=saved.pausedUntil||null;}
}
module.exports={Archive,HOUR_BYTES,MAX_BYTES,MIN_RETAIN,BLOCK_BYTES,ROW_BYTES,TRADE_ROW_BYTES,FILE};
