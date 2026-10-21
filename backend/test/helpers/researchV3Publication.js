'use strict';
// Test-only bounded transaction/WAL/root publisher. Never imported by service code.
// Fixture scalar is an additive counter. It does not implement the service reducer.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const C=require('../../lib/researchV3/codec'),S=require('../../lib/researchV3/shard');
const Q=require('../../lib/researchV3/cooperative'),{Budget,CAPS,zero}=require('../../lib/researchV3/foldBudget');
const HEADER=96,JHEADER=80,ZERO='0'.repeat(64),MAX_META=512*1024,MAX_TX=2*1024*1024;
function safe(name){if(!/^[-a-zA-Z0-9.]+$/.test(name)||name==='.'||name==='..')C.fail('unsafe name');return name;}
async function exists(s,file){try{await s.io(()=>fs.lstat(file));return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function bytes(s,file,max){const f=await Q.open(s,file);try{const n=(await s.io(()=>f.stat())).size;C.integer(n,max);return await Q.read(s,f,Buffer.alloc(n),0);}finally{await Q.close(s,f);}}
async function digest(s,b){const h=crypto.createHash('sha256');for(let i=0;i<b.length;i+=s.quantum)await s.slice(()=>h.update(b.subarray(i,i+s.quantum)),Math.min(s.quantum,b.length-i));return s.slice(()=>h.digest('hex'));}
async function put(s,dir,name,b){safe(name);const file=path.join(dir,name);let f;try{f=await Q.open(s,file,'wx');await Q.write(s,f,b,0);await s.io(()=>f.sync());}catch(e){if(e.code!=='EEXIST')throw e;if(await Q.hashFile(s,await Q.regular(s,dir,name))!==await digest(s,b))C.fail('immutable metadata collision');}finally{await Q.close(s,f);}await Q.syncDir(s,dir);return {path:name,bytes:b.length,sha256:await digest(s,b)};}
async function json(s,dir,body,max=MAX_META){const b=await s.slice(()=>Buffer.from(JSON.stringify(body)));C.integer(b.length,max);return put(s,dir,(await digest(s,b))+'.json',b);}
async function load(s,dir,ref,max=MAX_META){C.integer(ref.bytes,max);const b=await bytes(s,await Q.regular(s,dir,safe(ref.path)),max);if(b.length!==ref.bytes||await digest(s,b)!==ref.sha256)C.fail('reference hash');return s.slice(()=>JSON.parse(b));}
function journalHeader(base,anchor,id){const b=Buffer.alloc(JHEADER);b.write('RSV3TST1');C.u64(base).copy(b,8);Buffer.from(anchor,'hex').copy(b,16);Buffer.from(id,'hex').copy(b,48);return b;}
function frameBytes(records){return HEADER+4+records.reduce((n,r)=>n+12+r.key.length+r.value.length,0);}
async function encode(s,records,lsn,scalar,prev){const size=frameBytes(records);C.integer(size,MAX_TX);C.integer(scalar);const b=Buffer.alloc(size);b.write('RSV3TX01');C.u64(lsn).copy(b,8);C.u64(size-HEADER).copy(b,16);C.u64(scalar).copy(b,24);Buffer.from(prev,'hex').copy(b,32);b.writeUInt32LE(records.length,HEADER);let off=HEADER+4;
  for(const r of records){b.writeUInt32LE(r.key.length,off);b.writeUInt32LE(r.value.length,off+4);b.writeUInt32LE(r.flags,off+8);off+=12;for(const part of [r.key,r.value])for(let at=0;at<part.length;){const n=Math.min(s.quantum,part.length-at);await s.slice(()=>part.copy(b,off,at,at+n),n);at+=n;off+=n;}}
  const h=crypto.createHash('sha256');await s.slice(()=>h.update(b.subarray(0,64)));for(let i=HEADER;i<size;i+=s.quantum)await s.slice(()=>h.update(b.subarray(i,i+s.quantum)),Math.min(s.quantum,size-i));const hash=await s.slice(()=>h.digest('hex'));Buffer.from(hash,'hex').copy(b,64);return {bytes:b,hash};
}
async function decode(s,b,lsn,prev){C.integer(b.length,MAX_TX);if(b.length<HEADER+4||b.toString('ascii',0,8)!=='RSV3TX01'||C.from64(b,8)!==lsn||C.from64(b,16)!==b.length-HEADER||b.subarray(32,64).toString('hex')!==prev)C.fail('journal chain');
  const scalar=C.from64(b,24),count=b.readUInt32LE(HEADER);C.integer(count,32768);let off=HEADER+4;const records=[];
  for(let i=0;i<count;i++){if(off+12>b.length)C.fail('frame bounds');const kl=b.readUInt32LE(off),vl=b.readUInt32LE(off+4),flags=b.readUInt32LE(off+8);off+=12;C.integer(kl,C.MAX_KEY);C.integer(vl,C.MAX_VALUE);if(off+kl+vl>b.length)C.fail('frame bounds');
    // Records own slices of one bounded frame; no second value clone.
    const key=Buffer.alloc(kl),value=Buffer.alloc(vl);for(const [dest,start]of [[key,off],[value,off+kl]])for(let at=0;at<dest.length;at+=s.quantum)await s.slice(()=>b.copy(dest,at,start+at,Math.min(start+at+s.quantum,start+dest.length)),Math.min(s.quantum,dest.length-at));records.push(await s.slice(()=>C.record(key,value,lsn,flags)));off+=kl+vl;}
  if(off!==b.length)C.fail('frame end');const h=crypto.createHash('sha256');await s.slice(()=>h.update(b.subarray(0,64)));for(let i=HEADER;i<b.length;i+=s.quantum)await s.slice(()=>h.update(b.subarray(i,i+s.quantum)),Math.min(s.quantum,b.length-i));const hash=await s.slice(()=>h.digest('hex'));if(hash!==b.subarray(64,96).toString('hex'))C.fail('receipt hash');return {records,lsn,scalar,hash,bytes:b};
}
class Harness {
  constructor(dir,{scheduler=new Q.Scheduler(),budget={},testDigest=null,hook=async()=>{},fixture=null}={}){
    Object.assign(this,{dir,s:scheduler,w:new Q.Scheduler(),budgetOptions:budget,testDigest,hook,fixture,writerBusy:false,barrier:false,cycleBusy:false});this.budget=new Budget(budget);
  }
  async mark(phase){await this.s.stage(phase);await this.hook(phase,this);}
  async init(){const {s,dir}=this;await s.io(()=>fs.mkdir(dir,{recursive:true}));
    // mkdir is exclusive. Tests release only after the child process is known dead;
    // the library never steals a stale owner based on elapsed time.
    await s.io(()=>fs.mkdir(path.join(dir,'WRITER.lock')));this.owns=true;
    if(!await exists(s,path.join(dir,'CURRENT'))){if(await exists(s,path.join(dir,'INITIALIZED')))C.fail('missing CURRENT');await this.bootstrap();}
    await this.recover();this.s.finishSegment();this.w.finishSegment();return this;
  }
  async bootstrap(){const {s,dir}=this;await put(s,dir,'INITIALIZED',Buffer.from('test-only-v1'));const families={};
    const base=this.fixture?.H||0;for(const family of C.FAMILIES)families[family]=await json(s,dir,{family,shards:this.fixture?.directory[family]||S.directory()[family]});
    const root=await json(s,dir,{format:S.FORMAT,codec:1,baseLSN:base,parent:null,anchor:ZERO,families},16384),id=C.sha(Buffer.from('initial-journal')).toString('hex');
    await put(s,dir,id+'.log',journalHeader(base,ZERO,id));
    const checkpoint=await json(s,dir,{version:3,testOnly:true,root,indexBaseLSN:base,checkpointLSN:base,scalar:0,activeJournal:{id,baseLSN:base,anchor:ZERO,checkpointEndOffset:JHEADER,checkpointHeadHash:ZERO}},1048576);
    await this.publish({version:3,checkpoint,previous:null});
  }
  async publish(pointer){const {s,dir}=this;const b=await s.slice(()=>Buffer.from(JSON.stringify(pointer)));C.integer(b.length,4096);const tmp=crypto.randomUUID()+'.current';await put(s,dir,tmp,b);await this.mark('BEFORE_CURRENT_RENAME');
    // Once rename has been issued, retain barrier until completion and durability.
    await s.io(()=>fs.rename(path.join(dir,tmp),path.join(dir,'CURRENT')));await this.mark('AFTER_CURRENT_RENAME');await Q.syncDir(s,dir);await this.mark('AFTER_CURRENT_DIRSYNC');
  }
  async readPointer(){const {s,dir}=this;const b=await bytes(s,await Q.regular(s,dir,'CURRENT'),4096),ptr=await s.slice(()=>JSON.parse(b));if(ptr.version!==3)C.fail('pointer version');return {ptr,bytes:b};}
  async recover(){const {s,dir}=this,{ptr,bytes:pb}=await this.readPointer(),cp=await load(s,dir,ptr.checkpoint,1048576),root=await load(s,dir,cp.root,16384);
    if(cp.version!==3||!cp.testOnly||root.format!==S.FORMAT||root.codec!==1||cp.indexBaseLSN!==root.baseLSN||cp.checkpointLSN<root.baseLSN||cp.activeJournal.baseLSN!==root.baseLSN||cp.activeJournal.anchor!==root.anchor)C.fail('root/checkpoint cuts');
    this.pointer=ptr;this.pointerHash=await digest(s,pb);this.cp=cp;this.root=root;this.C=root.baseLSN;this.lsn=this.C;this.scalar=cp.scalar;this.head=root.anchor;this.journal=cp.activeJournal.id;safe(this.journal);this.end=JHEADER;this.budget=new Budget(this.budgetOptions);
    this.pendingCycle=null;if(await exists(s,path.join(dir,'CYCLE'))){const ref=JSON.parse(await bytes(s,path.join(dir,'CYCLE'),16384)),candidate=await load(s,dir,ref,16384);if(candidate.parent===cp.root.sha256){if(candidate.C!==this.C||candidate.F<this.C||candidate.codec!==1||candidate.touched.length!==640)C.fail('cycle identity');this.pendingCycle={ref,body:candidate};}}
    const pinRecovered=()=>{if(this.pendingCycle&&this.lsn===this.pendingCycle.body.F){const cy=this.pendingCycle.body;if(this.head!==cy.anchor||this.end!==cy.inputEnd)C.fail('cycle prefix');this.budget.pin();}};pinRecovered();
    this.directory={};for(const family of C.FAMILIES){const m=await load(s,dir,root.families[family]);if(m.family!==family||m.shards.length!==256)C.fail('family directory');for(let i=0;i<256;i++){const d=m.shards[i];if(d.family!==family||d.bucket!==i)C.fail('descriptor identity');await s.slice(()=>{PValidate(d);});}this.directory[family]=m.shards;}
    const f=await Q.open(s,path.join(dir,this.journal+'.log'));try{
      if(!(await Q.read(s,f,Buffer.alloc(JHEADER),0)).equals(journalHeader(this.C,root.anchor,this.journal)))C.fail('journal header');const size=(await s.io(()=>f.stat())).size;let checkpointSeen=cp.checkpointLSN===this.C;
      while(this.end<size){if(this.end-JHEADER>=CAPS.encoded)C.fail('journal cap');if(size-this.end<HEADER)break;const h=await Q.read(s,f,Buffer.alloc(HEADER),this.end),n=C.from64(h,16)+HEADER;C.integer(n,CAPS.encoded);if(this.end+n>size)break;const tx=await decode(s,await Q.read(s,f,Buffer.alloc(n),this.end),this.lsn+1,this.head);this.applyRecovered(tx);this.end+=n;pinRecovered();
        if(this.lsn===cp.checkpointLSN){if(this.end!==cp.activeJournal.checkpointEndOffset||this.head!==cp.activeJournal.checkpointHeadHash)C.fail('checkpoint receipt extent');checkpointSeen=true;}}
      if(!checkpointSeen)C.fail('checkpoint beyond journal');this.tornJournal=this.end<size;
    }finally{await Q.close(s,f);}
    // One accepted WAL can remain beyond the journal. Exact bytes are completed once.
    const wal=path.join(dir,'wal-'+(this.lsn+1)+'.commit');if(await exists(s,wal)){
      const tx=await decode(s,await bytes(s,wal,CAPS.encoded),this.lsn+1,this.head);await this.complete(tx);this.applyRecovered(tx);
      pinRecovered();if(await exists(s,path.join(dir,'wal-'+(this.lsn+1)+'.commit')))C.fail('multiple outstanding WALs');
    }else if(this.tornJournal)C.fail('torn journal without WAL');
    if(this.pendingCycle&&!this.budget.P)C.fail('unprovable F');
    if(this.lsn<cp.checkpointLSN)C.fail('unprovable extent');this.acceptedLSN=this.acknowledgedLSN=this.lsn;this.cycleFault=false;
  }
  applyRecovered(tx){const ticket=this.budget.precommit(tx.records,tx.bytes.length,{protectedWrite:true});this.budget.apply(ticket);this.lsn=tx.lsn;this.head=tx.hash;if(tx.lsn>this.cp.checkpointLSN)this.scalar+=tx.scalar;}
  async writerMark(phase){await this.w.stage(phase);await this.hook(phase,this);}
  async complete(tx){const {w:s,dir}=this;await put(s,dir,'canonical-'+tx.lsn+'.frame',tx.bytes);await this.writerMark('CANONICAL_DURABLE');const f=await Q.open(s,path.join(dir,this.journal+'.log'),'r+');
    try{const size=(await s.io(()=>f.stat())).size;if(size<this.end||size>this.end+tx.bytes.length)C.fail('journal extent');
      if(size>this.end){const prefix=await Q.read(s,f,Buffer.alloc(size-this.end),this.end);for(let i=0;i<prefix.length;i+=s.quantum)await s.slice(()=>{if(!prefix.subarray(i,i+s.quantum).equals(tx.bytes.subarray(i,Math.min(i+s.quantum,prefix.length))))C.fail('WAL retry conflict');});}
      await Q.write(s,f,tx.bytes,this.end);await s.io(()=>f.sync());
    }finally{await Q.close(s,f);}this.end+=tx.bytes.length;await this.writerMark('JOURNAL_DURABLE');
  }
  deferProtected(mutations,{scalar=0}={}){
    if(!this.barrier)C.fail('protected defer requires publication barrier');if(this.protectedPending)Q.fault('PROTECTED_PENDING_CAPACITY');
    const records=mutations.map(m=>C.record(m.key,m.value,this.lsn+1,m.flags||0)),ticket=this.budget.precommit(records,frameBytes(records),{protectedWrite:true});
    let resolve,reject;const completion=new Promise((a,b)=>{resolve=a;reject=b;});this.protectedPending={mutations:records,scalar,ticket,resolve,reject};this.protectedPendingHighWater=1;
    // Native computation returns immediately. Only the persistence observer may
    // await this one bounded completion after the publication boundary.
    return {completion};
  }
  async drainProtected(){const pending=this.protectedPending;if(!pending)return;this.protectedPending=null;try{const lsn=await this.transaction(pending.mutations,{scalar:pending.scalar,protectedWrite:true,_ticket:pending.ticket});pending.resolve(lsn);}catch(e){pending.reject(e);throw e;}}
  async transaction(mutations,{scalar=0,protectedWrite=false,liability=zero(),afterWAL=null,_ticket=null}={}){
    if(this.writerBusy||this.barrier)Q.fault('WRITER_BUSY');this.writerBusy=true;let ticket,accepted=false;
    try{const lsn=this.lsn+1,records=[];
      // Admission caller owns inputs until resolution; durable frame takes ownership.
      for(const m of mutations)records.push(C.record(m.key,m.value,lsn,m.flags||0));
      ticket=_ticket||this.budget.precommit(records,frameBytes(records),{protectedWrite,liability,scheduler:this.cycleBusy?this.s:null});if(_ticket&&(_ticket!==this.budget.pending||!protectedWrite))C.fail('pending protected identity');
      const frame=await encode(this.w,records,lsn,scalar,this.head),tx=await decode(this.w,frame.bytes,lsn,this.head);ticket.records=tx.records;
      await put(this.w,this.dir,'wal-'+lsn+'.commit',tx.bytes);accepted=true;this.acceptedLSN=lsn;await this.writerMark('WAL_ACCEPTED');if(afterWAL)await afterWAL();await this.complete(tx);this.budget.apply(ticket);this.lsn=lsn;this.head=tx.hash;this.scalar+=scalar;this.acknowledgedLSN=lsn;return lsn;
    }catch(e){if(!accepted&&ticket)this.budget.cancel(ticket);if(accepted)this.budget.ordinaryReason='ACCEPTED_WAL_PENDING';throw e;}finally{this.writerBusy=false;this.w.finishSegment();}
  }
  async get(key){const r=this.budget.lookup(key);if(r)return r.flags===1?null:r.value;const family=String.fromCharCode(key[1]),bucket=(this.testDigest?this.testDigest(key):C.sha(key))[0],reader=await new Q.Reader(this.s,this.dir,this.directory[family][bucket],{testDigest:this.testDigest}).init();
    try{let old;while((old=await reader.next()))if(old.key.equals(key))return old.flags===1?null:old.value;return null;}finally{await reader.close();this.s.finishSegment();}
  }
  async cycle(){if(this.cycleFault)Q.fault('CYCLE_FAULT');if(this.cycleBusy||this.writerBusy||this.budget.pending)Q.fault('CYCLE_BUSY');this.cycleBusy=true;const {s,dir}=this;let cycle;
    try{await this.mark('PIN_BOUNDARY');if(this.writerBusy||this.budget.pending)Q.fault('WRITER_BUSY');this.F=this.pendingCycle?.body.F??this.lsn;this.anchor=this.pendingCycle?.body.anchor??this.head;this.foldInputEnd=this.pendingCycle?.body.inputEnd??this.end;const p=this.budget.P||this.budget.pin();
      const bitmap=Buffer.alloc(320),ordered=await Q.order(s,p);for(let i=0;i<ordered.length;i++)await s.slice(()=>{const r=ordered[i],n=C.FAMILIES.indexOf(String.fromCharCode(r.key[1]))*256+r.digest[0];bitmap[n>>3]|=1<<(n&7);});
      cycle={version:1,writer:'test-only-exclusive-v1',epoch:'fixture-v1',codec:1,C:this.C,F:this.F,parent:this.cp.root.sha256,anchor:this.anchor,journal:this.journal,inputEnd:this.foldInputEnd,touched:bitmap.toString('hex')};const cycleRef=await json(s,dir,cycle,16384);if(this.pendingCycle&&cycleRef.sha256!==this.pendingCycle.ref.sha256)C.fail('reconstructed cycle differs');this.cycleId=cycleRef.sha256;
      const cyclePointer=crypto.randomUUID()+'.cycle';await put(s,dir,cyclePointer,Buffer.from(JSON.stringify(cycleRef)));await s.io(()=>fs.rename(path.join(dir,cyclePointer),path.join(dir,'CYCLE')));await Q.syncDir(s,dir);await this.mark('CYCLE_DURABLE');
      // Family/bucket order uses a fixed 2560-bin index, never history-sized queues.
      const bins=Array.from({length:2560},()=>[]);for(let i=0;i<ordered.length;i+=64)await s.slice(()=>{for(let j=i;j<Math.min(i+64,ordered.length);j++){const r=ordered[j];bins[C.FAMILIES.indexOf(String.fromCharCode(r.key[1]))*256+r.digest[0]].push(r);}});
      const directory={};for(const family of C.FAMILIES){directory[family]=[];for(let bucket=0;bucket<256;bucket++){
          const updates=bins[C.FAMILIES.indexOf(family)*256+bucket];
          if(!updates.length){directory[family].push(this.directory[family][bucket]);continue;}
          const receiptName=this.cycleId+'-'+family+'-'+bucket+'.receipt';let descriptor,reused=false;
          if(await exists(s,path.join(dir,receiptName))){try{const receipt=JSON.parse(await bytes(s,path.join(dir,receiptName),16384));if(receipt.cycleId!==this.cycleId||receipt.family!==family||receipt.bucket!==bucket||receipt.descriptor.family!==family||receipt.descriptor.bucket!==bucket||receipt.descriptor.maxLSN>this.F)C.fail('receipt binding');descriptor=receipt.descriptor;
              await this.verifyCandidate(descriptor);reused=true;this.reusedShards=(this.reusedShards||0)+1;
            }catch(e){if(e.code==='ABORTED')throw e;descriptor=null;}}
          if(!descriptor){descriptor=await Q.fold(s,dir,this.directory[family][bucket],updates,{testDigest:this.testDigest});
            const receipt=Buffer.from(JSON.stringify({cycleId:this.cycleId,family,bucket,descriptor}));
            // Invalid receipt is preserved; a new verified attempt cannot overwrite it.
            if(await exists(s,path.join(dir,receiptName))){await s.io(()=>fs.rename(path.join(dir,receiptName),path.join(dir,crypto.randomUUID()+'.invalid-receipt')));await Q.syncDir(s,dir);}await put(s,dir,receiptName,receipt);
          }
          directory[family].push(descriptor);this.lastReuse=reused;await this.mark('SHARD_RECEIPT');
        }}
      await this.mark('VERIFY_GENERATION');const families={};for(const family of C.FAMILIES)families[family]=await json(s,dir,{family,shards:directory[family]});
      const receipt=await json(s,dir,{parent:this.cp.root.sha256,C:this.C,F:this.F,anchor:this.anchor,cycle:cycleRef,families},16384);
      const root=await json(s,dir,{format:S.FORMAT,codec:1,baseLSN:this.F,parent:this.cp.root.sha256,anchor:this.anchor,families,receipt},16384);
      await this.mark('PREPARE_SUFFIX');const newId=C.sha(Buffer.from(this.cycleId)).toString('hex'),suffixAttempt=crypto.randomUUID()+'.suffix',suffix=await Q.open(s,path.join(dir,suffixAttempt),'wx');let copied=cycle.inputEnd,suffixEnd=JHEADER;
      const old=await Q.open(s,path.join(dir,this.journal+'.log'));try{await Q.write(s,suffix,journalHeader(this.F,this.anchor,newId),0);
        const copy=async()=>{const through=this.end;while(copied<through){const n=Math.min(s.quantum,through-copied),b=await Q.read(s,old,Buffer.alloc(n),copied);await Q.write(s,suffix,b,suffixEnd);copied+=n;suffixEnd+=n;}await s.io(()=>suffix.sync());};
        await copy();await this.mark('PREPARE_CHECKPOINT');await this.mark('BEFORE_CUTOVER_FENCE');
        if(this.writerBusy||this.budget.pending)Q.fault('WRITER_BUSY');this.barrier=true;const barrierAt=performance.now();this.H=this.lsn;
        await this.mark('CUTOVER_FENCE');await copy();await s.io(()=>suffix.sync());await Q.close(s,suffix);await Q.immutable(s,path.join(dir,suffixAttempt),dir,newId+'.log',await Q.hashFile(s,path.join(dir,suffixAttempt)));
        const checkpoint=await json(s,dir,{version:3,testOnly:true,root,indexBaseLSN:this.F,checkpointLSN:this.H,scalar:this.scalar,activeJournal:{id:newId,baseLSN:this.F,anchor:this.anchor,checkpointEndOffset:suffixEnd,checkpointHeadHash:this.head}},1048576);
        const oldPointer=await put(s,dir,this.pointerHash+'.pointer',Buffer.from(JSON.stringify(this.pointer)));
        if(performance.now()-barrierAt>750)Q.fault('PUBLICATION_BARRIER_LIMIT');
        await this.publish({version:3,checkpoint,previous:oldPointer});await this.mark('INSTALL_VIEW');
        this.barrierMs=performance.now()-barrierAt;this.directory=directory;this.C=this.F;this.journal=newId;this.end=suffixEnd;this.cp=await load(s,dir,checkpoint,1048576);const pointer=await this.readPointer();this.pointer=pointer.ptr;this.pointerHash=await digest(s,pointer.bytes);
        // Retirement updates accounting once and retains every physical input.
        await this.mark('RETIRE_PREFIX');await s.slice(()=>this.budget.retire());this.pendingCycle=null;this.barrier=false;await this.drainProtected();await this.mark('DONE');
        if(this.barrierMs>750)Q.fault('PUBLICATION_BARRIER_LIMIT');s.finishSegment();return {C:this.C,F:this.F,H:this.H,barrierMs:this.barrierMs,metrics:{...s.metrics}};
      }finally{await Q.close(s,old);try{await Q.close(s,suffix);}catch(e){if(e.code!=='EBADF')throw e;}}
    }catch(e){this.cycleFault=true;this.budget.ordinaryReason=e.code||'FOLD_FAULT';throw e;}finally{this.cycleBusy=false;s.finishSegment();}
  }
  async verifyCandidate(d){const {s,dir}=this;if(!d.empty)for(const role of ['slots','values']){if(await Q.hashFile(s,await Q.regular(s,dir,d[role].sha256+'.'+role))!==d[role].sha256||await Q.hashFile(s,await Q.regular(s,dir,d[role].treeSha256+'.mtree'))!==d[role].treeSha256)C.fail('candidate content hash');}
    const r=await new Q.Reader(s,dir,d,{testDigest:this.testDigest}).init();try{while(await r.next()){} }finally{await r.close();}
  }
  async close(){if(this.owns){await this.s.io(()=>fs.rmdir(path.join(this.dir,'WRITER.lock')));this.owns=false;}}
}
function PValidate(d){if(d.empty){if(JSON.stringify(d)!==JSON.stringify(S.emptyDescriptor(d.family,d.bucket)))C.fail('empty descriptor');}else{require('../../lib/researchV3/pages').validateDescriptor(d.slots,'slots');require('../../lib/researchV3/pages').validateDescriptor(d.values,'values');}}
module.exports={Harness,encode,decode,frameBytes,bytes,json,put,load,journalHeader,HEADER,JHEADER,ZERO};
