'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),zlib=require('zlib');
const {CompactMaintenance}=require('../lib/prospectiveCompactMaintenance');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orayan-compact-reset-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {dir,m:new CompactMaintenance(dir)};}
test('compact-only reset deletes exact prospective hourly files and preserves other evidence',t=>{
  const {dir,m}=fixture(t);fs.writeFileSync(path.join(dir,'compact-2026-10-01-18.jsonl'),'old\n');
  for(const n of ['births-2026-10-01.jsonl','checkpoint.json','trades-2026-10-01-18.jsonl.gz','settings.json'])fs.writeFileSync(path.join(dir,n),'keep');
  assert.throws(()=>m.reset({scope:'all',expectedCohort:'LEGACY'}),/MISMATCH/);
  const r=m.reset({scope:'prospective_compact_only',expectedCohort:'LEGACY'},100);
  assert.equal(r.before.sizeBytes,4);assert.equal(r.after.sizeBytes,0);assert.equal(r.after.cohort.id,'compact-reset-100');
  assert.equal(fs.readFileSync(path.join(dir,'settings.json'),'utf8'),'keep');assert.equal(fs.existsSync(path.join(dir,'births-2026-10-01.jsonl')),true);
  assert.equal(new CompactMaintenance(dir).cohort.id,'compact-reset-100');assert.throws(()=>m.reset({scope:'prospective_compact_only',expectedCohort:'LEGACY'}),/MISMATCH/);
});
test('gzip daily export excludes old and post-watermark rows, streams fixed byte snapshot',async t=>{
  const {dir,m}=fixture(t),file=path.join(dir,'compact-2026-10-01-18.jsonl');
  fs.writeFileSync(file,[{at:10,id:'old'},{at:20,id:'new'},{at:40,id:'future'}].map(JSON.stringify).join('\n')+'\n');
  const r=m.download({sinceAt:20,gzip:true},30);fs.appendFileSync(file,JSON.stringify({at:21,id:'concurrent'})+'\n');
  const chunks=[];for await(const chunk of r.stream)chunks.push(chunk);
  const rows=zlib.gunzipSync(Buffer.concat(chunks)).toString().trim().split('\n').map(JSON.parse);
  assert.equal(rows.length,2);assert.equal(rows[1].id,'new');assert.equal(rows[0].watermarkAt,30);
  assert.throws(()=>m.download({sinceAt:31},30),/INVALID/);
});
test('empty restarted archive has a small valid compressed manifest',async t=>{
  const {m}=fixture(t),r=m.download({gzip:true},100),chunks=[];
  for await(const c of r.stream)chunks.push(c);assert.ok(Buffer.concat(chunks).length<1024);
  assert.equal(JSON.parse(zlib.gunzipSync(Buffer.concat(chunks)).toString()).recordType,'export_manifest');
});
