'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const {once}=require('events');
const producer=require('../lib/alibabaShadowProducer');
const shadowExport=require('../lib/alibabaShadowExport');
const store=require('../lib/store');
const ledger=require('../../research/alibaba-shadow/src/ledger');
const {validateSnapshot}=require('../../research/alibaba-shadow/src/snapshot');
const {routes}=require('../routes/api');

const ROOT=path.resolve(__dirname,'../..');
const FIXTURE_ROOT=path.join(store.DATA_DIR,`alibaba-shadow-test-${process.pid}`);
function ticker(symbol,observedAt,extra={}){return {symbol,observedAt,bid:99.9,ask:100.1,markPrice:100,
  bidSize:10,askSize:12,spreadPct:.02,change24hPct:1,fundingRate:.0001,openInterest:1000,turnover24h:1000000,...extra};}
function signal(extra={}){return {id:'alibaba-candidate-1',symbol:'TESTUSDT',side:'BUY',entry:100,sl:98,tp:104,rr:2,score:75,
  atr:1.8,signalSource:'ORAYAN',entryPath:'STRUCTURE_RETEST',structureEvent:'BOS',btcRegime:'BULL_TREND',
  gates:{passed:true,failed:[]},...extra};}
function birth(at){return {kind:'candidate_birth',engine:'NEW_ORAYAN',at,decisionAt:at,episodeId:'alibaba-episode-1',grossTargetR:2,
  market:{spreadPct:.02,bidSize:10,askSize:12,topOfBookImbalance:-.09,markIndexBasisPct:.01,fundingRate:.0001,
    openInterest:500,openInterestChangePct:.5,change24hPct:2,turnover24h:1000000}};}
function market(at,breadth=10){return {marketSnapshotId:`m-${at}`,timeframe:'5',directionalBreadth:breadth,breadthMomentum:-2,
  universeCount:100,coveragePct:100,trendUpPct:52,trendDownPct:48,crossSectionalDispersion:.01,directionalCoherence:.4,
  volatilityState:'NORMAL',medianRealisedVol20:.012,btcReturn1:.002,btcReturn3:.004,btcRealisedVol20:.01,
  btcShockZ:.2,btcShockState:'NORMAL',observedAt:at-1000};}
function context(at,extra={}){return {scanAt:at,marketSnapshot:market(at),ticker:ticker('TESTUSDT',at-1000),
  settings:{riskUsdtPerTrade:.25},btcRegime:{regime:'BULL_TREND',strength:70,observedAt:at-2000},
  openPositions:[{side:'BUY',btcRegime:'BULL_TREND',plannedRisk:.25}],...extra};}
function seed(at){const base=at-10*60000;
  producer.observeEnvironment({at:base,marketSnapshot:market(base,20),btcRegime:{regime:'RANGE',strength:40,observedAt:base-2000},
    tickers:[ticker('BTCUSDT',base-1000),ticker('ETHUSDT',base-1000)]});
  producer.observeEnvironment({at,marketSnapshot:market(at,10),btcRegime:{regime:'BULL_TREND',strength:70,observedAt:at-2000},
    tickers:[ticker('BTCUSDT',at-1000,{change24hPct:.5,openInterest:990}),
      ticker('ETHUSDT',at-1000,{change24hPct:.4,openInterest:980})]});}
async function waitFor(check,timeout=3000){const until=Date.now()+timeout;while(Date.now()<until){if(await check())return;
  await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Timed out waiting for Alibaba shadow work');}

test.beforeEach(()=>{producer._test.reset();ledger._test.resetCaches();});
test.after(()=>fs.rmSync(FIXTURE_ROOT,{recursive:true,force:true}));

test('rich snapshot is bounded, causal, and joins optional context only when available before birth',()=>{
  const at=Date.parse('2026-09-29T10:10:00Z');seed(at);
  const row=producer.buildSnapshot(signal(),birth(at),context(at,{
    marketIntelligence:{availableAt:at-1000,generatedAt:at-2000,observations:['breadth weakened']},
    geminiBriefing:{availableAt:at+1,generatedAt:at-1000,text:'future availability must not join'}}));
  assert.equal(row.market_intelligence.status,'OK');assert.deepEqual(row.market_intelligence.observations,['breadth weakened']);
  assert.equal(row.gemini_briefing.status,'UNAVAILABLE');assert.equal(row.market_context.current.breadth_current,10);
  assert.equal(row.market_context.benchmark_returns.eth_short,null);assert.ok(row.regime_transitions.items.length<=4);
  assert.deepEqual(validateSnapshot(row,at+1000),{valid:true,errors:[],abstainReasons:[]});
  assert.ok(Buffer.byteLength(JSON.stringify(row))<96*1024);
  assert.doesNotMatch(JSON.stringify(row),/realised_pnl|realized_pnl|winner|future_return|exit_price/i);
});

test('live-disabled one-way handoff durably records the queue without a provider request',async()=>{
  const old={ledger:process.env.ALIBABA_SHADOW_LEDGER,snapshots:process.env.ALIBABA_SHADOW_SNAPSHOTS,
    live:process.env.ALIBABA_SHADOW_ALLOW_LIVE};
  const decisions=path.join(FIXTURE_ROOT,'dark','decisions.jsonl'),snapshots=path.join(FIXTURE_ROOT,'dark','snapshots.jsonl');
  Object.assign(process.env,{ALIBABA_SHADOW_LEDGER:decisions,ALIBABA_SHADOW_SNAPSHOTS:snapshots,ALIBABA_SHADOW_ALLOW_LIVE:'false'});
  try{const at=Date.now()-5000;seed(at);assert.equal(producer.observeBirth(signal(),birth(at),context(at)),true);
    assert.equal(fs.existsSync(snapshots),false,'engine handoff returns before disk I/O');
    await waitFor(()=>fs.existsSync(snapshots)&&fs.readFileSync(snapshots,'utf8').includes('LIVE_DISABLED'));
    assert.equal(fs.existsSync(decisions),false);
  }finally{for(const [key,value] of Object.entries(old)){const envKey=key==='ledger'?'ALIBABA_SHADOW_LEDGER':key==='snapshots'?'ALIBABA_SHADOW_SNAPSHOTS':'ALIBABA_SHADOW_ALLOW_LIVE';
    if(value===undefined)delete process.env[envKey];else process.env[envKey]=value;}}
});

test('durable queued snapshot replays once on restart',async()=>{
  const decisions=path.join(FIXTURE_ROOT,'replay','decisions.jsonl');
  const env={...process.env,ALIBABA_SHADOW_LEDGER:decisions,ALIBABA_SHADOW_SNAPSHOTS:path.join(FIXTURE_ROOT,'replay','snapshots.jsonl'),
    ALIBABA_SHADOW_ALLOW_LIVE:'true'};
  const at=Date.now()-5000;seed(at);const row=producer.buildSnapshot(signal({id:'replay-candidate'}),birth(at),context(at));
  const cfg=producer.config(env),id=producer._test.handoffId(row);
  ledger.appendImmutable(cfg.snapshotAudit,{audit_schema_version:'ORAYAN_ALIBABA_SNAPSHOT_AUDIT_V1',recorded_at_utc:new Date().toISOString(),
    record_type:'CANDIDATE_SNAPSHOT',handoff_id:id,candidate_id:row.candidate_id,processing_status:'QUEUED',snapshot:row},
    {allowedRoot:store.DATA_DIR});
  producer._test.reset();ledger._test.resetCaches();let calls=0;
  producer._test.setTransport(async()=>{calls+=1;return {ok:false,status:'API_5XX',httpStatus:503,headers:{},
    error:{type:null,code:null,message:null},body:null};});
  await producer.initialize(env);const auditRows=fs.readFileSync(cfg.snapshotAudit,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(auditRows.at(-1).processing_status,'API_5XX');assert.equal(calls,1);
});

test('protected streaming export and dashboard panel work without exposing secrets',async()=>{
  const decisions=path.join(FIXTURE_ROOT,'export','decisions.jsonl');fs.mkdirSync(path.dirname(decisions),{recursive:true});
  fs.writeFileSync(decisions,'{"decision":"RETAIN"}\n');
  const handler=routes['GET /api/journal/research/alibaba-shadow/export'];
  const oldToken=process.env.ALIBABA_SHADOW_EXPORT_TOKEN,oldLedger=process.env.ALIBABA_SHADOW_LEDGER;
  process.env.ALIBABA_SHADOW_EXPORT_TOKEN='export-secret';process.env.ALIBABA_SHADOW_LEDGER=decisions;
  try{await assert.rejects(handler({req:{headers:{}}}),error=>error.statusCode===401);
    const result=await handler({req:{headers:{'x-alibaba-shadow-export-token':'export-secret'}}});
    assert.equal(result.__stream,true);let body='';result.stream.on('data',chunk=>{body+=chunk;});await once(result.stream,'end');
    assert.equal(body,'{"decision":"RETAIN"}\n');
  }finally{if(oldToken===undefined)delete process.env.ALIBABA_SHADOW_EXPORT_TOKEN;else process.env.ALIBABA_SHADOW_EXPORT_TOKEN=oldToken;
    if(oldLedger===undefined)delete process.env.ALIBABA_SHADOW_LEDGER;else process.env.ALIBABA_SHADOW_LEDGER=oldLedger;}
  const html=fs.readFileSync(path.join(ROOT,'frontend/index.html'),'utf8'),app=fs.readFileSync(path.join(ROOT,'frontend/app.js'),'utf8');
  assert.match(html,/id="alibabaShadowPanel"[\s\S]*Download Alibaba Shadow Data/);
  assert.match(app,/\/api\/journal\/research\/alibaba-shadow\/export/);
  assert.doesNotMatch(html+app,/ALIBABA_API_KEY|sk-secret|Bearer\s/);
});

test('export path is confined to the persistent data root',()=>{
  assert.throws(()=>shadowExport.ledgerPath({env:{ALIBABA_SHADOW_LEDGER:path.resolve(store.DATA_DIR,'..','outside.jsonl')},
    dataRoot:store.DATA_DIR}),error=>error.statusCode===403);
});
