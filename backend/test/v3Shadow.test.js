'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync}=require('child_process');
const {validateClosedCandles,confirmedPivots,trendPermission,positionSideTotals}=require('../lib/v3Contracts');
const level=require('../lib/v3Levels');
const {evaluate,ShadowJournal,BENCHMARK}=require('../lib/v3Shadow');
const fork=require('../lib/signals_trend_v30');
const root=path.resolve(__dirname,'../..'),ms=900000,origin=Date.now()-200*ms;
function candles(count=100){return Array.from({length:count},(_,i)=>({ts:origin+i*ms,open:100+i*.15,
  high:101+i*.15,low:99+i*.15,close:100.4+i*.15,volume:100+i,turnover:10000}));}
function row(at=Date.now()){return {version:'test',configHash:'frozen',symbol:'TESTUSDT',side:'BUY',decisionAt:at,
  closedBarOpenAt:at-ms,regime:'BULL_TREND',rejectReason:'GEOMETRY_STAGE_NOT_IMPLEMENTED',v3Decision:'REJECT',
  v2Decision:[{candidateId:'v2-test',side:'BUY',passed:true,failed:[]}],research:{selected:{id:'support'},reaction:{state:'RECLAIM'}}};}
function sandbox(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orayan-v3-owned-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}

test('closed candle contract rejects forming, duplicates, gaps and invalid OHLC',()=>{
  const c=candles(7),at=c.at(-1).ts+ms;
  assert.equal(validateClosedCandles(c,ms,at),null);
  assert.equal(validateClosedCandles(c,ms,at-1),'INVALID_CLOSED_CANDLE');
  assert.equal(validateClosedCandles([...c,c.at(-1)],ms,at),'INVALID_CLOSED_CANDLE');
  assert.equal(validateClosedCandles(c.filter((_,i)=>i!==3),ms,at),'CANDLE_GAP');
  assert.equal(validateClosedCandles(c.map((x,i)=>i===2?{...x,high:0}:x),ms,at),'INVALID_CLOSED_CANDLE');
});
test('V3.0 includes newest width-two confirmed pivot and explicit confirmation clock',()=>{
  const c=candles(7).map((x,i)=>({...x,high:[5,6,7,6,8,6,5][i],low:[4,3,3,4,2,3,4][i]}));
  const p=confirmedPivots(c,2,ms);
  assert.equal(p.highs.at(-1).i,4);assert.equal(p.lows.at(-1).i,4);
  assert.equal(p.highs.at(-1).knownAt,c[6].ts+ms);
  assert.equal(fork.recentSwings(c).lastHigh.i,4);
  assert.equal(confirmedPivots(c.slice(0,-1),2,ms).highs.some(p=>p.i===4),false);
});
test('V3.0 fork differs from frozen V2 only in pivot contract and test export',()=>{
  let v3=fs.readFileSync(path.join(root,'backend/lib/signals_trend_v30.js'),'utf8');
  v3=v3.replace('// V3.0 isolated engineering ablation. Frozen V2 file remains unchanged.\n','')
    .replace('const end = candles.length; // V3.0: marketData already supplies closed candles',
      'const end = candles.length - 1; // exclude forming bar from confirmation side').replace('  recentSwings,\n','');
  assert.equal(v3,fs.readFileSync(path.join(root,'backend/lib/signals_trend.js'),'utf8').replace(/\r\n/g,'\n'));
});
test('V3.1 true-trend permission is isolated and denies bullish range continuation',()=>{
  assert.equal(trendPermission('BULL_RANGE','BUY'),false);
  assert.equal(trendPermission('BULL_TREND','BUY'),true);
  assert.equal(trendPermission('BEAR_TREND','SELL'),true);
  for(const regime of ['BEAR_RANGE','CHOP','UNKNOWN'])assert.equal(trendPermission(regime,'SELL'),false);
  assert.equal(require('../lib/signals_trend').regimeAllows('BULL_RANGE','BUY'),true);
});
test('liquidation interpretation is position-side and excludes unavailable/future events',()=>{
  const rows=[{side:'Buy',timestamp:10,receivedAt:11,notional:20},{side:'Sell',timestamp:12,receivedAt:13,notional:7},
    {side:'Buy',timestamp:14,receivedAt:25,notional:100},{side:'Sell',timestamp:22,receivedAt:15,notional:100}];
  const r=positionSideTotals(rows,0,30,20);
  assert.equal(r.longNotional,20);assert.equal(r.shortNotional,7);
});
test('profile conserves volume and distinguishes OHLCV proxy from actual delta',()=>{
  const c=candles(20),p=level.profile(c);
  assert.ok(Math.abs(p.totalVolume-c.reduce((a,c)=>a+c.volume,0))<1e-8);
  assert.ok(p.price>=p.zoneLow&&p.price<=p.zoneHigh);assert.equal(level.profile(c.map(x=>({...x,volume:0}))),null);
});
test('a reaction cannot borrow a level confirmed during that reaction candle',()=>{
  const c=candles(7).at(-1),l={knownAt:c.ts+ms,active:true,zoneLow:c.low,zoneHigh:c.high,touchCount:0};
  assert.equal(level.reaction(l,c,c.low,'BUY',ms).state,'INELIGIBLE');
  const r=level.reaction({...l,knownAt:c.ts}, {...c,open:c.high+1,close:c.high+2},c.high+1,'BUY',ms);
  assert.equal(r.rejection,true);assert.equal(r.at,c.ts+ms);
});
test('BOS/POC-anchored OB exists before retest and exposes proxy volume and invalidation',()=>{
  const h=[10,11,14,12,11,13,16,17,17],lo=[7,8,11,9,8,10,13,13,12],cl=[9,10,13,11,10,12,15,16,16];
  const c=h.map((high,i)=>({ts:origin+i*ms,open:i===8?16:cl[i]-.5,high,low:lo[i],close:cl[i],volume:100}));
  const result=level.measure({candles:c,side:'BUY',price:16,intervalMs:ms,decisionAt:c.at(-1).ts+ms});
  const ob=result.levels.find(l=>l.type==='ORDER_BLOCK'&&l.direction==='BUY');
  assert.ok(ob);assert.ok(ob.knownAt<=c.at(-1).ts);assert.equal(ob.volumeContext.actualTakerDelta,null);
  assert.equal(ob.reaction.rejection,true);assert.equal(ob.invalidationPrice,ob.zoneLow);
});
test('premium/discount has causal range, midpoint, outside-range percentile and no gate',()=>{
  const range={low:100,high:200,knownAt:10};
  const r=level.premiumDiscount(range,125,'BUY',20);
  assert.equal(r.pricePercentile,25);assert.equal(r.equilibrium,150);assert.equal(r.directionRelative,'LONG_DISCOUNT');
  assert.equal(r.rangeAgeMs,10);assert.equal(r.researchOnly,true);
  assert.equal(level.premiumDiscount(range,250,'SELL',20).pricePercentile,150);
  assert.equal(level.premiumDiscount(range,125,'BUY',9).classification,'UNAVAILABLE');
});
test('V3 evaluates without V2 candidate, never exposes execution and keeps geometry unknown',()=>{
  const c=candles(),at=c.at(-1).ts+ms;
  const args={symbol:'TESTUSDT',candles:c,ticker:{markPrice:115},btcRegime:{regime:'BULL_RANGE'},
    settings:{timeframe:'15',minTrendStrength:0},decisionAt:at};
  const before=JSON.stringify(args),r=evaluate(args);
  assert.equal(JSON.stringify(args),before);assert.equal(r.executionAllowed,false);
  assert.equal(r.rejectReason,'V3.1_TREND_REGIME_NOT_PERMITTED');assert.equal(r.geometry.objectivePrice,null);
  assert.ok(r.research.profile);assert.deepEqual(r.v2Decision,[]);
});
test('immutable birth/current clocks survive restart; same-bar scans dedupe and config separates cohorts',t=>{
  const dir=sandbox(t),j=new ShadowJournal(dir),at=Date.now();
  j.record(row(at),'scan',at,at+5);j.record(row(at),'scan2',at,at+6);assert.equal(j.counts.v3,1);
  j.checkpointAndPrune(at);
  const restored=new ShadowJournal(dir);restored.record({...row(at+ms),closedBarOpenAt:at},'scan3',at+ms,at+ms+5);
  const lines=restored.files('v3').flatMap(f=>fs.readFileSync(f.path,'utf8').trim().split('\n').map(JSON.parse));
  assert.equal(lines[1].kind,'candidate_update');assert.equal(lines[1].firstBirthAt,at);
  assert.equal(lines[1].currentUpdateAt,at+ms);assert.equal(lines[1].capturedAt,at+ms+5);
  restored.record({...row(at+ms+1),configHash:'changed'},'scan4',at+ms+1,at+ms+6);
  assert.equal(restored.recent.at(-1).kind,'candidate_birth');
});
test('append failures do not advance birth state; checkpoint stays bounded',t=>{
  const j=new ShadowJournal(sandbox(t));const original=j.append.bind(j);
  j.append=()=>{throw Error('disk full');};assert.throws(()=>j.record(row(),'scan',Date.now()));assert.equal(j.index.size,0);
  j.append=original;
  for(let i=0;i<1200;i++)j.record({...row(),symbol:'S'+i},'stress',Date.now());
  assert.equal(j.index.size,512);assert.equal(j.recent.length,24);
  j.checkpointAndPrune();assert.ok(fs.statSync(j.checkpoint).size<1024*1024);
});
test('exports use fixed file watermarks; only V3 files are selected; invalid channel rejected',t=>{
  const j=new ShadowJournal(sandbox(t));j.record(row(),'scan',Date.now());
  const r=j.export('v3');assert.equal(r.__files,true);assert.ok(r.files.every(f=>path.basename(f.path).startsWith('v3-')));
  const initial=r.files[0].size;j.record(row(Date.now()+ms),'scan2',Date.now());
  assert.equal(r.files[0].size,initial);assert.throws(()=>j.export('../secrets'));
});
test('AI annotations read incrementally, redact secrets, and never become deterministic inputs',t=>{
  const dir=sandbox(t),j=new ShadowJournal(path.join(dir,'v3')),file=path.join(dir,'ai.jsonl');
  j.record(row(),'scan',Date.now());fs.writeFileSync(file,'');j.observeAI('Alibaba',file);
  process.env.V3_TEST_SECRET='test-private-key-12345';t.after(()=>delete process.env.V3_TEST_SECRET);
  fs.appendFileSync(file,JSON.stringify({record_type:'SHADOW_DECISION',candidate_id:'v2-test',model:'qwen',status:'OK',
    available_to_system_at_utc:new Date().toISOString(),decision:{decision:'TAKE',rationale_short:'test-private-key-12345'}})+'\n');
  j.observeAI('Alibaba',file);j.observeAI('Alibaba',file);
  assert.equal(j.counts.ai,1);const text=fs.readFileSync(j.files('ai')[0].path,'utf8'),r=JSON.parse(text);
  assert.equal(text.includes('test-private-key-12345'),false);assert.equal(r.agreedWithV2,true);
  assert.equal(r.agreedWithV3,null);assert.equal(r.executionAuthority,false);
});
test('V2 strategy/execution/settings and AI modules are byte-identical to benchmark',()=>{
  for(const file of ['signals.js','signals_trend.js','signals_structure.js','gates.js','risk.js','executor.js','settings.js',
    'marketData.js','groqShadowProducer.js','alibabaShadowProducer.js']) {
    const relative='backend/lib/'+file;
    const frozen=execFileSync('git',['show',`${BENCHMARK}:${relative}`],{cwd:root}).toString().replace(/\r\n/g,'\n');
    assert.equal(fs.readFileSync(path.join(root,relative),'utf8').replace(/\r\n/g,'\n'),frozen,file);
  }
  const frozen=execFileSync('git',['show',`${BENCHMARK}:backend/lib/engine.js`],{cwd:root}).toString().replace(/\r\n/g,'\n');
  const current=fs.readFileSync(path.join(root,'backend/lib/engine.js'),'utf8').replace(/\r\n/g,'\n')
    .replace("const v3Shadow = require('./v3Shadow');\n",'').replace(/    \/\/ V3_BEGIN:[\s\S]*?    \/\/ V3_END:[^\n]*\n/,'');
  assert.equal(current,frozen);
});
test('V5 forward-label clock excludes path minutes before physical capture',()=>{
  const capture=require('../lib/researchCapture');
  const birth={at:60000,decisionAt:61000,capturedAt:190000,market:{markPrice:100},plannedEntry:100,plannedSl:90,plannedTp:120,
    trendMomentum:{atr14:1},side:'BUY'};
  const label=capture.computeForwardLabel(birth,[{ts:120000,low:80,high:130,close:110},{ts:240000,low:101,high:105,close:104}]);
  assert.equal(label.evaluatedFromAt,240000);assert.equal(label.labelOriginAt,190000);
  assert.equal(label.plannedEntryTouched,false);assert.equal(label.barsEvaluated,1);
});
