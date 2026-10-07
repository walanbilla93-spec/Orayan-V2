'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const {Capture}=require('../lib/minimalCapture'),reset=require('../lib/startupCaptureReset'),risk=require('../lib/risk');
function tmp(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'orayan-minimal-test-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
test('10,000 unchanged candidate/no-event observations append once and restart keeps IDs/dedupe',t=>{
 const d=tmp(t),c=new Capture(d,{epochId:'E'});for(let i=0;i<10000;i++)c.emit('decision_episode',{at:Date.now(),sourceEpisodeId:'S',symbol:'BTCUSDT',mode:'SHADOW'},{key:'S',signature:'same'});
 assert.equal(c.state.acceptedRows,1);const before=fs.readFileSync(c.file);const again=new Capture(d);assert.equal(again.state.epochId,'E');assert.equal(again.emit('decision_episode',{sourceEpisodeId:'S'},{key:'S',signature:'same'}),false);assert.deepEqual(fs.readFileSync(c.file),before);
 const row=JSON.parse(fs.readFileSync(path.join(d,c.state.segments[0].name),'utf8'));assert.equal(row.episodeId,'E:S');assert.equal(row.eventId,'E:1');
});
test('rotation, priority reserve, hard caps, explicit loss and exact population reconciliation',t=>{
 const c=new Capture(tmp(t),{limits:{rowBytes:1000,segmentBytes:450,dailyBytes:1800,reserveBytes:600,totalBytes:2400}});
 for(let i=0;i<20;i++)c.emit('decision_episode',{symbol:'BTCUSDT',payload:'x'.repeat(30)});
 assert.ok(c.state.segments.length>1);assert.ok(c.state.retainedBytes<=1200);assert.ok(c.state.lostRows>0);const rows=c.state.acceptedRows;
 c.emit('trade_lifecycle',{tradeId:'T',status:'CLOSED',mode:'SHADOW'},{priority:true});assert.equal(c.state.acceptedRows,rows+1);assert.equal(c.status().reconciliation,true);assert.equal(c.status().populationComplete,false);
 assert.ok(c.state.segments.every(s=>s.bytes<=450));
});
test('oversized row is rejected with durable health rather than throwing into trading logic',t=>{
 const c=new Capture(tmp(t),{limits:{rowBytes:300}});assert.equal(c.emit('decision_episode',{data:'x'.repeat(400)}),false);assert.equal(c.state.lostRows,1);assert.equal(new Capture(c.dir).state.lastError.code,'ROW_CAP');
});
test('WAL restart is idempotent both before and after payload append',t=>{
 for(const appended of [false,true]){const d=path.join(tmp(t),String(appended)),c=new Capture(d,{epochId:'E'});c.emit('trade_lifecycle',{tradeId:'T'});
   const line=fs.readFileSync(path.join(d,c.state.segments[0].name),'utf8'),after=JSON.parse(fs.readFileSync(c.file)),segment=c.state.segments[0].name;
   fs.writeFileSync(c.file,JSON.stringify({...after,sequence:0,acceptedRows:0}));if(!appended)fs.writeFileSync(path.join(d,segment),'');
   fs.writeFileSync(c.pending,JSON.stringify({sequence:1,segment,offset:0,line,after}));const restored=new Capture(d);assert.equal(restored.state.acceptedRows,1);assert.equal(fs.readFileSync(path.join(d,segment),'utf8'),line);assert.equal(fs.existsSync(c.pending),false);
 }
});
test('repetitive health is bucketed, bounded and exported with count/last occurrence',t=>{
 const c=new Capture(tmp(t));const at=Date.now();for(let i=0;i<10000;i++)c.health('COOLDOWN_ACTIVE',{subsystem:'BYBIT',at:at+1});assert.equal(c.state.acceptedRows,1);assert.equal(c.status().healthBuckets[0].count,10000);c.export();assert.equal(new Capture(c.dir).status().healthBuckets[0].count,10000);
});
test('retention cannot disguise its retained subset as the entire population',t=>{
 const c=new Capture(tmp(t),{limits:{retentionDays:1}});const now=Date.now();c.emit('decision_episode',{at:now-3*86400000});c.emit('decision_episode',{at:now});assert.equal(c.state.acceptedRows,2);assert.equal(c.state.retainedRows,1);assert.equal(c.state.prunedRows,1);assert.equal(c.status().retentionStatus,'SUBSET_RETAINED');
});
test('metadata inventory rejects unknown files and symlinks before deletion',t=>{
 const root=tmp(t);fs.mkdirSync(path.join(root,'research-v2'));fs.writeFileSync(path.join(root,'research-v2','customer-data.json'),'protected');assert.throws(()=>reset.inventory(root),/UNKNOWN_CAPTURE_FILE/);assert.equal(fs.readFileSync(path.join(root,'research-v2','customer-data.json'),'utf8'),'protected');
});
test('trade safety isolation preserves exact daily/consecutive breaker results, including new outcomes and day rollover',()=>{
 const settings={cbEnabled:true,cbMaxConsecLosses:4,cbDailyLossUsdt:3,cbCooldownMin:120},now=Date.now();
 for(let seed=0;seed<100;seed++){
  const original=Array.from({length:40},(_,i)=>({id:'remove-'+i,symbol:'X',status:i%7?'CLOSED':'EXPIRED',closedAt:now-i*60000-(seed%2?86400000:0),netPnl:((seed*17+i*3)%13-7)/7}));
  const b=reset.safetyBaseline(original);assert.ok(b.closed.every(x=>Object.keys(x).sort().join(',')==='closedAt,index,netPnl'));
  for(const tail of [[],[{status:'CLOSED',closedAt:now+60000,netPnl:1}],[{status:'CLOSED',closedAt:now+60000,netPnl:-4}]]){
   const expected=risk.checkCircuitBreakers({settings,state:{},closedTrades:[...original.filter(x=>x.status==='CLOSED'),...tail]});
   const actual=risk.checkCircuitBreakers({settings,state:{},closedTrades:[...b.closed,...tail]});assert.deepEqual(actual,expected);
  }
 }
 assert.throws(()=>reset.safetyBaseline([{status:'OPEN'}]),/ACTIVE_EXECUTION_POSITION/);
});
function resetFixture(root){const write=(name,j)=>fs.writeFileSync(path.join(root,name),JSON.stringify(j));write('settings.json',{riskUsdtPerTrade:.1});write('symbolStats.json',{X:{blockedUntil:123}});write('trades.json',[{id:'OLD',status:'CLOSED',closedAt:Date.now(),netPnl:-1}]);write('marciShadowTrades.json',[{id:'WORKING',status:'OPEN',engine:'MARCI_SHADOW',mode:'paper'},{id:'CLOSED',status:'CLOSED'}]);write('engineControl.json',{desiredRunning:false});write('capture-reset-request.json',{schemaVersion:'ORAYAN_MINIMAL_CAPTURE_V1',epochId:'NEW',planSha256:'frozen',expectedMode:'paper',resumeEngine:true});fs.mkdirSync(path.join(root,'research-v2'));fs.writeFileSync(path.join(root,'research-v2','compact-2026-10-07-21.jsonl'),'old payload');}
test('allowlisted reset wipes captured history, retains safety/active working state and starts one clean epoch',t=>{
 const root=tmp(t);resetFixture(root);const settings=fs.readFileSync(path.join(root,'settings.json')),receipt=reset.run(root);assert.equal(receipt.complete,true);assert.ok(receipt.clearedBytes>0);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'trades.json'))),[]);
 assert.deepEqual(fs.readFileSync(path.join(root,'settings.json')),settings);assert.equal(JSON.parse(fs.readFileSync(path.join(root,'marciShadowTrades.json'))).length,1);assert.equal(JSON.parse(fs.readFileSync(path.join(root,'captureSafetyClosed.json'))).closed[0].netPnl,-1);assert.equal(fs.existsSync(path.join(root,'research-v2','compact-2026-10-07-21.jsonl')),false);assert.equal(reset.run(root).requested,false);
});
test('reset resumes a partly deleted scope without losing protected safety or changing the epoch',t=>{
 const root=tmp(t);resetFixture(root);const original=fs.unlinkSync;let deleted=false;fs.unlinkSync=function(file){if(!deleted&&file.endsWith('trades.json')){deleted=true;throw Error('TEST_CRASH');}return original.call(fs,file);};
 try{assert.throws(()=>reset.run(root),/TEST_CRASH/);}finally{fs.unlinkSync=original;}
 assert.ok(fs.existsSync(path.join(root,'capture-reset-progress.json')));const receipt=reset.run(root);assert.equal(receipt.epochId,'NEW');assert.equal(receipt.safetyTuples,1);assert.equal(receipt.preservedMarciWorkingPositions,1);assert.equal(fs.existsSync(path.join(root,'capture-operational-marci.json')),false);
});
test('LIVE mode and active main positions block the entire reset before any deletion',t=>{
 for(const scenario of ['LIVE','ACTIVE']){const root=tmp(t);resetFixture(root);fs.writeFileSync(path.join(root,scenario==='LIVE'?'settings.json':'trades.json'),JSON.stringify(scenario==='LIVE'?{mode:'live'}:[{status:'OPEN'}]));assert.throws(()=>reset.run(root),/RESET_BLOCKED/);assert.equal(fs.readFileSync(path.join(root,'research-v2','compact-2026-10-07-21.jsonl'),'utf8'),'old payload');}
});
test('worker isolates writer I/O, suppresses no-event repeats and returns exact export watermarks',async t=>{
 const {CaptureProxy}=require('../lib/captureProxy'),c=new CaptureProxy(tmp(t),{epochId:'ASYNC'});t.after(()=>c.close().catch(()=>{}));await c.flush();
 for(let i=0;i<10000;i++)c.emit('decision_episode',{sourceEpisodeId:'S',symbol:'X',mode:'SHADOW'},{key:'same',signature:'same'});
 const s=await c.flush();assert.equal(s.acceptedRows,1);assert.equal(s.pendingRows,0);const e=await c.export();assert.equal(e.watermark,'ASYNC:1');assert.equal(e.files.length,1);
 const before=fs.statSync(e.files[0].path).size;await c.flush();assert.equal(fs.statSync(e.files[0].path).size,before);
});
test('disk failure remains isolated from trading caller and makes incompleteness explicit',async t=>{
 const {CaptureProxy}=require('../lib/captureProxy'),dir=tmp(t),c=new CaptureProxy(dir,{epochId:'FAIL'});t.after(()=>c.close().catch(()=>{}));await c.flush();fs.rmSync(dir,{recursive:true,force:true});
 assert.doesNotThrow(()=>c.emit('trade_lifecycle',{tradeId:'T',mode:'PAPER'},{priority:true}));await c.flush();assert.equal(c.status().populationComplete,false);assert.equal(c.status().lostRows,1);
});
