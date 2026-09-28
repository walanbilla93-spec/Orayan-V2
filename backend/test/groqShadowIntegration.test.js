'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { once } = require('events');
const producer = require('../lib/groqShadowProducer');
const groqExport = require('../lib/groqShadowExport');
const store = require('../lib/store');
const { validateSnapshot } = require('../../research/groq-shadow/src/snapshot');
const ledgerModule = require('../../research/groq-shadow/src/ledger');
const { routes } = require('../routes/api');

const ROOT = path.resolve(__dirname, '../..');
const FIXTURE_ROOT = path.join(store.DATA_DIR, `groq-shadow-test-${process.pid}`);

function ticker(symbol, observedAt, overrides = {}) {
  return { symbol, observedAt, bid: 99.9, ask: 100.1, markPrice: 100,
    change24hPct: 1, fundingRate: 0.0001, openInterest: 1000, ...overrides };
}
function signal(overrides={}) {
  return { id: 'candidate-test-1', symbol: 'TESTUSDT', side: 'BUY', entry:100, sl:98, tp:104,
    rr:2, score:75, signalSource:'ORAYAN', entryPath:'STRUCTURE_RETEST', structureEvent:'BOS',
    btcRegime:'BULL_TREND', gates:{passed:true,failed:[]}, ...overrides };
}
function birth(at) {
  return { kind:'candidate_birth', engine:'NEW_ORAYAN', at, decisionAt:at,
    episodeId:'episode-test-1', grossTargetR:2 };
}
function context(at) {
  return { scanAt:at, ticker:ticker('TESTUSDT',at-1000),
    settings:{riskUsdtPerTrade:0.25},btcRegime:{regime:'BULL_TREND',strength:70,observedAt:at-2000},
    openPositions:[{side:'BUY',btcRegime:'BULL_TREND',plannedRisk:0.25}] };
}

async function waitFor(check,timeoutMs=3000){
  const until=Date.now()+timeoutMs;
  while(Date.now()<until){if(await check())return;await new Promise(resolve=>setTimeout(resolve,10));}
  throw new Error('Timed out waiting for asynchronous shadow work');
}

test.beforeEach(() => { producer._test.reset();ledgerModule._test.resetCaches(); });
test.after(() => { fs.rmSync(FIXTURE_ROOT,{recursive:true,force:true}); });

test('birth snapshot is exact-as-of, causal, and includes frozen exposure/H1/H2 evidence', () => {
  const at = Date.parse('2026-09-29T10:10:00Z');
  const baseAt = at - 10 * 60000;
  producer.observeEnvironment({at:baseAt,marketSnapshot:{directionalBreadth:20,observedAt:baseAt-1000,universeCount:100},
    tickers:[ticker('BTCUSDT',baseAt-1000),ticker('ETHUSDT',baseAt-1000)]});
  producer.observeEnvironment({at,marketSnapshot:{directionalBreadth:10,observedAt:at-1000,universeCount:110},
    tickers:[ticker('BTCUSDT',at-1000,{change24hPct:0.5,openInterest:990}),
      ticker('ETHUSDT',at-1000,{change24hPct:0.4,openInterest:980})]});
  const row = producer.buildSnapshot(signal(),birth(at),context(at));
  assert.equal(row.candidate_birth_at_utc,'2026-09-29T10:10:00.000Z');
  assert.equal(row.exposure.same_side_regime_count,1);
  assert.equal(row.planned_trade.planned_heat_usdt,0.5);
  assert.equal(row.planned_trade.quote_evidence.exchange_timestamp_utc,null);
  assert.equal(row.planned_trade.quote_evidence.exchange_timestamp_status,'UNAVAILABLE_BYBIT_TICKER_PAYLOAD');
  assert.equal(row.h1.version,'H1_DIRECTION_REGIME_HEAT_V1');
  assert.equal(row.h2.version,'H2_BIRTH_TIME_DETERIORATION_V1');
  assert.deepEqual(validateSnapshot(row,at+1000),{valid:true,errors:[],abstainReasons:[]});
  assert.doesNotMatch(JSON.stringify(row),/realised|realized|pnl|winner|future_return|exit/i);
});

test('missing H2 baseline produces local ABSTAIN eligibility', () => {
  const at=Date.parse('2026-09-29T10:00:00Z');
  producer.observeEnvironment({at,marketSnapshot:{directionalBreadth:10,observedAt:at-1000,universeCount:80},
    tickers:[ticker('BTCUSDT',at-1000),ticker('ETHUSDT',at-1000)]});
  const row=producer.buildSnapshot(signal(),birth(at),context(at));
  assert.equal(row.h2.state,'ABSTAIN');
  assert.ok(validateSnapshot(row,at+1000).abstainReasons.some(reason=>reason.startsWith('h2:')));
});

test('live-disabled canonical birth creates the persistent parent and snapshot audit automatically', async () => {
  const old = {ledger:process.env.GROQ_SHADOW_LEDGER,live:process.env.GROQ_SHADOW_ALLOW_LIVE};
  const ledger=path.join(FIXTURE_ROOT,'disabled','decisions.jsonl');
  process.env.GROQ_SHADOW_LEDGER=ledger;
  process.env.GROQ_SHADOW_ALLOW_LIVE='false';
  try {
    const at=Date.parse('2026-09-29T10:00:00Z');
    producer.observeEnvironment({at,marketSnapshot:null,tickers:[]});
    assert.equal(producer.observeBirth(signal(),birth(at),context(at)),true);
    const audit=path.join(path.dirname(ledger),'candidate-snapshots.jsonl');
    assert.equal(fs.existsSync(audit),false,'candidate path must return before shadow disk I/O');
    await waitFor(()=>fs.existsSync(audit) && fs.readFileSync(audit,'utf8').includes('LIVE_DISABLED'));
    assert.equal(fs.existsSync(ledger),false);
    const records=fs.readFileSync(audit,'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records[0].processing_status,'QUEUED');
    assert.equal(records[0].snapshot.candidate_id,'candidate-test-1');
    assert.equal(records.at(-1).processing_status,'LIVE_DISABLED');
  } finally {
    if(old.ledger===undefined)delete process.env.GROQ_SHADOW_LEDGER;else process.env.GROQ_SHADOW_LEDGER=old.ledger;
    if(old.live===undefined)delete process.env.GROQ_SHADOW_ALLOW_LIVE;else process.env.GROQ_SHADOW_ALLOW_LIVE=old.live;
  }
});

test('automatic live path durably hands birth to producer then mock Groq and terminal decision',async()=>{
  const old={ledger:process.env.GROQ_SHADOW_LEDGER,live:process.env.GROQ_SHADOW_ALLOW_LIVE};
  const ledger=path.join(FIXTURE_ROOT,'automatic-live','decisions.jsonl');
  const audit=path.join(path.dirname(ledger),'candidate-snapshots.jsonl');
  process.env.GROQ_SHADOW_LEDGER=ledger;process.env.GROQ_SHADOW_ALLOW_LIVE='true';
  let calls=0;
  producer._test.setTransport(async()=>{calls+=1;
    assert.match(fs.readFileSync(audit,'utf8'),/"processing_status":"QUEUED"/,
      'durable queued snapshot must exist before transport starts');
    return {ok:true,status:'OK',httpStatus:200,headers:{},latencyMs:1,
    body:{usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15},choices:[{message:{content:JSON.stringify({
      decision:'RETAIN',risk_level:'LOW',confidence:.7,reason_codes:['SUPPORTED'],evidence_keys:['h1.state','h2.state'],
      missing_or_stale:[],rationale_short:'Causal evidence supports the shadow decision.'})}}]}};});
  try{
    const at=Date.now()-5000,baseAt=at-10*60000;
    producer.observeEnvironment({at:baseAt,marketSnapshot:{directionalBreadth:20,observedAt:baseAt-1000,universeCount:100},
      tickers:[ticker('BTCUSDT',baseAt-1000),ticker('ETHUSDT',baseAt-1000)]});
    producer.observeEnvironment({at,marketSnapshot:{directionalBreadth:18,observedAt:at-1000,universeCount:100},
      tickers:[ticker('BTCUSDT',at-1000),ticker('ETHUSDT',at-1000)]});
    assert.equal(producer.observeBirth(signal(),birth(at),context(at)),true);
    await waitFor(()=>fs.existsSync(ledger) && fs.readFileSync(ledger,'utf8').includes('SHADOW_DECISION') &&
      fs.existsSync(audit) && fs.readFileSync(audit,'utf8').includes('"processing_status":"OK"'));
    const auditRows=fs.readFileSync(audit,'utf8').trim().split('\n').map(JSON.parse);
    const ledgerRows=fs.readFileSync(ledger,'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(auditRows[0].processing_status,'QUEUED');
    assert.deepEqual(ledgerRows.map(row=>row.record_type),['REQUEST_STARTED','SHADOW_DECISION']);
    assert.equal(calls,1);
  }finally{
    if(old.ledger===undefined)delete process.env.GROQ_SHADOW_LEDGER;else process.env.GROQ_SHADOW_LEDGER=old.ledger;
    if(old.live===undefined)delete process.env.GROQ_SHADOW_ALLOW_LIVE;else process.env.GROQ_SHADOW_ALLOW_LIVE=old.live;
  }
});

test('startup recovers snapshot persisted before processing',async()=>{
  const ledger=path.join(FIXTURE_ROOT,'restart-queued','decisions.jsonl');
  const env={...process.env,GROQ_SHADOW_LEDGER:ledger,GROQ_SHADOW_ALLOW_LIVE:'true'};
  const at=Date.now()-5000,baseAt=at-10*60000;
  producer.observeEnvironment({at:baseAt,marketSnapshot:{directionalBreadth:20,observedAt:baseAt-1000,universeCount:100},
    tickers:[ticker('BTCUSDT',baseAt-1000),ticker('ETHUSDT',baseAt-1000)]});
  producer.observeEnvironment({at,marketSnapshot:{directionalBreadth:18,observedAt:at-1000,universeCount:100},
    tickers:[ticker('BTCUSDT',at-1000),ticker('ETHUSDT',at-1000)]});
  const row=producer.buildSnapshot(signal({id:'restart-candidate'}),birth(at),context(at));
  const cfg=producer.config(env),id=producer._test.handoffId(row);
  ledgerModule.appendImmutable(cfg.snapshotAudit,{audit_schema_version:'ORAYAN_GROQ_SNAPSHOT_AUDIT_V1',
    recorded_at_utc:new Date().toISOString(),record_type:'CANDIDATE_SNAPSHOT',handoff_id:id,
    candidate_id:row.candidate_id,processing_status:'QUEUED',snapshot:row},{allowedRoot:store.DATA_DIR});
  producer._test.reset();ledgerModule._test.resetCaches();
  let calls=0;producer._test.setTransport(async()=>{calls+=1;return {ok:false,status:'UPSTREAM_5XX',httpStatus:503,headers:{},body:null};});
  await producer.initialize(env);
  const auditRows=fs.readFileSync(cfg.snapshotAudit,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(auditRows[0].processing_status,'QUEUED');
  assert.equal(auditRows.at(-1).processing_status,'UPSTREAM_5XX');
  assert.equal(calls,1);
});

test('write path rejects a parent symlink escape',()=>{
  const outside=fs.mkdtempSync(path.join(require('os').tmpdir(),'groq-outside-'));
  const link=path.join(FIXTURE_ROOT,'symlink-parent');
  fs.mkdirSync(FIXTURE_ROOT,{recursive:true});
  try{
    fs.symlinkSync(outside,link,process.platform==='win32'?'junction':'dir');
    assert.throws(()=>ledgerModule.appendImmutable(path.join(link,'escaped.jsonl'),{bad:true},{allowedRoot:store.DATA_DIR}),
      error=>error.code==='GROQ_SHADOW_WRITE_SYMLINK_ESCAPE');
  }finally{fs.rmSync(link,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true});}
});

test('optional export token rejects unauthenticated requests and accepts matching header',async()=>{
  const handler=routes['GET /api/journal/research/groq-shadow/export'];
  const old={token:process.env.GROQ_SHADOW_EXPORT_TOKEN,ledger:process.env.GROQ_SHADOW_LEDGER};
  const ledger=path.join(FIXTURE_ROOT,'protected-export','decisions.jsonl');
  fs.mkdirSync(path.dirname(ledger),{recursive:true});fs.writeFileSync(ledger,'{}\n');
  process.env.GROQ_SHADOW_EXPORT_TOKEN='test-export-token';process.env.GROQ_SHADOW_LEDGER=ledger;
  try{
    await assert.rejects(handler({req:{headers:{}}}),error=>error.statusCode===401);
    const result=await handler({req:{headers:{'x-groq-shadow-export-token':'test-export-token'}}});
    assert.equal(result.__stream,true);result.stream.destroy();
  }finally{
    if(old.token===undefined)delete process.env.GROQ_SHADOW_EXPORT_TOKEN;else process.env.GROQ_SHADOW_EXPORT_TOKEN=old.token;
    if(old.ledger===undefined)delete process.env.GROQ_SHADOW_LEDGER;else process.env.GROQ_SHADOW_LEDGER=old.ledger;
  }
});

test('download path is fixed inside persistent root; missing is 404 and populated file streams', async () => {
  const ledger=path.join(FIXTURE_ROOT,'export','decisions.jsonl');
  assert.deepEqual(groqExport.metadata({env:{GROQ_SHADOW_LEDGER:ledger},dataRoot:store.DATA_DIR}),
    {available:false,sizeBytes:0,lastUpdatedAt:null});
  assert.throws(()=>groqExport.download({env:{GROQ_SHADOW_LEDGER:ledger},dataRoot:store.DATA_DIR}),
    error=>error.statusCode===404);
  assert.throws(()=>groqExport.ledgerPath({env:{GROQ_SHADOW_LEDGER:path.resolve(store.DATA_DIR,'..','outside.jsonl')},dataRoot:store.DATA_DIR}),
    error=>error.statusCode===403);
  fs.mkdirSync(path.dirname(ledger),{recursive:true});
  fs.writeFileSync(ledger,'{"decision":"RETAIN"}\n');
  const result=groqExport.download({env:{GROQ_SHADOW_LEDGER:ledger},dataRoot:store.DATA_DIR,now:Date.parse('2026-09-29T10:00:00Z')});
  assert.equal(result.contentType,'application/x-ndjson; charset=utf-8');
  assert.match(result.filename,/2026-09-29T10-00-00Z\.jsonl$/);
  let body='';result.stream.on('data',chunk=>{body+=chunk;});await once(result.stream,'end');
  assert.equal(body,'{"decision":"RETAIN"}\n');
});

test('dashboard always renders the Groq control and uses the fixed export endpoint without secrets', () => {
  const html=fs.readFileSync(path.join(ROOT,'frontend/index.html'),'utf8');
  const app=fs.readFileSync(path.join(ROOT,'frontend/app.js'),'utf8');
  assert.match(html,/data-view="dashboard"[\s\S]*id="groqShadowPanel"[\s\S]*Download Groq Shadow Data/);
  assert.match(app,/\/api\/journal\/research\/groq-shadow\/export/);
  assert.doesNotMatch(html+app,/GROQ_API_KEY|Bearer\s/);
});

test('engine invokes producer after native birth without awaiting or reading its result', () => {
  const engine=fs.readFileSync(path.join(ROOT,'backend/lib/engine.js'),'utf8');
  const birthAt=engine.indexOf('birth = researchCapture.birth');
  const handoffAt=engine.indexOf('groqShadowProducer.observeBirth');
  assert.ok(birthAt>=0 && handoffAt>birthAt);
  assert.doesNotMatch(engine,/await\s+groqShadowProducer\.observeBirth/);
});
