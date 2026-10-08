'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const {Capture}=require('../lib/minimalCapture'),reset=require('../lib/startupCaptureReset'),risk=require('../lib/risk');
function tmp(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'orayan-minimal-test-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
test('minimal comparison population survives restart without legacy hourly-cohort reset',t=>{
 const root=tmp(t),dir=path.join(root,'v3-shadow-compact-v1');fs.mkdirSync(dir);fs.writeFileSync(path.join(root,'capture-minimal-policy.json'),JSON.stringify({epochId:'E'}));
 const state={startedAt:1,cohortId:'E',validation:{captureRevision:'legacy'},episodes:{A:{admissions:2,firstFillAt:123}},admissions:{T:{episodeId:'A'}},armStats:{}};
 fs.writeFileSync(path.join(dir,'holdout-v34b.json'),JSON.stringify(state));const {Holdout}=require('../lib/v34bHoldout'),h=new Holdout(dir);assert.deepEqual(h.state,state);assert.equal(fs.readdirSync(dir).length,1);
});
test('paired native candidates retain V3 eligibility rejections without recording empty scans',()=>{
 const {meaningfulV3}=require('../lib/minimalCapture');assert.equal(meaningfulV3({side:null,directionPermission:false,v2Decision:[{candidateId:'N'}]}),true);
 assert.equal(meaningfulV3({side:'BUY',directionPermission:true,geometry:{reactionLevel:{id:'L'}}}),true);
 assert.equal(meaningfulV3({side:'BUY',directionPermission:false,v2Decision:[]}),false);assert.equal(meaningfulV3({}),false);
});
test('busy scan bursts preserve candidate and priority endpoints with bounded worker memory',async t=>{
 const {CaptureProxy}=require('../lib/captureProxy'),c=new CaptureProxy(tmp(t));await c.flush();
 for(let i=0;i<400;i++){c.nativeState('N'+i,{episodeId:'E'+i,at:Date.now()});assert.equal(c.emit('decision_episode',{sourceEpisodeId:'E'+i,symbol:'X'+i,mode:'PAPER'}),true);}
 assert.equal(c.emit('trade_lifecycle',{sourceEpisodeId:'E1',tradeId:'T',status:'CLOSED',mode:'PAPER'},{priority:true}),true);assert.ok(c.status().pendingBytes<=c.status().queueLimits.bytes);
 await c.flush();assert.equal(c.status().lostRows,0);assert.equal(c.status().acceptedRows,401);assert.equal(c.status().nativeContinuityEntries,400);await c.close();
});
test('health keeps compact data-loss flags while excluding raw exceptions',t=>{
 const c=new Capture(tmp(t));c.health({errorCode:'MISSING_PATH'},{subsystem:'TRADE_WORKER',permanentLoss:true,downstreamDecisionSkipped:true,rawPayload:'UNUSED'});
 const row=c.status().healthBuckets[0];assert.equal(row.permanentLoss,true);assert.equal(row.downstreamDecisionSkipped,true);assert.equal(row.rawPayload,undefined);
});
test('native episode continuity survives graceful restart without adding telemetry rows',async t=>{
 const {CaptureProxy}=require('../lib/captureProxy'),dir=tmp(t),c=new CaptureProxy(dir,{epochId:'CONTINUITY'});await c.flush();c.nativeState('NEW_ORAYAN|X|BUY|TREND',{at:Date.now(),signature:'S',episodeId:'PERSIST',originAt:1});await c.flush();await c.close();const next=new CaptureProxy(dir);await next.flush();assert.equal(next.state.nativeEpisodeIndex['NEW_ORAYAN|X|BUY|TREND'].episodeId,'PERSIST');assert.equal(next.status().acceptedRows,0);assert.equal(next.status().populationComplete,true);await next.close();
});
test('entry attempt freezes latest used features even when same-bar candidate refresh was suppressed',async t=>{
 const root=tmp(t),store=require('../lib/store'),old=store.DATA_DIR;store.DATA_DIR=root;t.after(()=>{store.DATA_DIR=old;});fs.writeFileSync(path.join(root,'capture-minimal-policy.json'),JSON.stringify({epochId:'ENTRY'}));
 const m=require('../lib/minimalCapture'),settings={mode:'paper',timeframe:'15'},base={decisionAt:Date.now(),episodeId:'E',candidateKey:'K',configHash:'C',passed:true,failedGates:[],engine:'NEW_ORAYAN',kind:'candidate_birth'},signal={id:'A',symbol:'X',side:'BUY',entry:100,sl:90,tp:120,score:50};
 const research=require('../lib/researchCapture'),futureSignal={id:'EARLY',symbol:'PAIRUSDT',side:'BUY',engine:'TREND',entry:100,sl:90,tp:120,gates:{passed:false,failed:['BTC'],checks:[]}},scanAt=Date.now();
 const preview=research.previewCandidateLink(futureSignal,scanAt,settings);assert.equal(research.candidateLink('EARLY'),null);
 m.observe('v3',{decisionAt:scanAt,episodeId:'PREVIEW',candidateId:'PREVIEW_V3',symbol:'PAIRUSDT',configHash:'C',v3Decision:'REJECT',v2Decision:[{candidateId:'EARLY',side:'BUY',passed:false,...preview}]});
 const actual=research.birth(futureSignal,{scanAt,scanId:'PAIR',settings,ticker:{markPrice:100},candles:[]});assert.equal(preview.nativeEpisodeId,actual.episodeId);assert.equal(preview.nativeConfigHash,actual.configHash);
 m.native(signal,{...base,signature:'A'},settings);m.native({...signal,id:'B',entry:101,score:51},{...base,kind:'candidate_update',signature:'B'},settings);
 m.nativeOutcome({at:Date.now(),episodeId:'E',candidateId:'B',engine:'NEW_ORAYAN',event:'ORDER_INTENT',signature:'INTENT',mode:'paper'},null);
 m.observe('v3',{decisionAt:Date.now(),episodeId:'V3',candidateId:'V3C',symbol:'X',side:null,configHash:'C',v3Decision:'REJECT',rejectReason:'REGIME_BLOCKED',v2Decision:[{candidateId:'B',side:'BUY',passed:true}]});
 for(let i=0;i<100;i++){
   m.native(signal,{...base,passed:false,failedGates:['BTC'],kind:'candidate_update'},settings);m.native(signal,{...base,kind:'candidate_update'},settings);
   m.observe('v3',{decisionAt:Date.now(),episodeId:'V3',candidateId:'V3D',symbol:'X',side:null,configHash:'C',v3Decision:'REJECT',rejectReason:'REGIME_BLOCKED',geometry:{entryPrice:101+i},v2Decision:[{candidateId:'B',side:'BUY',passed:true}]});
 }
 m.observe('trades',{capturedAt:Date.now(),transitions:['ADMITTED'],trade:{candidateId:'V3D',episodeId:'V3',tradeId:'VT',symbol:'X',status:'PENDING',geometry:{entryPrice:200}}});
 m.nativeOutcome({at:Date.now(),episodeId:'E',candidateId:'C',engine:'NEW_ORAYAN',event:'NO_ORDER',signature:'C',reason:'PORTFOLIO_OR_SLOT_LIMIT'},null);m.nativeOutcome({at:Date.now(),episodeId:'E',candidateId:'D',engine:'NEW_ORAYAN',event:'NO_ORDER',signature:'D',reason:'PORTFOLIO_OR_SLOT_LIMIT'},null);
 const c=m.current();await c.flush();const e=await c.export();const rows=e.files.flatMap(f=>fs.readFileSync(f.path,'utf8').trim().split('\n').map(JSON.parse));const entry=rows.find(r=>r.boundary==='ADMISSION_ATTEMPT');assert.equal(entry.geometry.entryPrice,101);assert.equal(entry.score,51);assert.equal(rows.filter(r=>r.stream==='decision_episode').length,7);assert.equal(rows.find(r=>r.sourceEpisodeId==='V3').pairedNativeEpisodes[0].episodeId,entry.episodeId);assert.equal(rows.find(r=>r.sourceEpisodeId==='PREVIEW').pairedNativeEpisodes[0].sourceEpisodeId,actual.episodeId);assert.equal(rows.find(r=>r.stream==='decision_episode'&&r.tradeId==='VT').geometry.entryPrice,200);assert.equal(rows.filter(r=>r.reasonCode==='PORTFOLIO_OR_SLOT_LIMIT').length,1);await c.close();
});
test('population excludes inherited trades and counts new admission/fill/terminal once across funding and restart',t=>{
 const c=new Capture(tmp(t));c.emit('trade_lifecycle',{tradeId:'OLD',status:'CLOSED',filledAt:1,inheritedWorkingState:true});c.emit('trade_lifecycle',{tradeId:'NEW',status:'PENDING',transitions:['ORDER_ACK']});c.emit('trade_lifecycle',{tradeId:'NEW',status:'CLOSED',filledAt:2});c.emit('trade_lifecycle',{tradeId:'NEW',status:'CLOSED',filledAt:2,fundingStatus:'FINAL'});
 assert.equal(c.state.admitted,1);assert.equal(c.state.filled,1);assert.equal(c.state.closed,1);assert.equal(c.state.inheritedClosed,1);const restored=new Capture(c.dir);restored.emit('trade_lifecycle',{tradeId:'NEW',status:'CLOSED',filledAt:2});assert.equal(restored.state.closed,1);
});
test('rejected quote noise is suppressed; new bar, gate change and eligible geometry still capture',()=>{
 const {nativeSignature}=require('../lib/minimalCapture'),signal={btcRegime:'BEAR_RANGE',gates:{checks:[{name:'BTC',enabled:true,pass:false}]}},row={episodeId:'E',configHash:'C',decisionAt:60000,passed:false,failedGates:['BTC'],signature:'old'},settings={timeframe:'15'};
 const first=nativeSignature(signal,row,settings);assert.equal(nativeSignature({...signal,entry:99,score:48},{...row,decisionAt:120000,signature:'quote-change'},settings),first);
 assert.notEqual(nativeSignature(signal,{...row,decisionAt:900000},settings),first);assert.equal(nativeSignature(signal,{...row,failedGates:['BTC','RR']},settings),first);assert.notEqual(nativeSignature(signal,{...row,failedGates:['RR']},settings),first);
 assert.equal(nativeSignature(signal,{...row,passed:true,signature:'A'},settings),nativeSignature(signal,{...row,passed:true,signature:'B'},settings));assert.notEqual(nativeSignature(signal,{...row,passed:true},settings),first);
});
test('space retention rotates old segments while durable full-population counts remain exact',t=>{
 const c=new Capture(tmp(t),{limits:{segmentBytes:500,totalBytes:1200,dailyBytes:50000,reserveBytes:0}});for(let i=0;i<10;i++)c.emit('decision_episode',{sourceEpisodeId:String(i),mode:'PAPER'});
 assert.equal(c.state.acceptedRows,10);assert.equal(c.state.lostRows,0);assert.ok(c.state.retainedBytes<=1200);assert.ok(c.state.prunedRows>0);assert.equal(c.state.acceptedRows,c.state.retainedRows+c.state.prunedRows);assert.equal(c.status().retentionStatus,'SUBSET_RETAINED');
});
test('interrupted rotation or missing segment cannot masquerade as a complete retained population',t=>{
 const c=new Capture(tmp(t));c.emit('decision_episode',{mode:'PAPER'});fs.unlinkSync(path.join(c.dir,c.state.segments[0].name));const restart=new Capture(c.dir);assert.equal(restart.state.acceptedRows,1);assert.equal(restart.state.missingRows,1);assert.equal(restart.state.retainedRows,0);assert.equal(restart.state.populationComplete,false);
});
test('management captures first prespecified milestones once without raw minute paths',t=>{
 const c=new Capture(tmp(t),{epochId:'M'}),trade={tradeId:'T',episodeId:'E',research34:{managementPolicy:'FROZEN',breakEven:{price:101,firstClosedBarReach:{knownAt:100,precision:'BAR_CLOSE'}},structuralProgress:{knownAt:200,levelId:'L',price:102}}};
 for(let i=0;i<100;i++)require('../lib/minimalCapture').management(c,trade,300+i);
 assert.equal(c.state.acceptedRows,2);const rows=fs.readFileSync(path.join(c.dir,c.state.segments[0].name),'utf8').trim().split('\n').map(JSON.parse);assert.ok(rows.every(r=>r.stream==='management_path'&&r.hypothetical&&!r.bars));
});
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
