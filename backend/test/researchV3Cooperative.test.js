'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const C=require('../lib/researchV3/codec'),S=require('../lib/researchV3/shard'),IO=require('../lib/researchV3/io'),Q=require('../lib/researchV3/cooperative'),{Budget,CAPS}=require('../lib/researchV3/foldBudget'),{Harness}=require('./helpers/researchV3Publication');
const budget={reserve:{encoded:65536,accounted:262144,entries:128},completionBoundMs:120000};
function temp(){return fs.mkdtempSync(path.join(process.env.V3_TEST_ROOT||os.tmpdir(),'v3-cooperative-'));}
function r(name,value='v',lsn=1,flags=0,family='D',digest=null){const key=C.key(family,'record',[name]);return C.record(key,Buffer.isBuffer(value)?value:Buffer.from(value),lsn,flags,digest||C.sha(key));}
function syncBuild(dir,records,digest){const w=new S.Writer(dir,'D',records[0].digest[0],{testDigest:digest});for(const x of records)w.add(x);return w.finish();}
test('cooperative merge/proof/hash bytes equal synchronous oracle with collisions and maximum records',async()=>{
 const dir=temp(),dig=()=>Buffer.alloc(32,7),records=[];for(let i=0;i<60;i++)records.push(r('x'+i,i===10?Buffer.alloc(C.MAX_VALUE,9):'old',i+1,0,'D',dig()));records.push(r('m'.repeat((C.MAX_KEY-8)/2),'max',99,0,'D',dig()));records.sort(C.compare);const d=syncBuild(dir,records,dig),before=IO.hashFile(path.join(dir,d.values.sha256+'.values')),o=new S.Overlay();o.set({...records[0],value:Buffer.from('changed'),lsn:101});o.set({...records[1],value:Buffer.alloc(0),flags:1,lsn:102});
 const expected=S.fold(dir,d,o,{testDigest:dig}).descriptor,s=new Q.Scheduler({quantum:16384}),updates=await Q.order(s,o.map),actual=await Q.fold(s,dir,d,updates,{testDigest:dig});assert.deepEqual(actual,expected);assert.equal(IO.hashFile(path.join(dir,d.values.sha256+'.values')),before);assert.equal(s.metrics.ioMax,1);assert.ok(s.metrics.yieldCount>100);assert.ok(s.metrics.sliceMaxMs<=250);
});
test('incremental ordering handles the full entry ceiling without Array.sort',async()=>{
 const map=new Map();for(let i=0;i<32768;i++)map.set(i,{r:r(String(i))});const s=new Q.Scheduler(),rows=await Q.order(s,map);for(let i=1;i<rows.length;i++)assert.ok(C.compare(rows[i-1],rows[i])<0);assert.equal(rows.length,32768);
});
test('positioned I/O handles short reads/writes, zero completion and exact offsets',async()=>{
 const s=new Q.Scheduler({quantum:7}),target=Buffer.alloc(100),src=Buffer.from('abcdefghijklmnopqrstuvwxyz');let reads=0,writes=0;
 await Q.write(s,{async write(b,off,len,at){const n=Math.min(len,3);b.copy(target,at,off,off+n);writes++;return {bytesWritten:n};}},src,10);
 const dest=Buffer.alloc(src.length);await Q.read(s,{async read(b,off,len,at){const n=Math.min(len,2);target.copy(b,off,at,at+n);reads++;return {bytesRead:n};}},dest,10);assert.deepEqual(dest,src);assert.ok(reads>1&&writes>1);
 await assert.rejects(Q.write(s,{async write(){return {bytesWritten:0};}},src,0),{code:'SHORT_WRITE'});await assert.rejects(Q.read(s,{async read(){return {bytesRead:0};}},dest,0),{code:'INDEX_INTEGRITY_FAILED'});
});
test('scheduler gives ready/native due work priority, detects starvation and stale I/O',async()=>{
 let ready=true,now=0,ran=false;const s=new Q.Scheduler({native:()=>({ready,running:false,due:ready?100:Infinity}),clock:()=>now});const p=s.slice(()=>{ran=true;});setImmediate(()=>{assert.equal(ran,false);now=15001;assert.equal(s.ordinaryFence(),'FOLD_STARVED');ready=false;});await p;assert.ok(ran);assert.ok(s.metrics.guardWaits>0);
 let release;const gate=new Promise(r=>{release=r;}),stale=new Q.Scheduler(),op=stale.io(async()=>{await gate;return 'late';});await Q.immediate();await Q.immediate();stale.abort();release();await assert.rejects(op);assert.equal(stale.metrics.ioMax,1);
});
test('one global budget retains P and N versions, counts repeated journal bytes and reserves before commit',()=>{
 const b=new Budget(budget),a=r('same','first'),ticket=b.precommit([a],100);b.apply(ticket);const P=b.pin(),next=r('same','second',2);b.apply(b.precommit([next],100));assert.equal(P.values().next().value.r.value.toString(),'first');assert.equal(b.used.entries,2);assert.equal(b.lookup(a.key).value.toString(),'second');
 let lsn=3;while(b.used.encoded+1024+budget.reserve.encoded<=CAPS.encoded)b.apply(b.precommit([r('same','v',lsn++)],1024));const before={...b.used};assert.throws(()=>b.precommit([r('same','rejected',lsn)],1024),{code:'OVERLAY_CAPACITY'});assert.deepEqual(b.used,before);b.apply(b.precommit([r('protected','outcome',lsn)],100,{protectedWrite:true}));b.assert();b.retire();assert.equal(b.P,null);assert.ok(b.used.encoded>100);
 assert.throws(()=>new Budget().precommit([a],100),{code:'ENVELOPE_UNQUALIFIED'});
});
test('all-family F/H publication, N tombstones and scalar-only LSN survive two restarts',async()=>{
 const dir=temp();let injected=false;const h=await new Harness(dir,{budget,hook:async(phase,store)=>{if(phase==='CYCLE_DURABLE'&&!injected){injected=true;const old=store.C;for(const f of C.FAMILIES)assert.equal((await store.get(C.key(f,'record',['same']))).toString(),'before');await store.transaction(C.FAMILIES.map(f=>r('same',f==='D'?'':'after',0,f==='D'?1:0,f)),{scalar:5,protectedWrite:true});assert.equal(store.C,old);assert.equal(await store.get(C.key('D','record',['same'])),null);}}}).init();
 await h.transaction(C.FAMILIES.map(f=>r('same','before',0,0,f)),{scalar:3});await h.transaction([],{scalar:2});const result=await h.cycle();assert.equal(result.F,2);assert.equal(result.H,3);assert.equal(h.scalar,10);assert.equal(h.budget.P,null);assert.ok(result.barrierMs<=750);await h.close();
 for(let i=0;i<2;i++){const recovered=await new Harness(dir,{budget}).init();assert.equal(recovered.lsn,3);assert.equal(recovered.scalar,10);for(const f of C.FAMILIES)assert.equal((await recovered.get(C.key(f,'record',['same'])))?.toString()??null,f==='D'?null:'after');await recovered.close();}
});
test('accepted WAL before acknowledgement is finished exactly once and torn journal prefix repaired',async()=>{
 const dir=temp(),h=await new Harness(dir,{budget}).init();await assert.rejects(h.transaction([r('unacked','accepted')],{scalar:7,afterWAL:async()=>{throw Error('crash after WAL');}}));const journal=path.join(dir,h.journal+'.log'),wal=fs.readFileSync(path.join(dir,'wal-1.commit'));fs.appendFileSync(journal,wal.subarray(0,37));await h.close();
 for(let i=0;i<2;i++){const q=await new Harness(dir,{budget}).init();assert.equal(q.scalar,7);assert.equal(q.lsn,1);assert.equal((await q.get(r('unacked').key)).toString(),'accepted');await q.close();}
});
test('published corruption fences and never resets to an empty generation',async()=>{
 const dir=temp(),h=await new Harness(dir,{budget}).init();await h.transaction([r('a')]);await h.cycle();await h.close();const b=fs.readFileSync(path.join(dir,'CURRENT'));fs.writeFileSync(path.join(dir,'CURRENT'),Buffer.concat([b,Buffer.from('invalid')]));await assert.rejects(new Harness(dir,{budget}).init());assert.ok(fs.existsSync(path.join(dir,'INITIALIZED')));
});
test('one reserved protected outcome during final H barrier persists in the new journal without delaying native computation',async()=>{
 const dir=temp();let pending,cut=false;const h=await new Harness(dir,{budget,hook:async(phase,store)=>{if(phase==='CUTOVER_FENCE'&&!cut){cut=true;pending=store.deferProtected([r('protected-cutover','outcome')],{scalar:9});assert.equal(store.protectedPendingHighWater,1);assert.throws(()=>store.deferProtected([r('overflow')]),{code:'PROTECTED_PENDING_CAPACITY'});assert.equal(store.acceptedLSN,store.H);}}}).init();await h.transaction([r('base')]);const cy=await h.cycle();assert.equal(cy.H,1);assert.equal(await pending.completion,2);assert.equal(h.lsn,2);await h.close();const again=await new Harness(dir,{budget}).init();assert.equal(again.scalar,9);assert.equal((await again.get(r('protected-cutover').key)).toString(),'outcome');await again.close();
});
test('invalid unpublished receipt is preserved and rebuilt; valid receipt is reused only after full verification',async()=>{
 const dir=temp();let once=true;const h=await new Harness(dir,{budget,hook:async phase=>{if(phase==='SHARD_RECEIPT'&&once){once=false;throw Error('interrupt after receipt');}}}).init();await h.transaction([r('receipt')]);await assert.rejects(h.cycle());await h.close();const name=fs.readdirSync(dir).find(n=>n.endsWith('.receipt'));fs.writeFileSync(path.join(dir,name),'corrupt');const recovered=await new Harness(dir,{budget}).init();await recovered.cycle();assert.equal((await recovered.get(r('receipt').key)).toString(),'v');assert.ok(fs.readdirSync(dir).some(n=>n.endsWith('.invalid-receipt')));await recovered.close();
});
test('native replay uses the frozen management/executor and preserves deterministic decisions and order',async()=>{
 const {create}=require('./helpers/researchV3NativeReplay'),one=await create().run(0),two=await create().run(0);assert.equal(one.digest,two.digest);assert.equal(one.body.outcomes.length,12);for(let i=0;i<12;i++){assert.equal(one.body.outcomes[i][0],'signal-'+i);assert.ok(Math.abs(one.body.trades[i].netPnl-(i%2?-.2592375:.49035))<1e-9);}
});
test('ENOSPC during proof and rename failure retain old CURRENT and continuous journal',async()=>{
 for(const target of ['PROOF_slots','BEFORE_CURRENT_RENAME']){const dir=temp();let active=false,failed=false;const s=new Q.Scheduler({onPhase:phase=>{if(active&&phase===target&&!failed){failed=true;const e=Error('injected '+target);e.code=target==='PROOF_slots'?'ENOSPC':'EIO';throw e;}}}),h=await new Harness(dir,{scheduler:s,budget}).init();await h.transaction([r('fault','durable')],{scalar:4});const old=fs.readFileSync(path.join(dir,'CURRENT'));active=true;await assert.rejects(h.cycle());assert.deepEqual(fs.readFileSync(path.join(dir,'CURRENT')),old);await h.close();for(let i=0;i<2;i++){const q=await new Harness(dir,{budget}).init();assert.equal(q.scalar,4);assert.equal((await q.get(r('fault').key)).toString(),'durable');await q.close();}}
});
test('an accepted WAL takes priority over the next fold continuation until exact completion',async()=>{
 const h=await new Harness(temp(),{budget}).init();let release,accepted;const gate=new Promise(r=>{release=r;}),atWAL=new Promise(r=>{accepted=r;});const write=h.transaction([r('accepted-priority')],{afterWAL:async()=>{accepted();await gate;}});await atWAL;assert.equal(h.s.native().ready,true);let ran=false;const slice=h.s.slice(()=>{ran=true;});await new Promise(r=>setTimeout(r,10));assert.equal(ran,false);release();await write;await slice;assert.equal(ran,true);await h.close();
});
test('fold slice failure does not cancel the separate mandatory writer lane',async()=>{
 let now=0;const fold=new Q.Scheduler({clock:()=>now});await fold.slice(()=>{now+=251;});await assert.rejects(fold.slice(()=>{}),{code:'SLICE_LIMIT'});
 const writer=new Q.Scheduler({clock:()=>now,enforceSliceLimit:false});await writer.slice(()=>{now+=251;});await writer.slice(()=>{});assert.equal(writer.fenced,null);assert.equal(writer.metrics.sliceViolationCount,1);
});
test('final H waits outside its barrier for an already accepted transaction',async()=>{
 let pending,once=true;const h=await new Harness(temp(),{budget,hook:async(phase,store)=>{if(phase==='BEFORE_CUTOVER_FENCE'&&once){once=false;let accepted,release;const atWAL=new Promise(r=>{accepted=r;}),gate=new Promise(r=>{release=r;});pending=store.transaction([r('pre-H','accepted')],{protectedWrite:true,afterWAL:async()=>{accepted();await gate;}});await atWAL;setTimeout(release,10);}}}).init();await h.transaction([r('prefix')]);const result=await h.cycle();await pending;assert.equal(result.F,1);assert.equal(result.H,2);assert.equal((await h.get(r('pre-H').key)).toString(),'accepted');assert.equal(h.admissionHeld,false);await h.close();
});
