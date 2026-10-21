'use strict';
// Production authority over the authenticated V3 shards. One bounded shared
// overlay, one transaction at a time, and CURRENT published before WAL removal.
const fs = require('fs'), path = require('path');
const C = require('./codec'), S = require('./shard'), IO = require('./io');
const {atomic, sha} = require('../researchStore');
const FAMILY = Object.freeze({events:'E', dedupe:'D', episodes:'P', sourceEpisodes:'S',
  episodeMetadata:'S', nativeEpisodeIndex:'N', aiAttempts:'A', evaluations:'A',
  openEpisodes:'O', openAttempts:'O', definitions:'X', extremes:'X', openedEpochs:'X',
  providerState:'A',providerDays:'A',providerRequestIds:'A',providerTerminalIds:'A',providerCandidates:'A',providerStartedCandidates:'A',providerOpenRequests:'O',archives:'C', segments:'C', garbageSegments:'C', members:'V', work:'V'});
const OVERLAY_CAP = 2 * 1024 * 1024, TX_CAP = 2 * 1024 * 1024;
function decode(k) { let at=4; const out=[]; for(let i=0;i<k[3];i++) {const n=k.readUInt32LE(at); at+=4; out.push(k.subarray(at,at+n).toString('utf16le')); at+=n;} return out; }
function* jsonLines(file, max=TX_CAP*2) {
  const fd=fs.openSync(file,'r'), b=Buffer.alloc(65536); let tail='', n;
  const decoder=new (require('string_decoder').StringDecoder)('utf8');
  try { while((n=fs.readSync(fd,b,0,b.length,null))) {
    tail+=decoder.write(b.subarray(0,n)); let at;
    while((at=tail.indexOf('\n'))>=0) {const line=tail.slice(0,at);tail=tail.slice(at+1); if(Buffer.byteLength(line)>max) throw Error('JOURNAL_RECORD_CAP'); if(line)yield JSON.parse(line);}
    if(Buffer.byteLength(tail)>max)throw Error('JOURNAL_RECORD_CAP');
  } tail+=decoder.end(); if(tail.trim())yield {incomplete:true};
  } finally {fs.closeSync(fd);}
}
class Index {
  constructor(dir,{create=false}={}) {
    this.dir=dir;fs.mkdirSync(dir,{recursive:true});
    this.file=path.join(dir,'CURRENT');this.wal=path.join(dir,'transactions.jsonl');
    this.handles=new IO.Handles(16);this.cache=new IO.Cache(4*1024*1024);
    this.overlay=new Map();this.overlayBytes=0;this.highWater=0;
    this.pointReads=Object.create(null);this.cursorReads=Object.create(null);
    if(fs.existsSync(this.file)) {
      if(fs.statSync(this.file).size>4*1024*1024)throw Error('CURRENT_CAP');
      const {body,sha256}=JSON.parse(fs.readFileSync(this.file,'utf8'));
      if(sha(JSON.stringify(body))!==sha256||body.format!=='ORAYAN_PRODUCTION_V3_1')throw Error('CURRENT_INTEGRITY');
      this.root=body;
    } else {if(!create)throw Error('V3_NAMESPACE_NOT_CREATED');this.root={format:'ORAYAN_PRODUCTION_V3_1',lsn:0,directory:S.directory(),state:{}};this.publish();}
    // No completed-history reads at startup. Only the byte-capped uncheckpointed tail.
    if(fs.existsSync(this.wal)) {
      if(fs.statSync(this.wal).size>8*1024*1024)throw Error('V3_WAL_CAP');
      for(const line of jsonLines(this.wal)) {
        if(line.incomplete)break;
        if(sha(line.data)!==line.sha256)throw Error('V3_WAL_CHECKSUM');
        const tx=JSON.parse(line.data); if(tx.lsn<=this.root.lsn)continue;
        if(tx.lsn!==this.root.lsn+1)throw Error('V3_LSN_GAP');
        this.install(tx);
      }
      // Remove an incomplete tail only after publishing all complete transactions.
      this.flush();
    }
  }
  key(table,id) {if(!Object.hasOwn(FAMILY,table))throw Error('UNKNOWN_V3_TABLE:'+table);return C.key(FAMILY[table],'record',[table,String(id)]);}
  reader(f,b,d=this.root.directory[f][b]) {return new S.Reader(this.dir,d,{handles:this.handles,cache:this.cache});}
  raw(k) {const id=k.toString('hex'), hot=this.overlay.get(id);if(hot)return hot.flags===1?null:hot;
    const digest=C.sha(k); return this.reader(String.fromCharCode(k[1]),digest[0]).get(k);}
  get(table,id) {this.pointReads[table]=(this.pointReads[table]||0)+1;const r=this.raw(this.key(table,id));return r?JSON.parse(r.value.toString()):undefined;}
  *entries(table) {
    // Fixed bucket directory, bounded shared overlay, one cold record per cursor.
    const f=FAMILY[table]; if(!f)throw Error('UNKNOWN_V3_TABLE');
    if((this.cursors||0)>=8)throw Error('V3_CURSOR_CAP');
    this.cursors=(this.cursors||0)+1;
    const descriptors=this.root.directory[f].slice(), snapshot=new Map(this.overlay);
    try {
    for(let b=0;b<256;b++) {
      for(const r of this.reader(f,b,descriptors[b]).records()) {
        const [t,id]=decode(r.key);if(t!==table||snapshot.has(r.key.toString('hex'))||r.flags===1)continue;
        this.cursorReads[table]=(this.cursorReads[table]||0)+1;yield [id,JSON.parse(r.value.toString())];
      }
      for(const r of snapshot.values()) {if(r.digest[0]!==b||r.flags===1)continue;const [t,id]=decode(r.key);if(t===table){this.cursorReads[table]=(this.cursorReads[table]||0)+1;yield [id,JSON.parse(r.value.toString())];}}
    }
    } finally {this.cursors--;}
  }
  cost(op) {return (Buffer.byteLength(JSON.stringify(op))+256)*4;}
  commit(ops,state) {
    if(this.failed)throw Error('V3_WRITE_AUTHORITY_FENCED');
    for(const [t,id,v,deleted]of ops)C.record(this.key(t,id),Buffer.from(deleted?'null':JSON.stringify(v)),this.root.lsn+1,deleted?1:0);
    const size=ops.reduce((n,o)=>n+this.cost(o),0);
    if(size>TX_CAP)throw Error('V3_TRANSACTION_CAP');
    if(this.overlayBytes+size>OVERLAY_CAP|| (fs.existsSync(this.wal)&&fs.statSync(this.wal).size>4*1024*1024))this.flush();
    const tx={lsn:this.root.lsn+1,ops,state};const data=JSON.stringify(tx);
    if(Buffer.byteLength(data)>TX_CAP)throw Error('V3_TRANSACTION_CAP');
    try {
      const fd=fs.openSync(this.wal,'a',0o600);try {IO.write(fd,Buffer.from(JSON.stringify({data,sha256:sha(data)})+'\n'));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      if(process.platform!=='win32')IO.syncDir(this.dir);
      this.install(tx);return tx.lsn;
    }catch(e){this.failed=true;throw e;}
  }
  install(tx) {
    for(const [table,id,value,deleted]of tx.ops) {
      const k=this.key(table,id),r=C.record(k,Buffer.from(deleted?'null':JSON.stringify(value)),tx.lsn,deleted?1:0),key=k.toString('hex');
      const old=this.overlay.get(key);if(old)this.overlayBytes-=old.cost;
      r.cost=(k.length+r.value.length+256)*4;this.overlay.set(key,r);this.overlayBytes+=r.cost;
    }
    // WAL replay is bounded by the same admission budget; corruption never grows RAM.
    if(this.overlayBytes>OVERLAY_CAP+TX_CAP)throw Error('V3_OVERLAY_CAP');
    this.highWater=Math.max(this.highWater,this.overlayBytes);this.root.lsn=tx.lsn;this.root.state=tx.state;
  }
  publish() {const body=this.root;atomic(this.file,{body,sha256:sha(JSON.stringify(body))});}
  flush() {
    // Only the bounded overlay is sorted. Cold shards are merged one record at a time.
    const previous=this.root.directory, directory=Object.fromEntries(C.FAMILIES.map(f=>[f,previous[f].slice()]));
    const dirty=new Map();for(const r of this.overlay.values()){const id=String.fromCharCode(r.key[1])+':'+r.digest[0];if(!dirty.has(id))dirty.set(id,[]);dirty.get(id).push(r);}
    for(const [id,rows]of dirty) {
      const [f,bucket]=id.split(':'),b=Number(bucket),overlay=new S.Overlay();for(const r of rows)overlay.set(r);
      directory[f][b]=S.fold(this.dir,previous[f][b],overlay,{dropTombstones:true}).descriptor;
    }
    this.root.directory=directory;this.publish();this.overlay.clear();this.overlayBytes=0;
    this.handles.close();this.cache.clear();
    const fd=fs.openSync(this.wal,'w',0o600);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    this.collectFiles();
  }
  collectFiles() {
    if(this.cursors)return;
    // 10*256*4 fixed maximum references, independent of historical row count.
    const live=new Set();for(const f of C.FAMILIES)for(const d of this.root.directory[f])if(!d.empty)for(const role of ['slots','values']){live.add(d[role].sha256+'.'+role);live.add(d[role].treeSha256+'.mtree');}
    const d=fs.opendirSync(this.dir);try{let e;while((e=d.readSync()))if(e.isFile()&&(/^[a-f0-9]{64}\.(slots|values|mtree)$/.test(e.name)||/\.building\./.test(e.name))&&!live.has(e.name))fs.unlinkSync(path.join(this.dir,e.name));}finally{d.closeSync();}
  }
  metrics() {return {descriptors:{count:2560,cap:2560},overlay:{count:this.overlay.size,bytes:this.overlayBytes,capBytes:OVERLAY_CAP+TX_CAP,highWaterBytes:this.highWater},pageCache:{count:this.cache.map.size,bytes:this.cache.bytes,capBytes:this.cache.limit},handles:{count:this.handles.map.size,cap:this.handles.limit},cursors:{count:this.cursors||0,cap:8,snapshotCapBytes:8*(OVERLAY_CAP+TX_CAP)},cursorRecords:{count:this.cursors||0,cap:8},scalarDescriptor:{capBytes:128*1024},reducerWork:{capEntries:128,capEncodedBytes:TX_CAP},providerRecent:{capEntries:1024},historyDictionaries:{count:0,cap:0},pointReadsByTable:{...this.pointReads},cursorReadsByTable:{...this.cursorReads}};}
  close(){this.flush();this.handles.close();this.cache.clear();}
}
module.exports={Index,FAMILY,decode,jsonLines};
