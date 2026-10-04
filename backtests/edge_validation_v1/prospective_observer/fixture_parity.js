'use strict';
// Offline only. Compare adapter to archived literal candidate functions and known
// archived V2 signal outputs. No outcome values are read or compared.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {evaluate,makeAdapter}=require('./adapter');
const frozen=fs.readFileSync(__dirname+'/sources/adapters.js','utf8');
const body=frozen.slice(frozen.indexOf('function structural('),frozen.indexOf('function executable('));
const fixtures={V2:JSON.parse(fs.readFileSync(__dirname+'/fixtures/v2_parity_fixtures.json')),V3:JSON.parse(fs.readFileSync(__dirname+'/fixtures/parity_fixtures.json'))};
const report={V2:{attempted:0,passed:0,failures:[]},V3:{attempted:0,passed:0,failures:[]},excluded:[]};
for(const name of ['executor','v3Geometry','v3Trades','risk','store','bybit','engine'])assert.throws(()=>makeAdapter(0).load(name),/IMPORT_DENIED/);
report.importIsolation='PASS';
for(const [engine,list] of Object.entries(fixtures))for(const f of list){
  const t=engine==='V2'?f.expected:f.initial;
  if(!f.candles?.length||!f.btc?.length){report.excluded.push({engine,symbol:t.symbol,reason:'NO_KNOWN_SOURCE_INPUT_FIXTURE'});continue;}
  report[engine].attempted++;
  try{
    const A=makeAdapter(t.decisionAt);
    const context=vm.createContext({native:A.native,gates:requireInSandbox(A,'gates'),levels:requireInSandbox(A,'v3Levels'),trend:A.trend,contracts:requireInSandbox(A,'v3Contracts')});
    // Recreate standalone reference functions from the frozen archived adapter,
    // preserving its literal source instead of comparing to the new function.
    const ref=new vm.Script(body+';({structural,v2})').runInContext(context);
    const btc=A.native.detectBtcRegime(f.btc);
    const ticker=engine==='V2'?t.market:{markPrice:f.quote?.markPrice||f.candles.at(-1).close,turnover24h:f.quote?.turnover24h||1e7,spreadPct:null};
    const out=evaluate({symbol:t.symbol,decisionAt:t.decisionAt,candles:f.candles,btc:f.btc,ticker});
    if(engine==='V2'){
      const old=ref.v2(f.candles,ticker,btc,A.cfg.settings,t.symbol);
      assert.equal(JSON.stringify(out.v2),JSON.stringify(old));
      const s=out.v2.signal;
      assert.ok(s,'KNOWN_NATIVE_SIGNAL_MISSING');assert.equal(s.side,t.side);assert.equal(s.score,t.score);assert.equal(s.createdAt,t.decisionAt);
      for(const[k,v]of [['entry',t.plannedEntry],['sl',t.plannedSl],['tp',t.plannedTp]])assert.ok(Math.abs(s[k]-v)<1e-9,`KNOWN_SIGNAL_${k}`);
    }else{
      const side=A.trend.detectTrend(f.candles).trend==='UP'?'BUY':A.trend.detectTrend(f.candles).trend==='DOWN'?'SELL':null;
      const permitted=(side==='BUY'&&btc.regime==='BULL_TREND')||(side==='SELL'&&btc.regime==='BEAR_TREND');
      const old=permitted?ref.structural(f.candles,btc,t.decisionAt):{side,prequote:false,reason:'V3.1_TREND_REGIME_NOT_PERMITTED'};
      assert.equal(JSON.stringify(out.v3),JSON.stringify(old));
    }
    report[engine].passed++;
  }catch(e){report[engine].failures.push({symbol:t.symbol,decisionAt:t.decisionAt,error:e.message});}
}
// Dependencies obtained through the same deny-by-default VM loader. Test access
// does not change the observer's frozen exports or production modules.
function requireInSandbox(A,name){return A.load(name);}
console.log(JSON.stringify(report,null,2));
if(report.V2.passed!==report.V2.attempted||report.V3.passed!==report.V3.attempted)process.exitCode=1;
