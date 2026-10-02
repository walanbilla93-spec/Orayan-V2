'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),z=require('zlib');
const {execFileSync}=require('child_process');
const m=require('../lib/v34Measurements'),r=require('../lib/v34Trades'),c=require('../lib/v3Trades'),g=require('../lib/v3Geometry');
const {ShadowJournal,evaluate}=require('../lib/v3Shadow'),{Archive,MAX_BYTES,HOUR_BYTES}=require('../lib/v3Archive'),{compact}=require('../lib/v3Compact');
const root=path.resolve(__dirname,'../..'),at=120*60000;
const bar=(ts,p=100,h=p+1,l=p-1,close=p)=>({ts,open:p,high:h,low:l,close,volume:10,turnover:1000});
const bars=(n=80,tf=60000)=>Array.from({length:n},(_,i)=>bar(at-(n-i)*tf,100+i*.1));
function trade(side='BUY',target=120) {
  const stop=side==='BUY'?90:110,targetPrice=side==='BUY'?target:80;
  const costs={entryFeePct:.055,exitFeePct:.055,entrySlippageBps:3,stopSlippageBps:3,targetThroughBps:1,tickSize:.01};
  const geometry={policy:g.POLICY,entryPrice:100,invalidationPrice:stop,objectivePrice:targetPrice,costs,
    tickSize:.01,qtyStep:.001,minOrderQty:.001,maxOrderQty:1000,minCostAdjustedRR:1,
    entryWindowMin:5,maxHoldMin:20,sizing:{riskUsdt:1,maxNotionalUsdt:1000},
    reactionLevel:{id:'s',type:'SWING_LOW',price:95,zoneLow:95,zoneHigh:95,knownAt:0}};
  const t=c.create({geometry,side,symbol:'TESTUSDT',decisionAt:at,candidateId:'candidate',episodeId:'episode',version:'frozen'},'trade',at+1);
  const measurement={noise:{cutoff:at-900000},nearestObjective:{price:targetPrice,policy:'NEAREST_ADMISSIBLE_INDEPENDENT_V1',identicalToControl:true}};
  t.research34=r.init(t,measurement);return t;
}
function strip(t){const {research34,controlFingerprint,episodeAdmissionOrdinal,...rest}=t;return rest;}
function tmp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orayan-v34-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('V3.3 decision evaluator and core modules are frozen byte for byte',()=>{
  for(const f of ['v3Contracts.js','v3Levels.js','v3Geometry.js','v3Trades.js','signals_trend_v30.js','v3Benchmark.json']){
    const baseline=execFileSync('git',['show','1b15cc5:backend/lib/'+f],{cwd:root}).toString().replace(/\r\n/g,'\n');
    assert.equal(fs.readFileSync(path.join(root,'backend/lib',f),'utf8').replace(/\r\n/g,'\n'),baseline,f);
  }
  const old=execFileSync('git',['show','1b15cc5:backend/lib/v3Shadow.js'],{cwd:root}).toString().replace(/\r\n/g,'\n');
  assert.equal(evaluate.toString().replace(/\r\n/g,'\n'),old.slice(old.indexOf('function evaluate('),old.indexOf('\n\nclass ShadowJournal')));
});
test('control fingerprint is stable and stamped without new execution authority',()=>{
  const ctl=require('../lib/v34Control');assert.equal(ctl.fingerprint.length,64);assert.equal(ctl.executionAllowed,false);
  assert.equal(ctl.baselineCommit,'1b15cc5bebd48e4dc739e051254e36ed6dc7469e');
});
test('ATR1m/TR20/RV20 exclude forming, reaction, future and missing minute samples',()=>{
  const bs=bars(),cutoff=at-15*60000,n=m.noise({minuteBars:bs,bars15:bars(30,900000),cutoff});
  assert.equal(n.lastReturnAt,cutoff);assert.equal(n.returns20.length,20);assert.equal(n.trueRangeNoise,2);assert.equal(n.atr1m,2);
  const contaminated=bs.map(b=>b.ts>=cutoff?{...b,high:1e10,close:1e8}:b);
  assert.deepEqual(m.noise({minuteBars:contaminated,bars15:bars(30,900000),cutoff}),n);
  assert.equal(m.noise({minuteBars:bs.filter(b=>b.ts!==cutoff-10*60000),cutoff}).returns20,null);
});
test('ATR15 is SMA14 of completed prior true ranges with exact cutoff',()=>{
  const b=bars(30,900000),n=m.noise({bars15:b,cutoff:at});assert.equal(n.atr15m,2);
  assert.equal(m.noise({bars15:b.slice(-14),cutoff:at}).atr15m,null);
});
test('quote availability checks physical/source timestamp order and never fabricates spread or depth',()=>{
  assert.equal(m.quote({bid:99,ask:101,receivedAt:at+1},at).spread,null);
  assert.equal(m.quote({bid:99,ask:101,receivedAt:at,sourceAt:at+6000},at).status,'UNAVAILABLE');
  assert.equal(m.quote({bid:99,ask:101,receivedAt:at-120001},at).status,'UNAVAILABLE');
  const q=m.quote({bid:99,ask:101,receivedAt:at,sourceAt:at-5},at);assert.equal(q.mid,100);assert.equal(q.spreadBps,200);assert.equal(q.depth,null);
  assert.equal(m.quote(null,at).bid,null);
});
test('stop normalization math and zero spread preserve null',()=>{
  const n=m.normalized(2,100,{atr1m:.5,atr15m:2,realizedNoisePrice:.25,trueRangeNoise:1},{spread:.1});
  assert.deepEqual(n,{price:2,pct:2,atr1m:4,atr15m:1,realizedVolatility:8,trueRange:2,spreads:20});
  assert.equal(m.normalized(2,100,{}, {spread:0}).spreads,null);
});
test('fill market move, adverse slippage, tick rounding reconcile exactly',()=>{
  for(const side of ['BUY','SELL']){
    const t=trade(side),b=bar(at+60000,100.123),out=r.step(t,[b],at+120000),f=out.trade.research34.fill;
    assert.ok(Math.abs(f.nextCompleteMinuteOpen+f.slippagePrice+f.tickRoundingPrice-f.modeledFill)<1e-12);
    assert.equal(f.modeledFill,out.trade.entryPrice);assert.equal(f.fillBidAskAvailable,false);assert.equal(f.quote.bid,null);
    assert.equal(f.geometryRecheck,true);assert.equal(out.trade.executionAllowed,false);
  }
});
test('gap flags and geometry cancellation are research observations only',()=>{
  const t=trade(),b=bar(at+60000,85),out=r.step(t,[b],at+120000).trade;
  assert.equal(out.status,'CANCELLED');assert.equal(out.research34.fill.gapThroughStop,true);assert.equal(out.research34.fill.geometryValid,false);
});
test('MFE/MAE and raw/cost thresholds have completed minute bounds and stable first-touch times',()=>{
  const t=trade(),b=bar(at+60000,100,111,98,108),out=r.step(t,[b],at+120000).trade;
  assert.equal(out.research34.mfeAt.earliestAt,b.ts);assert.equal(out.research34.maeAt.latestAt,b.ts+60000);
  assert.equal(out.research34.rawTouches[1].knownAt,b.ts+60000);
  const next=r.step(out,[bar(at+120000,108,115,107,112)],at+180000).trade;
  assert.deepEqual(next.research34.rawTouches[1],out.research34.rawTouches[1]);assert.equal(next.research34.mfeAt.barOpenAt,at+120000);
});
test('terminal stop minute preserves ambiguous touches and frozen lower-bound excursions',()=>{
  const t=trade(),b=bar(at+60000,100,121,89,101),out=r.step(t,[b],at+120000).trade;
  assert.equal(out.ambiguous,true);assert.equal(out.mfePerUnit,0);assert.equal(out.research34.mfeAt,null);
  assert.equal(out.research34.rawTouches[1],undefined);assert.equal(out.research34.terminalTouches['rawTouches:1'].ambiguous,true);
});
test('target endpoint proves threshold reached without inventing intraminute order',()=>{
  const t=trade(),out=r.step(t,[bar(at+60000,100,122,99,120)],at+120000).trade;
  assert.equal(out.outcome,'TARGET');assert.match(out.research34.rawTouches[1].precision,/ENDPOINT/);assert.equal(out.mfePerUnit,0);
});
test('ranked objectives use immutable knownAt, stable ranking and independent causal levels',()=>{
  const level=(id,price,knownAt=at-120000)=>({id,type:'SWING_HIGH',direction:'SELL',active:true,price,zoneLow:price,zoneHigh:price,knownAt});
  const row={side:'BUY',decisionAt:at,closedBarOpenAt:at-60000,geometry:{entryPrice:100,invalidationPrice:90,tickSize:.01,reactionLevel:{id:'support'},objectiveLevel:{id:'near'}},
    research:{levels:[level('far',130),level('future',101,at),level('near',120)]}};
  const inv=m.inventory(row,{});assert.equal(inv.length,2);assert.equal(inv[0].levelId,'near');assert.equal(inv[0].selectedControl,true);
  assert.equal(inv[0].knownAt,at-120000);assert.equal(inv[0].distance.rawR,2);
});
test('nearest arm isolated and full primary parity over random both-side paths, gaps and empty batches',()=>{
  let seed=13;const random=()=>((seed=(seed*1664525+1013904223)>>>0)/4294967296);
  for(let i=0;i<160;i++){
    const t=trade(i%2?'SELL':'BUY');t.research34.nearestArm.trade.geometry.objectivePrice=i%2?85:115;
    const bs=Array.from({length:8},(_,j)=>{const p=98+random()*4;return bar(at+(j+1)*60000,p,p+random()*25,p-random()*15,p);});
    const frozen=c.step(strip(t),i%7?bs:[],at+10*60000),observed=r.step(t,i%7?bs:[],at+10*60000);
    assert.deepEqual(strip(observed.trade),frozen.trade);assert.deepEqual(observed.events,frozen.events);
    assert.equal(observed.trade.executionAllowed,false);
  }
});
test('paired target/funding net R equals control when nearest objective equals control',()=>{
  const t=r.step(trade(),[bar(at+60000,100,122,99,121)],at+120000).trade;
  const out=r.funding(t,[{fundingRateTimestamp:at+60000,fundingRate:.001}],at+240000);
  assert.equal(out.research34.nearestArm.netR,out.realizedR);assert.equal(out.research34.nearestArm.trade.quantity,out.quantity);
});
test('OB POC spatial distance distinguishes presence from overlap and records widths',()=>{
  const s={price:100},ob={zoneLow:99,zoneHigh:101,knownAt:1},poc={zoneLow:103,zoneHigh:105,knownAt:2};
  const x=m.spatial(s,ob,poc,100,.1,{atr1m:2,atr15m:4});
  assert.equal(x.inventoryPresence,true);assert.equal(x.overlap,false);assert.equal(x.selectedToPoc.ticks,30);
  assert.equal(x.obToPoc.atr1m,1);assert.equal(x.poc.width,2);
  assert.equal(m.spatial(s,{...ob,zoneHigh:104},poc,100,.1,{}).overlap,true);
});
test('exact BOS join never infers a CHOCH or uses a late event',()=>{
  const row={symbol:'S',side:'BUY',decisionAt:at,closedBarOpenAt:at-60000,geometry:{reactionLevel:{type:'SWING_LOW'}}};
  assert.equal(m.exactEvent(row,{},[]).status,'UNAVAILABLE');
  const event={eventId:'exact',direction:'BUY',type:'CHOCH',knownAt:at-120000,receivedAt:at-1};
  assert.equal(m.decision(row,{structuralEvents:[event]}).structuralEvent.eventId,'exact');
  assert.equal(m.decision(row,{structuralEvents:[{...event,receivedAt:at+1}]}).structuralEvent.status,'UNAVAILABLE');
});
test('AI structured fields only come from returned fields; causal availability excludes late, stale and missing clocks',()=>{
  const rec={candidate_id:'c',requested_at_utc:at-60000,completed_at_utc:at-30000,available_to_system_at_utc:at-20000,status:'OK',
    decision:{confidence:.7,rationale_short:'continuation certain'}};
  const x=m.observer(rec,'Groq',at-10000,at);assert.equal(x.availabilityAtDecision,true);assert.equal(x.structured.continuation,undefined);
  assert.equal(m.observer(rec,'Groq',at+1,at).availabilityAtDecision,false);
  assert.equal(m.observer({...rec,available_to_system_at_utc:null},'Groq',at-1,at).availabilityAtDecision,false);
  assert.equal(m.observer(rec,'Groq',at-1,at+300000).availabilityAtDecision,false);
  assert.equal(x.executionAuthority,false);
});
test('direction normalized momentum/acceleration and volume baseline exclude latest bar',()=>{
  const b=bars(30,900000),buy=m.momentum(b,'BUY',at),sell=m.momentum(b,'SELL',at);
  assert.equal(buy.momentum3,-sell.momentum3);assert.equal(buy.acceleration,-sell.acceleration);
  assert.equal(buy.volumeShock,1);assert.equal(buy.turnoverShock,1);
});
test('break-even and progress are closed-bar measurements, path retained and no management action',()=>{
  const t=trade(),out=r.step(t,[bar(at+60000,100,112,99,110)],at+120000);
  assert.ok(out.trade.research34.breakEven.price>100);assert.equal(out.trade.research34.breakEven.firstClosedBarReach.precision,'BAR_CLOSE');
  assert.equal(out.path.length,1);assert.equal(out.trade.geometry.invalidationPrice,90);assert.equal(out.trade.geometry.objectivePrice,120);
});
test('error export redacts raw messages, includes fallback and survives restart',t=>{
  const dir=tmp(t),j=new ShadowJournal(dir);j.captureError(Error('Bearer SECRET https://private?token=abc'),{symbol:'S',subsystem:'QUOTE'});
  const text=z.gunzipSync(fs.readFileSync(j.files('errors')[0].path)).toString();assert.equal(text.includes('SECRET'),false);assert.equal(text.includes('private'),false);
  assert.match(text,/UNCLASSIFIED_CAPTURE_ERROR/);j.saveCheckpoint();const restored=new ShadowJournal(dir);
  assert.equal(restored.errorRecent.length,1);assert.equal(restored.counts.errors,1);
});
test('minute replay dedupe/cursor preserved through checkpoint and overlapping batches',t=>{
  const dir=tmp(t),j=new ShadowJournal(dir),a=r.step(trade(),[bar(at+60000)],at+120000).trade;
  j.activeTrades.set(a.tradeId,a);j.saveCheckpoint();const restored=new ShadowJournal(dir),b=restored.activeTrades.get(a.tradeId);
  assert.deepEqual(r.step(b,[bar(at+60000)],at+120000).trade,b);assert.equal(r.step(b,[bar(at+60000)],at+120000).path.length,0);
});
test('error and replay gzip channels have fixed export watermarks and enforce rolling budget',t=>{
  const dir=tmp(t),a=new Archive(dir,{hourBytes:500,maxBytes:1000}),now=Date.now();
  a.write([{channel:'errors',row:{capturedAt:now,eventId:'one'}}]);const snapshot=a.snapshot('errors');t.after(snapshot.cleanup);
  const before=fs.readFileSync(snapshot.files[0].path);a.write([{channel:'errors',row:{capturedAt:now,eventId:'two'}}]);
  assert.deepEqual(fs.readFileSync(snapshot.files[0].path),before);assert.ok(MAX_BYTES>31*HOUR_BYTES);
  assert.doesNotThrow(()=>a.write([{channel:'paths',row:{capturedAt:now,path:Array.from({length:100},(_,i)=>m.id([i,now]))}}]));assert.ok(a.status().priorityOverflowBytes>0);
});
test('measurement inventories use immutable definitions without repeated level bodies',()=>{
  const def={id:'L',type:'SWING_HIGH',knownAt:1,zoneLow:120,zoneHigh:120,price:120};
  const out=compact({measurement34:{objectiveInventory:[{levelId:'L',definition:def,knownAt:1}]}});
  assert.equal(out.definitions.filter(d=>d.outputType!=='V3_OBJECTIVE_INVENTORY_DEFINITION').length,1);
  assert.equal(out.row.measurement34.objectiveInventory,undefined);assert.ok(out.row.measurement34.inventoryDefinitionId);
});
test('asynchronous noise cache is bounded, yields failures and exposes only physically received samples',async()=>{
  const {MeasurementCache}=require('../lib/v34Cache'),cache=new MeasurementCache();cache.watch(['A','B','C','D','E'],false);
  let calls=0,errors=0;
  await cache.advance(async(p,q)=>{calls++;if(q.symbol==='B')throw Error('transport');return {result:{list:[[at-60000,100,101,99,100,10,1000]]},sourceAt:at-1,receivedAt:at};},()=>errors++,at);
  assert.equal(calls,4);assert.equal(errors,1);assert.equal(cache.get('A',false,at-1),null);assert.equal(cache.get('A',false,at).bars.length,1);
  assert.equal(cache.get('A',true,at),null);assert.equal(cache.busy,false);
});
test('maximum active and recent research state fits existing one MiB checkpoint',t=>{
  const j=new ShadowJournal(tmp(t)),tr=trade();
  tr.research34.decision.noise=m.noise({minuteBars:bars(),bars15:bars(30,900000),cutoff:at});
  tr.research34.decision.objectiveInventory=Array.from({length:12},(_,i)=>({levelId:'level'+i,definition:{id:'level'+i,type:'SWING_HIGH',knownAt:1,zoneLow:120+i,zoneHigh:120+i,price:120+i},distance:{pct:12,rawR:2,atr1m:2,atr15m:3}}));
  for(let i=0;i<32;i++){j.activeTrades.set('T'+i,{...tr,tradeId:'T'+i});j.recentTrades.push({...tr,tradeId:'R'+i});}
  j.saveCheckpoint();assert.ok(fs.statSync(j.checkpoint).size<1048576);
});
test('frontend syntax, measurement buttons and all download channels have server support',()=>{
  execFileSync(process.execPath,['--check','frontend/app.js'],{cwd:root});
  const html=fs.readFileSync(path.join(root,'frontend/index.html'),'utf8'),js=fs.readFileSync(path.join(root,'frontend/app.js'),'utf8');
  for(const button of ['btnExportV3Errors','btnExportV3Paths','btnExportV3Summary']){assert.ok(html.includes('id="'+button+'"'));assert.ok(js.includes("$('#"+button+"').addEventListener"));}
  const a=new ShadowJournal(fs.mkdtempSync(path.join(os.tmpdir(),'orayan-download-')));try{
    for(const channel of ['errors','paths']){const e=a.export(channel);assert.doesNotThrow(()=>z.gunzipSync(fs.readFileSync(e.files[0].path)));e.cleanup();}
    assert.equal(a.summary().control.executionAllowed,false);assert.ok(JSON.stringify(a.summary()).length<65536);
  }finally{fs.rmSync(a.dir,{recursive:true,force:true});}
});
test('compact control definitions retain complete parity proof through immutable references',()=>{
  const {compact}=require('../lib/v3Compact'),control=require('../lib/v34Control');
  const out=compact({control:{...control,configHash:'config',benchmarkConfigMatch:true}});
  assert.equal(out.row.control.configHash,'config');
  const d=out.definitions.find(x=>x.outputType==='V3_CONTROL_DEFINITION');
  assert.equal(out.row.control.definitionId,d.definitionId);
  assert.deepEqual(d.definition,control);
});
test('dense decision measurements fit candidate cap without discarding provenance',()=>{
  const {compact}=require('../lib/v3Compact');
  const measurement34={observers:{groq:{status:'AVAILABLE',promptVersion:'v'.repeat(9000)}},capturedAt:at};
  const out=compact({outputType:'V3_SHADOW_SIGNAL',symbol:'DENSE',measurement34});
  assert.ok(Buffer.byteLength(JSON.stringify(out.row))+1<=8192);
  const d=out.definitions.find(x=>x.definitionId===out.row.measurement34.definitionId);
  assert.equal(d.definition.kind,'FULL_DECISION_MEASUREMENT');
  assert.equal(d.definition.measurement34.observers.groq.promptVersion,measurement34.observers.groq.promptVersion);
  assert.equal(d.definition.measurement34.capturedAt,at);
});
