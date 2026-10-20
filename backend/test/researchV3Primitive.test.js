'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const C=require('../lib/researchV3/codec'),P=require('../lib/researchV3/pages'),S=require('../lib/researchV3/shard'),IO=require('../lib/researchV3/io');
function temp(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'v3-primitive-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
function sample(n,options={}){const digest=options.testDigest;return Array.from({length:n},(_,i)=>{const k=C.key('D','record',['key'+i]);return C.record(k,Buffer.from('value'+i),i+1,0,digest?digest(k):C.sha(k));}).sort(C.compare);}
function build(dir,rows,options={}){const w=new S.Writer(dir,'D',rows[0].digest[0],options);try{for(const r of rows)w.add(r);return w.finish();}catch(e){w.abort();throw e;}}
function collision(){return Buffer.alloc(32,7);}
test('closed codec preserves delimiters, Unicode and prototype-like identities',()=>{
 const keys=[['a','b:c'],['a:b','c'],['__proto__'],[''],['\ud800'],['\ud801'],['a\u0000b'],['é']].map(v=>C.key('D','record',v));assert.equal(new Set(keys.map(b=>b.toString('hex'))).size,keys.length);
 for(const k of keys)assert.equal(C.validateKey(k,'D'),k);assert.throws(()=>C.key('Z','record',['a']));assert.throws(()=>C.key('D','bad',['a']));assert.throws(()=>C.from64(Buffer.from('ffffffffffffffff','hex')));
});
test('fixed directory has ten families with exactly 256 canonical empty descriptors',()=>{
 const d=S.directory();assert.deepEqual(Object.keys(d),C.FAMILIES);for(const f of C.FAMILIES){assert.equal(d[f].length,256);assert.ok(Buffer.byteLength(JSON.stringify(d[f]))<512*1024);}assert.ok(Buffer.byteLength(JSON.stringify(d))<4*1024*1024);
});
test('exact full keys survive forced digest collisions and negative queries',t=>{
 const dir=temp(t),rows=sample(100,{testDigest:collision}),d=build(dir,rows,{testDigest:collision}),r=new S.Reader(dir,d,{testDigest:collision,cache:new IO.Cache(0)});t.after(()=>r.close());
 for(const x of rows)assert.deepEqual(r.get(x.key).value,x.value);assert.equal(r.get(C.key('D','record',['absent'])),null);
});
test('cross-page slots and values authenticate before use with byte-capped LRU',t=>{
 const dir=temp(t),rows=sample(2000,{testDigest:collision}),d=build(dir,rows,{testDigest:collision}),cache=new IO.Cache(70000),r=new S.Reader(dir,d,{testDigest:collision,cache});t.after(()=>r.close());
 for(const i of [0,819,1638,1999])assert.deepEqual(r.get(rows[i].key).value,rows[i].value);assert.ok(cache.bytes<=70000);assert.ok(r.stats.proofBytes>0);assert.ok(r.handles.map.size<=32);
});
test('corrupt search page blocks an exact negative proof',t=>{
 const dir=temp(t),d=build(dir,sample(40,{testDigest:collision}),{testDigest:collision}),file=path.join(dir,(d.slots.sha256+'.slots')),fd=fs.openSync(file,'r+');fs.writeSync(fd,Buffer.from([255]),0,1,79);fs.closeSync(fd);
 const r=new S.Reader(dir,d,{testDigest:collision});t.after(()=>r.close());assert.throws(()=>r.get(C.key('D','record',['absent'])),{code:'INDEX_INTEGRITY_FAILED'});
});
test('corrupt key page, proof sibling, header, empty identity and truncated data fail closed',t=>{
 for(const kind of ['key','proof','header','truncated','empty']){
  const dir=temp(t),d=build(dir,sample(2200,{testDigest:collision}),{testDigest:collision});
  if(kind==='empty'){d.empty=true;assert.throws(()=>new S.Reader(dir,d));continue;}
  const file=path.join(dir,kind==='key'?(d.values.sha256+'.values'):kind==='truncated'?(d.slots.sha256+'.slots'):(d.slots.treeSha256+'.mtree'));
  if(kind==='truncated')fs.truncateSync(file,1);else{const fd=fs.openSync(file,'r+'),off=kind==='header'?0:kind==='key'?0:P.nodeOffset(d.slots.base+1);const b=Buffer.alloc(1);fs.readSync(fd,b,0,1,off);b[0]^=1;fs.writeSync(fd,b,0,1,off);fs.closeSync(fd);}
  let r;try{if(kind==='header'||kind==='truncated')assert.throws(()=>new S.Reader(dir,d));else{r=new S.Reader(dir,d,{testDigest:collision});assert.throws(()=>{for(const x of r.records())void x;},{code:'INDEX_INTEGRITY_FAILED'});}}finally{r?.close();}
 }
});
test('stream fold preserves original shard and replaces exact versions including tombstones',t=>{
 const dir=temp(t),rows=sample(100,{testDigest:collision}),d=build(dir,rows,{testDigest:collision}),oldHash=IO.hashFile(path.join(dir,(d.values.sha256+'.values'))),overlay=new S.Overlay();
 overlay.set({...rows[10],value:Buffer.from('new'),lsn:1001});overlay.set({...rows[20],flags:1,value:Buffer.alloc(0),lsn:1002});const k=C.key('D','record',['newkey']);overlay.set(C.record(k,Buffer.from('added'),1003,0,collision(k)));
 const result=S.fold(dir,d,overlay,{testDigest:collision}),r=new S.Reader(dir,result.descriptor,{testDigest:collision});t.after(()=>r.close());assert.equal(r.d.count,101);assert.equal(r.get(rows[10].key).value.toString(),'new');assert.equal(r.get(rows[20].key),null);assert.equal(r.get(k).value.toString(),'added');assert.equal(IO.hashFile(path.join(dir,(d.values.sha256+'.values'))),oldHash);
});
test('overlay fences before capacity and fold rejects conflicting LSNs',t=>{
 const o=new S.Overlay();let thrown=false;for(let i=0;i<100;i++){try{o.set(C.record(C.key('D','record',['x'+i]),Buffer.alloc(1024*1024),i));}catch(e){assert.equal(e.code,'OVERLAY_CAPACITY');thrown=true;break;}}assert.ok(thrown);assert.ok(o.encoded<=8*1024*1024);assert.ok(o.accounted<=16*1024*1024);
 const dir=temp(t),rows=sample(1,{testDigest:collision}),d=build(dir,rows,{testDigest:collision}),bad=new S.Overlay();bad.set({...rows[0],value:Buffer.from('conflict')});assert.throws(()=>S.fold(dir,d,bad,{testDigest:collision}));
});
test('single writer refuses live, stale and incomplete locks without stealing',t=>{
 const dir=temp(t),a=IO.lock(dir);assert.throws(()=>IO.lock(dir),{code:'EEXIST'});a.release();fs.mkdirSync(path.join(dir,'WRITER.lock'));assert.throws(()=>IO.lock(dir),{code:'EEXIST'});
});
test('codec and checksum tags match frozen independent fixtures',()=>{
 const f=require('./fixtures/researchV3/codec-v1.json');assert.equal(C.key('D','record',['a','\ud800']).toString('hex'),f.tuple);
 assert.equal(P.leaf('slots',3,Buffer.from('abc')).toString('hex'),f.leaf);assert.equal(P.parent(Buffer.alloc(32,1),Buffer.alloc(32,2)).toString('hex'),f.parent);assert.equal(P.pad('values',7).toString('hex'),f.pad);assert.equal(P.empty('slots').toString('hex'),f.empty);
 const r=C.record(C.key('D','record',['a']),Buffer.from('v'),19);assert.equal(S.slot(r,5).toString('hex'),f.slot);
});
test('external run sort streams exact order through multiple bounded passes',t=>{
 const dir=temp(t),Spool=require('../lib/researchV3/spool'),rows=sample(6000),file=Spool.sort(path.join(dir,'sort'),rows.toReversed()),r=new Spool.Input(file);try{for(const expected of rows)assert.deepEqual(r.next(),expected);assert.equal(r.next(),null);}finally{r.close();}
});
test('empty shard proves absence and malformed offsets never wrap',t=>{
 const dir=temp(t),d=S.emptyDescriptor('D',0),reader=new S.Reader(dir,d);t.after(()=>reader.close());let key;for(let i=0;;i++){key=C.key('D','record',[String(i)]);if(C.sha(key)[0]===0)break;}assert.equal(reader.get(key),null);assert.throws(()=>C.integer(Number.MAX_SAFE_INTEGER+1));
});
