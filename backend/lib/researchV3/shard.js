'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const C=require('./codec'),IO=require('./io'),P=require('./pages');
const SLOT=80,FORMAT='RS_SORTED_SHARDS_1';
function emptyDescriptor(family,bucket){if(!C.FAMILIES.includes(family))C.fail('family');C.integer(bucket,255);return {format:FORMAT,codec:1,family,bucket,count:0,live:0,tombstones:0,maxLSN:0,empty:true};}
function directory(){return Object.fromEntries(C.FAMILIES.map(f=>[f,Array.from({length:256},(_,b)=>emptyDescriptor(f,b))]));}
function slot(r,offset){const b=Buffer.alloc(SLOT);r.digest.copy(b);C.u64(offset).copy(b,32);C.u64(r.key.length).copy(b,40);C.u64(offset+r.key.length).copy(b,48);C.u64(r.value.length).copy(b,56);C.u64(r.lsn).copy(b,64);b.writeUInt32LE(r.flags,72);return b;}
class Writer {
  constructor(dir,family,bucket,{testDigest=null}={}){
    emptyDescriptor(family,bucket);this.dir=dir;this.family=family;this.bucket=bucket;this.testDigest=testDigest;this.count=0;this.live=0;this.maxLSN=0;this.offset=0;this.previous=null;
    this.prefix=crypto.randomUUID()+'.building';this.slotPath=path.join(dir,this.prefix+'.slots');this.valuePath=path.join(dir,this.prefix+'.values');
    this.sfd=fs.openSync(this.slotPath,'wx',0o600);try{this.vfd=fs.openSync(this.valuePath,'wx',0o600);}catch(e){fs.closeSync(this.sfd);throw e;}
    this.sb=Buffer.alloc(P.PAGE);this.vb=Buffer.alloc(P.PAGE);this.sn=0;this.vn=0;this.sh=crypto.createHash('sha256');this.vh=crypto.createHash('sha256');
  }
  appendBytes(which,bytes){let at=0;const b=which==='s'?this.sb:this.vb;let n=which==='s'?this.sn:this.vn;const fd=which==='s'?this.sfd:this.vfd,h=which==='s'?this.sh:this.vh;
    h.update(bytes);while(at<bytes.length){const size=Math.min(b.length-n,bytes.length-at);bytes.copy(b,n,at,at+size);at+=size;n+=size;if(n===b.length){IO.write(fd,b);n=0;}}if(which==='s')this.sn=n;else this.vn=n;
  }
  add(r){
    C.record(r.key,r.value,r.lsn,r.flags,r.digest);C.validateKey(r.key,this.family);const digest=this.testDigest?this.testDigest(r.key):C.sha(r.key);
    if(!digest.equals(r.digest)||r.digest[0]!==this.bucket||this.previous&&C.compare(this.previous,r)>=0)C.fail('shard input order/identity');
    this.appendBytes('s',slot(r,this.offset));this.appendBytes('v',r.key);this.appendBytes('v',r.value);this.offset=C.integer(this.offset+r.key.length+r.value.length);
    this.count++;if(r.flags!==1)this.live++;this.maxLSN=Math.max(this.maxLSN,r.lsn);this.previous={digest:Buffer.from(r.digest),key:Buffer.from(r.key)};
  }
  finish(){
    try{if(this.sn)IO.write(this.sfd,this.sb.subarray(0,this.sn));if(this.vn)IO.write(this.vfd,this.vb.subarray(0,this.vn));fs.fsyncSync(this.sfd);fs.fsyncSync(this.vfd);}finally{fs.closeSync(this.sfd);fs.closeSync(this.vfd);this.sfd=this.vfd=null;}
    const sh=this.sh.digest('hex'),vh=this.vh.digest('hex');
    if(!this.count)return emptyDescriptor(this.family,this.bucket);
    const slots=this.finishFile(this.slotPath,sh,'slots'),values=this.finishFile(this.valuePath,vh,'values');
    const d={format:FORMAT,codec:1,family:this.family,bucket:this.bucket,count:this.count,live:this.live,tombstones:this.count-this.live,maxLSN:this.maxLSN,slots,values};
    if(Buffer.byteLength(JSON.stringify(d))>1024)C.fail('descriptor exceeds 1 KiB');return d;
  }
  finishFile(source,hash,role){
    const tree=source+'.mtree',d=P.buildTree(source,tree,role);
    if(d.sha256!==hash)C.fail('publication data hash');
    const file=hash+'.'+role,treeName=d.treeSha256+'.mtree';
    // Exclusive links publish immutable bytes. Existing content is verified, never overwritten.
    for(const [src,name,h]of [[source,file,hash],[tree,treeName,d.treeSha256]]){
      try{if(process.platform==='win32')fs.copyFileSync(src,path.join(this.dir,name),fs.constants.COPYFILE_EXCL);else fs.linkSync(src,path.join(this.dir,name));}catch(e){if(e.code!=='EEXIST')throw e;if(IO.hashFile(IO.safeFile(this.dir,name))!==h)C.fail('immutable name collision');}
    }
    if(process.platform!=='win32')IO.syncDir(this.dir);
    return d;
  }
  abort(){for(const name of ['sfd','vfd'])if(this[name]!==null&&this[name]!==undefined){fs.closeSync(this[name]);this[name]=null;}}
}
class Reader {
  constructor(dir,d,{handles=new IO.Handles(),cache=new IO.Cache(),testDigest=null}={}){
    this.d=structuredClone(d);this.handles=handles;this.cache=cache;this.testDigest=testDigest;this.stats={readBytes:0,proofBytes:0};
    if(!d||d.format!==FORMAT||d.codec!==1||!C.FAMILIES.includes(d.family))C.fail('shard format');C.integer(d.bucket,255);C.integer(d.count);C.integer(d.maxLSN);
    if(Buffer.byteLength(JSON.stringify(d))>1024||!Number.isSafeInteger(d.live)||!Number.isSafeInteger(d.tombstones)||d.live<0||d.tombstones<0||d.live+d.tombstones!==d.count)C.fail('shard counts');
    if(d.empty){if(JSON.stringify(d)!==JSON.stringify(emptyDescriptor(d.family,d.bucket)))C.fail('empty shard identity');return;}
    if(d.count===0||d.slots.bytes!==d.count*SLOT)C.fail('slot count');
    this.slots=new P.Pages(dir,d.slots,'slots',handles,cache,this.stats);this.values=new P.Pages(dir,d.values,'values',handles,cache,this.stats);
  }
  at(n,includeValue=true){C.integer(n);if(n>=this.d.count)C.fail('slot bounds');
    const b=this.slots.range(n*SLOT,SLOT,SLOT),ko=C.from64(b,32),kl=C.from64(b,40),vo=C.from64(b,48),vl=C.from64(b,56),lsn=C.from64(b,64),flags=b.readUInt32LE(72);
    if(b.readUInt32LE(76)!==0||vo!==ko+kl||lsn>this.d.maxLSN||![0,1,2].includes(flags))C.fail('slot fields');
    const key=this.values.range(ko,kl,C.MAX_KEY);C.validateKey(key,this.d.family);const digest=b.subarray(0,32),expected=this.testDigest?this.testDigest(key):C.sha(key);
    if(!digest.equals(expected)||digest[0]!==this.d.bucket)C.fail('slot key digest');
    if(vo+vl>this.d.values.bytes||vl>C.MAX_VALUE)C.fail('value range');
    return {key,digest,value:includeValue?this.values.range(vo,vl,C.MAX_VALUE):null,lsn,flags};
  }
  get(key){C.validateKey(key,this.d.family);const digest=this.testDigest?this.testDigest(key):C.sha(key);if(digest[0]!==this.d.bucket)C.fail('wrong shard');let lo=0,hi=this.d.count;
    while(lo<hi){const mid=lo+Math.floor((hi-lo)/2),r=this.at(mid,false),cmp=C.compare(r,{key,digest});if(cmp<0)lo=mid+1;else hi=mid;}
    if(lo===this.d.count)return null;const r=this.at(lo,false);if(C.compare(r,{key,digest}))return null;
    if(r.flags===1)return null;return this.at(lo,true);
  }
  *records(){for(let n=0;n<this.d.count;n++)yield this.at(n,true);}
  close(){this.handles.close();this.cache.clear();}
}
// Single-shard bounded overlay; global coordinator must share one budget across all families.
class Overlay {
  constructor(){this.map=new Map();this.encoded=0;this.accounted=0;}
  set(r){C.record(r.key,r.value,r.lsn,r.flags,r.digest);const id=r.key.toString('hex'),prev=this.map.get(id),encoded=r.key.length+r.value.length+80,cost=encoded*3+id.length*2+512;
    const e=this.encoded-(prev?.encoded||0)+encoded,a=this.accounted-(prev?.cost||0)+cost;
    if(e>8*1024*1024||a>16*1024*1024){const err=Error('fold required before admission');err.code='OVERLAY_CAPACITY';throw err;}
    this.map.set(id,{r:{...r,key:Buffer.from(r.key),digest:Buffer.from(r.digest),value:Buffer.from(r.value)},encoded,cost});this.encoded=e;this.accounted=a;
  }
  sorted(){return Array.from(this.map.values(),v=>v.r).sort(C.compare);}
}
function fold(dir,d,overlay,options={}){
  const reader=new Reader(dir,d,options),writer=new Writer(dir,d.family,d.bucket,options),updates=overlay.sorted(),it=reader.records();let old=it.next(),i=0;
  try{while(!old.done||i<updates.length){const u=updates[i];if(old.done){writer.add(u);i++;continue;}if(!u){writer.add(old.value);old=it.next();continue;}
    const cmp=C.compare(old.value,u);if(cmp<0){writer.add(old.value);old=it.next();}else if(cmp>0){writer.add(u);i++;}else{if(u.lsn<old.value.lsn)C.fail('LSN regression');if(u.lsn===old.value.lsn&&(u.flags!==old.value.flags||!u.value.equals(old.value.value)))C.fail('conflicting LSN');writer.add(u);i++;old=it.next();}}
    return {descriptor:writer.finish(),readBytes:reader.stats.readBytes,proofBytes:reader.stats.proofBytes};
  }catch(e){writer.abort();throw e;}finally{reader.close();}
}
module.exports={SLOT,FORMAT,emptyDescriptor,directory,slot,Writer,Reader,Overlay,fold};
