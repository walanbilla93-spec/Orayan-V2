'use strict';
// Isolated primitive only. No service caller imports this module.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const C=require('./codec'),P=require('./pages'),S=require('./shard');
const immediate=()=>new Promise(resolve=>setImmediate(resolve));
function fault(code,message=code){const e=Error(message);e.code=code;throw e;}
class Scheduler {
  constructor({native=()=>({ready:false,running:false,due:Infinity}),quantum=65536,onPhase=()=>{},clock=()=>performance.now(),enforceSliceLimit=true}={}){
    C.integer(quantum,65536);if(!quantum)C.fail('zero quantum');
    Object.assign(this,{native,quantum,onPhase,clock,enforceSliceLimit,phase:'IDLE',epoch:1,queued:false,ioActive:false,fenced:null});
    this.lastProgress=clock();this.metrics={sliceMaxMs:0,sliceOverTargetCount:0,sliceViolationCount:0,yieldCount:0,progress:0,ioCount:0,ioMax:0,guardWaits:0};
  }
  check(){if(this.fenced)fault(this.fenced);}
  // Measure from the genuine event-loop yield through the caller's immediate
  // microtask chain, including allocations/dispatch outside the inner loop.
  finishSegment(){if(this.segmentStart===null||this.segmentStart===undefined)return;const ms=this.clock()-this.segmentStart;this.segmentStart=null;const m=this.metrics;m.sliceMaxMs=Math.max(m.sliceMaxMs,ms);if(ms>100)m.sliceOverTargetCount++;if(ms>250){m.sliceViolationCount++;if(this.enforceSliceLimit)this.fenced='SLICE_LIMIT';}}
  async boundary(){
    this.finishSegment();if(this.queued)fault('COMPETING_CONTINUATION');this.queued=true;
    try{for(;;){await new Promise(resolve=>setImmediate(()=>{this.segmentStart=this.clock();resolve();}));this.metrics.yieldCount++;this.check();
      if(this.clock()-this.lastProgress>=15000)this.starved=true;
      const n=this.native(),now=this.clock();
      if(!n.ready&&!n.running&&n.due-now>1000)return;
      this.metrics.guardWaits++;this.finishSegment();await new Promise(r=>setTimeout(r,5));
    }}finally{this.queued=false;}
  }
  async slice(fn,progress=0){await this.boundary();const token=this.epoch;let value;
    try{value=fn();if(value&&typeof value.then==='function')fault('ASYNC_SLICE');}
    catch(e){this.finishSegment();throw e;}
    if(token!==this.epoch)fault('STALE_COMPLETION');this.check();if(progress)this.progress(progress);return value;
  }
  progress(n){this.metrics.progress+=n;this.lastProgress=this.clock();this.starved=false;}
  async io(fn){await this.boundary();if(this.ioActive)fault('COMPETING_IO');this.ioActive=true;const token=this.epoch;this.metrics.ioCount++;this.metrics.ioMax=1;
    try{const operation=fn();this.finishSegment();const result=await operation;this.segmentStart=this.clock();await this.boundary();if(token!==this.epoch)fault('STALE_COMPLETION');return result;}finally{this.ioActive=false;}
  }
  async stage(phase){await this.slice(()=>{this.phase=phase;this.onPhase(phase);});}
  abort(){this.epoch++;this.fenced='ABORTED';}
  ordinaryFence(){return this.fenced||(this.clock()-this.lastProgress>=15000?'FOLD_STARVED':null);}
}
async function open(s,file,flags='r'){return s.io(()=>fs.open(file,flags,0o600));}
async function close(s,f){if(f){if(s.fenced){await immediate();await f.close();await immediate();}else await s.io(()=>f.close());}}
async function read(s,f,b,at){C.integer(at);C.integer(at+b.length);let off=0;
  while(off<b.length){const n=Math.min(s.quantum,b.length-off),r=await s.io(()=>f.read(b,off,n,at+off));if(!r.bytesRead)C.fail('short positioned read');off+=r.bytesRead;}
  return b;
}
async function write(s,f,b,at){C.integer(at);C.integer(at+b.length);let off=0;
  while(off<b.length){const n=Math.min(s.quantum,b.length-off),r=await s.io(()=>f.write(b,off,n,at+off));if(!r.bytesWritten)fault('SHORT_WRITE');off+=r.bytesWritten;}
}
async function syncDir(s,dir){if(process.platform==='win32')return;const f=await open(s,dir);try{await s.io(()=>f.sync());}finally{await close(s,f);}}
async function regular(s,dir,name){if(!/^[-a-zA-Z0-9.]+$/.test(name)||name==='.'||name==='..')C.fail('unsafe path');const file=path.join(dir,name),stat=await s.io(()=>fs.lstat(file));if(!stat.isFile()||stat.isSymbolicLink())C.fail('nonregular file');return file;}
async function hashFile(s,file){const f=await open(s,file),h=crypto.createHash('sha256'),b=Buffer.alloc(s.quantum);let off=0;
  try{const size=(await s.io(()=>f.stat())).size;while(off<size){const n=Math.min(b.length,size-off);await read(s,f,b.subarray(0,n),off);await s.slice(()=>h.update(b.subarray(0,n)),n);off+=n;}return await s.slice(()=>h.digest('hex'));}finally{await close(s,f);}
}
async function immutable(s,source,dir,name,hash){
  try{if(process.platform==='win32'){
      // Windows-only test fallback under the exclusive writer. Move only a fully
      // synced attempt; never leave a partly copied immutable content name.
      try{await s.io(()=>fs.lstat(path.join(dir,name)));const e=Error('exists');e.code='EEXIST';throw e;}catch(e){if(e.code!=='ENOENT')throw e;}
      await s.io(()=>fs.rename(source,path.join(dir,name)));
    }else await s.io(()=>fs.link(source,path.join(dir,name)));}
  catch(e){if(e.code!=='EEXIST')throw e;if(await hashFile(s,await regular(s,dir,name))!==hash)C.fail('immutable name collision');}
  await syncDir(s,dir);
}
async function tree(s,file,treeFile,role){
  const src=await open(s,file),out=await open(s,treeFile,'wx+');
  try{const bytes=(await s.io(()=>src.stat())).size,{pages,base}=P.shape(bytes);await write(s,out,P.header(role,bytes),0);
    const b=Buffer.alloc(s.quantum);
    for(let i=0;i<base;i++){
      let h;
      if(i<pages){const size=Math.min(P.PAGE,bytes-i*P.PAGE),hasher=crypto.createHash('sha256');
        await s.slice(()=>hasher.update(P.TAG).update(Buffer.from([1,P.ROLE[role]])).update(C.u64(i)).update(C.u64(size)));
        for(let off=0;off<size;){const n=Math.min(b.length,size-off);await read(s,src,b.subarray(0,n),i*P.PAGE+off);await s.slice(()=>hasher.update(b.subarray(0,n)),n);off+=n;}
        h=await s.slice(()=>hasher.digest());
      }else h=await s.slice(()=>P.pad(role,i),32);
      await write(s,out,h,P.nodeOffset(base+i));
    }
    const pair=Buffer.alloc(64);
    for(let width=base/2;width>=1;width/=2)for(let i=0;i<width;i++){
      await read(s,out,pair,P.nodeOffset((width+i)*2));const h=await s.slice(()=>P.parent(pair.subarray(0,32),pair.subarray(32)),64);await write(s,out,h,P.nodeOffset(width+i));
    }
    const root=pages?await read(s,out,Buffer.alloc(32),P.nodeOffset(1)):P.empty(role);await s.io(()=>out.sync());await s.stage('HASH_'+role);
    return {v:1,role,bytes,pages,base,root:root.toString('hex'),sha256:await hashFile(s,file),treeSha256:await hashFile(s,treeFile),treeBytes:(await s.io(()=>out.stat())).size};
  }finally{await close(s,src);await close(s,out);}
}
class Pages {
  constructor(s,dir,d,role){Object.assign(this,{s,dir,d,role});this.cached=-1;}
  async init(){const {s,dir,d,role}=this;await s.slice(()=>P.validateDescriptor(d,role));
    this.file=await open(s,await regular(s,dir,d.sha256+'.'+role));this.proof=await open(s,await regular(s,dir,d.treeSha256+'.mtree'));
    if((await s.io(()=>this.file.stat())).size!==d.bytes||(await s.io(()=>this.proof.stat())).size!==d.treeBytes)C.fail('file size');
    if(!(await read(s,this.proof,Buffer.alloc(P.HEADER),0)).equals(P.header(role,d.bytes)))C.fail('tree header');return this;
  }
  async page(n){if(n===this.cached)return this.buffer;const {s,d,role}=this;C.integer(n);if(n>=d.pages)C.fail('page bounds');
    const b=Buffer.alloc(Math.min(P.PAGE,d.bytes-n*P.PAGE));await read(s,this.file,b,n*P.PAGE);
    const h=crypto.createHash('sha256');await s.slice(()=>h.update(P.TAG).update(Buffer.from([1,P.ROLE[role]])).update(C.u64(n)).update(C.u64(b.length)));
    for(let off=0;off<b.length;off+=s.quantum)await s.slice(()=>h.update(b.subarray(off,Math.min(off+s.quantum,b.length))),Math.min(s.quantum,b.length-off));
    let digest=await s.slice(()=>h.digest()),node=d.base+n;
    while(node>1){const other=node%2?node-1:node+1,sibling=await read(s,this.proof,Buffer.alloc(32),P.nodeOffset(other));digest=await s.slice(()=>node%2?P.parent(sibling,digest):P.parent(digest,sibling),64);node=Math.floor(node/2);}
    if(digest.toString('hex')!==d.root)C.fail('page authentication');this.cached=n;this.buffer=b;return b;
  }
  async range(off,len,max){C.integer(off);C.integer(len,max);if(off+len>this.d.bytes)C.fail('range');const b=Buffer.alloc(len);let done=0;
    while(done<len){const at=off+done,page=await this.page(Math.floor(at/P.PAGE)),within=at%P.PAGE,n=Math.min(page.length-within,len-done,this.s.quantum);await this.s.slice(()=>page.copy(b,done,within,within+n),n);done+=n;}return b;
  }
  async close(){await close(this.s,this.file);await close(this.s,this.proof);}
}
class Reader {
  constructor(s,dir,d,{testDigest=null}={}){Object.assign(this,{s,dir,d,testDigest});this.index=0;this.previous=null;this.live=0;this.maxLSN=0;this.offset=0;}
  async init(){const {s,d}=this;await s.slice(()=>{if(d.format!==S.FORMAT||d.codec!==1||!C.FAMILIES.includes(d.family)||JSON.stringify(d).length>1024)C.fail('shard format');C.integer(d.bucket,255);C.integer(d.count);C.integer(d.live);C.integer(d.tombstones);C.integer(d.maxLSN);if(d.live+d.tombstones!==d.count)C.fail('counts');});
    if(d.empty){if(JSON.stringify(d)!==JSON.stringify(S.emptyDescriptor(d.family,d.bucket)))C.fail('empty identity');return this;}
    if(!d.count||d.slots.bytes!==d.count*S.SLOT)C.fail('slot count');
    this.slots=await new Pages(s,this.dir,d.slots,'slots').init();this.values=await new Pages(s,this.dir,d.values,'values').init();return this;
  }
  async next(){const {s,d}=this;if(this.index===d.count){if(this.live!==d.live||this.maxLSN!==d.maxLSN||!d.empty&&this.offset!==d.values.bytes)C.fail('merge source coverage');return null;}
    const b=await this.slots.range(this.index*S.SLOT,S.SLOT,S.SLOT),ko=C.from64(b,32),kl=C.from64(b,40),vo=C.from64(b,48),vl=C.from64(b,56),lsn=C.from64(b,64),flags=b.readUInt32LE(72);
    if(b.readUInt32LE(76)||ko!==this.offset||vo!==ko+kl||lsn>d.maxLSN||![0,1,2].includes(flags))C.fail('slot fields');
    const key=await this.values.range(ko,kl,C.MAX_KEY),digest=b.subarray(0,32);
    await s.slice(()=>{C.validateKey(key,d.family);const expected=this.testDigest?this.testDigest(key):C.sha(key);if(!digest.equals(expected)||digest[0]!==d.bucket||this.previous&&C.compare(this.previous,{key,digest})>=0)C.fail('key/order');},kl);
    const value=await this.values.range(vo,vl,C.MAX_VALUE);const r={key,digest,value,lsn,flags};this.index++;this.offset=vo+vl;if(flags!==1)this.live++;this.maxLSN=Math.max(this.maxLSN,lsn);this.previous={key,digest};return r;
  }
  async close(){if(this.slots)await this.slots.close();if(this.values)await this.values.close();}
}
class Writer {
  constructor(s,dir,family,bucket,{testDigest=null}={}){Object.assign(this,{s,dir,family,bucket,testDigest,count:0,live:0,maxLSN:0,offset:0,previous:null});this.prefix=crypto.randomUUID()+'.building';}
  async init(){const {s,dir,prefix}=this;this.slotPath=path.join(dir,prefix+'.slots');this.valuePath=path.join(dir,prefix+'.values');this.sf=await open(s,this.slotPath,'wx');this.vf=await open(s,this.valuePath,'wx');return this;}
  async add(r){const {s}=this;await s.slice(()=>{C.record(r.key,r.value,r.lsn,r.flags,r.digest);C.validateKey(r.key,this.family);if(!(this.testDigest?this.testDigest(r.key):C.sha(r.key)).equals(r.digest)||r.digest[0]!==this.bucket||this.previous&&C.compare(this.previous,r)>=0)C.fail('output order');},r.key.length);
    await write(s,this.sf,S.slot(r,this.offset),this.count*S.SLOT);await write(s,this.vf,r.key,this.offset);await write(s,this.vf,r.value,this.offset+r.key.length);
    this.offset+=r.key.length+r.value.length;this.count++;if(r.flags!==1)this.live++;this.maxLSN=Math.max(this.maxLSN,r.lsn);this.previous={key:r.key,digest:r.digest};
  }
  async finish(){const {s}=this;await s.stage('FINALIZE_SHARD');await s.io(()=>this.sf.sync());await s.io(()=>this.vf.sync());await this.close();if(!this.count)return S.emptyDescriptor(this.family,this.bucket);
    const descriptors=[];for(const [source,role]of [[this.slotPath,'slots'],[this.valuePath,'values']]){
      await s.stage('PROOF_'+role);const d=await tree(s,source,source+'.mtree',role);await s.stage('HASH_'+role);
      await immutable(s,source,this.dir,d.sha256+'.'+role,d.sha256);await immutable(s,source+'.mtree',this.dir,d.treeSha256+'.mtree',d.treeSha256);descriptors.push(d);
    }
    return {format:S.FORMAT,codec:1,family:this.family,bucket:this.bucket,count:this.count,live:this.live,tombstones:this.count-this.live,maxLSN:this.maxLSN,slots:descriptors[0],values:descriptors[1]};
  }
  async close(){await close(this.s,this.sf);this.sf=null;await close(this.s,this.vf);this.vf=null;}
}
// Bottom-up stable merge of references, bounded at 32,768; each batch yields.
async function order(s,map){let a=[],b=[];const it=map.values();let end=false;
  while(!end)await s.slice(()=>{for(let n=0;n<64;n++){const v=it.next();if(v.done){end=true;break;}if(a.length>=32768)C.fail('sort cap');a.push(v.value.r||v.value);}},64*8);
  b=new Array(a.length);
  for(let width=1;width<a.length;width*=2){for(let start=0;start<a.length;start+=width*2){let i=start,j=Math.min(start+width,a.length),at=start,mid=j,end=Math.min(start+2*width,a.length);
      while(at<end)await s.slice(()=>{let n=0;while(at<end&&n++<64)b[at++]=i<mid&&(j===end||C.compare(a[i],a[j])<=0)?a[i++]:a[j++];},512);
    }[a,b]=[b,a];}
  return a;
}
async function fold(s,dir,d,updates,options={}){await s.stage('BUILD_SHARD');const reader=await new Reader(s,dir,d,options).init(),writer=await new Writer(s,dir,d.family,d.bucket,options).init();let old=await reader.next(),i=0;
  try{while(old||i<updates.length){const u=updates[i];if(!old){await writer.add(u);i++;}else if(!u){await writer.add(old);old=await reader.next();}else{
        const cmp=await s.slice(()=>C.compare(old,u));if(cmp<0){await writer.add(old);old=await reader.next();}else if(cmp>0){await writer.add(u);i++;}else{
          if(u.lsn<old.lsn)C.fail('LSN regression');if(u.lsn===old.lsn){if(u.flags!==old.flags||u.value.length!==old.value.length)C.fail('conflicting LSN');for(let off=0;off<u.value.length;off+=s.quantum)await s.slice(()=>{if(!u.value.subarray(off,off+s.quantum).equals(old.value.subarray(off,off+s.quantum)))C.fail('conflicting LSN');},Math.min(s.quantum,u.value.length-off));}
          await writer.add(u);i++;old=await reader.next();
        }
      }}
    const descriptor=await writer.finish();await s.stage('VERIFY_SHARD');const verify=await new Reader(s,dir,descriptor,options).init();
    try{while(await verify.next()){} }finally{await verify.close();}return descriptor;
  }finally{await reader.close();await writer.close();}
}
module.exports={Scheduler,immediate,fault,open,close,read,write,syncDir,regular,hashFile,immutable,tree,Pages,Reader,Writer,order,fold};
