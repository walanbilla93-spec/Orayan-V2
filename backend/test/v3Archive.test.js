'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),zlib=require('zlib');
const {Archive,MAX_BYTES,HOUR_BYTES,BLOCK_BYTES}=require('../lib/v3Archive');
const {compact}=require('../lib/v3Compact');
const {ShadowJournal}=require('../lib/v3Shadow');
const HOUR=3600000,at=Date.UTC(2026,8,30,10);
function tmp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orayan-compact-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
const level={id:'known',type:'SWING_LOW',price:100,zoneLow:99,zoneHigh:101,knownAt:at-HOUR,active:true,ageMs:HOUR,reaction:{reclaim:true}};
const row=(capturedAt=at)=>({capturedAt,outputType:'V3_SHADOW_SIGNAL',v3Decision:'REJECT',research:{selected:level,levels:Array(32).fill(level),premiumDiscount:{rangeHigh:120,rangeLow:90,equilibrium:105,pricePercentile:33,classification:'DISCOUNT'},profile:{price:102,binVolume:10,totalVolume:100,source:'PROXY'}},geometry:{reactionLevel:level,stopLevel:level,rawRR:3,costAdjustedRR:2.9}});
const entries=r=>[{channel:'v3',row:r}];
const rawRead=files=>zlib.gunzipSync(Buffer.concat(files.map(f=>fs.readFileSync(f.path)))).toString().trim().split('\n').filter(Boolean).map(JSON.parse);
const read=files=>require('../lib/v34bCodec').decode(rawRead(files));

test('compact references preserve geometry, causal level definitions and premium/discount without mutating input',()=>{
  const r=row(),before=JSON.stringify(r),c=compact(r);
  assert.equal(JSON.stringify(r),before);assert.equal(c.row.research.levels,undefined);assert.equal(c.definitions.length,1);
  assert.equal(c.definitions[0].definition.knownAt,at-HOUR);assert.equal(c.row.geometry.costAdjustedRR,2.9);
  assert.deepEqual(c.row.research.premiumDiscount,r.research.premiumDiscount);assert.deepEqual(c.row.research.profile,r.research.profile);
  assert.equal(c.row.research.selected.definitionId,c.row.geometry.stopLevel.definitionId);assert.equal(c.row.research.levelInventory.SWING_LOW.active,32);
});
test('gzip blocks and rows remain bounded; definitions precede references and repeat at hourly boundary',t=>{
  const a=new Archive(tmp(t));for(let i=0;i<110;i++)a.write(entries({...row(at+i),padding:'x'.repeat(1900)}));
  const decoded=rawRead(a.list('v3')),n=require('../lib/v34bCodec').encode(row()).definitions.length;assert.equal(decoded.filter(r=>r.outputType==='V3_IMMUTABLE_PAYLOAD').length,n);
  assert.equal(decoded[0].outputType,'V3_IMMUTABLE_PAYLOAD');assert.ok(a.list('v3').length>1);
  for(const f of a.list('v3'))assert.ok(zlib.gunzipSync(fs.readFileSync(f.path)).length<=BLOCK_BYTES);
  a.write(entries(row(at+HOUR)));assert.equal(rawRead(a.list('v3')).filter(r=>r.outputType==='V3_IMMUTABLE_PAYLOAD').length,2*n);
  assert.throws(()=>a.write(entries({...row(at),padding:'x'.repeat(8192)})),/COMPACT_ROW_TOO_LARGE/);
});
test('combined hourly budget preflights the complete batch; denied admission does not partially write',t=>{
  const a=new Archive(tmp(t),{hourBytes:800});a.write([{channel:'v2',row:{capturedAt:at,hello:'world'}}]);
  const before=a.total();assert.throws(()=>a.write([...entries({...row(),padding:require('crypto').randomBytes(1400).toString('hex')}),{channel:'ai',row:{capturedAt:at}}]),/BUDGET_PAUSED/);
  assert.equal(a.total(),before);assert.equal(a.list('v3').length,0);assert.equal(a.list('ai').length,0);
  assert.equal(a.status().budgetSkippedRecords,2);a.write([{channel:'ai',row:{capturedAt:at,status:'small'}}]);
  assert.equal(a.status().capturePausedUntil,at+HOUR);
  a.write(entries(row(at+HOUR)));assert.equal(a.status().capturePausedUntil,null);
});
test('128MiB cap covers 31 protected hourly budgets; rolling eviction preserves at least latest 30 hours',t=>{
  assert.ok(31*HOUR_BYTES<=MAX_BYTES);assert.equal(MAX_BYTES,320*1048576);
  const a=new Archive(tmp(t));for(let i=0;i<33;i++)a.write(entries(row(at+i*HOUR+1234)));
  assert.equal(a.list('v3').length,31);assert.equal(a.status().earliestHour,'2026-09-30-12');
  assert.ok(a.total()<MAX_BYTES);assert.equal(Object.keys(a.summaryHours).length,31);
});
test('export snapshot remains immutable during writes, pins expiring blocks and releases on cleanup',t=>{
  const a=new Archive(tmp(t));a.write(entries(row()));const snapshot=a.snapshot('v3'),before=read(snapshot.files);
  a.write(entries(row(at+1)));assert.deepEqual(read(snapshot.files),before);assert.equal(read(a.list('v3')).length,2);
  a.prune(at+32*HOUR);assert.equal(a.list('v3').length,1);
  snapshot.cleanup();a.prune(at+32*HOUR);assert.equal(a.list('v3').length,0);
  assert.equal(fs.readdirSync(a.dir).filter(n=>n.startsWith('export-')).length,0);
  const empty=a.snapshot('trades');assert.equal(zlib.gunzipSync(fs.readFileSync(empty.files[0].path)).length,0);empty.cleanup();
});
test('restart restores hourly dictionary and budget diagnostics without duplicate definitions',t=>{
  const dir=tmp(t),a=new Archive(dir);a.write(entries(row()));const saved=a.checkpoint();
  saved.skipped=7;saved.pausedUntil=at+HOUR;const b=new Archive(dir);b.restore(saved);b.write(entries(row(at+1)));
  assert.equal(rawRead(b.list('v3')).filter(r=>r.outputType==='V3_IMMUTABLE_PAYLOAD').length,require('../lib/v34bCodec').encode(row()).definitions.length);assert.equal(b.status().budgetSkippedRecords,7);
  assert.equal(b.status().capturePausedUntil,at+HOUR);
});
test('full terminal outcome retains a long funding ledger within the separate bounded trade row limit',t=>{
  const a=new Archive(tmp(t)),events=Array.from({length:199},(_,i)=>({at:at+i*60000,rate:.0001,charge:.01,ambiguous:false,applied:.01}));
  a.write([{channel:'trades',row:{capturedAt:at,transitions:['FUNDING_FINALIZED'],trade:{status:'CLOSED',fundingEvents:events,netPnl:3}}}]);
  const r=read(a.list('trades'))[0];assert.deepEqual(r.trade.fundingEvents,events);assert.equal(r.trade.netPnl,3);
});
test('research manifest hashes bounded compressed blocks without mixing V3 into V2 health maps',async t=>{
  const a=new Archive(tmp(t));a.write(entries({...row(),processBootId:'v3-only',scanId:'v3-scan'}));
  const f=a.list('v3')[0],plan={file:f.path,size:f.size,relativePath:'v3-shadow-compact-v1/'+path.basename(f.path)};
  const m=require('../lib/researchManifest')._test,info=await m.inspectFile(plan);
  assert.equal(info.compression,'gzip');assert.equal(info.rowCount,rawRead(a.list('v3')).length);assert.equal(info.malformedRows,0);assert.equal(info.bytes,f.size);
  const rows=[];await m.visitJsonLines(plan,r=>rows.push(r));assert.equal(require('../lib/v34bCodec').decode(rows)[0].scanId,'v3-scan');
  const health=await m.buildResearchHealth([plan],at+1);assert.equal(health.restarts.bootCount,0);assert.equal(health.scans.observedScanIds,0);
});
test('fresh compact cohort preserves legacy evidence and imports active model trades only',t=>{
  const root=tmp(t),legacy=path.join(root,'legacy');fs.mkdirSync(legacy);
  const evidence=path.join(legacy,'v3-2026-09-30-10.jsonl');fs.writeFileSync(evidence,'preserved');
  fs.writeFileSync(path.join(legacy,'checkpoint.json'),JSON.stringify({counts:{v3:500},index:[['old',{}]],activeTrades:[['trade',{tradeId:'trade',status:'PENDING'}]]}));
  const j=new ShadowJournal(path.join(root,'compact'),{legacyDir:legacy});assert.equal(j.counts.v3,0);assert.equal(j.index.size,0);
  assert.equal(j.activeTrades.get('trade').originCaptureCohort,'LEGACY_PRE_COMPACT');assert.equal(fs.readFileSync(evidence,'utf8'),'preserved');
  assert.equal(j.legacySizeBytes,9);assert.equal(j.status().executionAllowed,false);
});
test('minute tracking retains only five-minute MARK samples and always keeps terminal transitions; summary stays small',t=>{
  const j=new ShadowJournal(tmp(t)),trade={tradeId:'test',status:'OPEN',lastBarAt:at,geometry:{}};
  j.tradeEvent(trade,['MARK'],at);j.tradeEvent(trade,['MARK'],at+60000);assert.equal(j.counts.trades,1);
  j.tradeEvent(trade,['MARK'],at+300000);j.tradeEvent({...trade,status:'CLOSED'},['CLOSED'],at+360000);assert.equal(j.counts.trades,3);
  for(let i=0;i<31;i++)j.archive.summaryHours['2026-09-'+String(i+1).padStart(2,'0')+'-10']={v3:2000,v2:2000,ai:100,trades:400,accepted:32,rejected:1968};
  assert.ok(Buffer.byteLength(JSON.stringify(j.summary(),null,2))<16384);
});
