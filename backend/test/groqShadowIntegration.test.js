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

const ROOT = path.resolve(__dirname, '../..');
const FIXTURE_ROOT = path.join(store.DATA_DIR, `groq-shadow-test-${process.pid}`);

function ticker(symbol, observedAt, overrides = {}) {
  return { symbol, observedAt, bid: 99.9, ask: 100.1, markPrice: 100,
    change24hPct: 1, fundingRate: 0.0001, openInterest: 1000, ...overrides };
}
function signal() {
  return { id: 'candidate-test-1', symbol: 'TESTUSDT', side: 'BUY', entry:100, sl:98, tp:104,
    rr:2, score:75, signalSource:'ORAYAN', entryPath:'STRUCTURE_RETEST', structureEvent:'BOS',
    btcRegime:'BULL_TREND', gates:{passed:true,failed:[]} };
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

test.beforeEach(() => producer._test.reset());
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
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(fs.existsSync(audit),true);
    assert.equal(fs.existsSync(ledger),false);
    const record=JSON.parse(fs.readFileSync(audit,'utf8').trim());
    assert.equal(record.processing_status,'LIVE_DISABLED');
    assert.equal(record.snapshot.candidate_id,'candidate-test-1');
  } finally {
    if(old.ledger===undefined)delete process.env.GROQ_SHADOW_LEDGER;else process.env.GROQ_SHADOW_LEDGER=old.ledger;
    if(old.live===undefined)delete process.env.GROQ_SHADOW_ALLOW_LIVE;else process.env.GROQ_SHADOW_ALLOW_LIVE=old.live;
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
