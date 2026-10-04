'use strict';
// Separate process: no production imports, I/O capabilities, geometry, or executor.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const root=__dirname,expected=JSON.parse(fs.readFileSync(path.join(root,'frozen_source_manifest.json')));
for(const [f,h] of Object.entries(expected)) {
  if(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex')!==h)throw Error(`FROZEN_HASH_MISMATCH:${f}`);
}
function makeAdapter(now) {
  let serial=0; const cache={};
  const blocked=()=>{throw Error('FROZEN_READ_ONLY_WRITE_ATTEMPT');};
  const stubs={journal:new Proxy({}, {get:()=>blocked}),bosTracker:new Proxy({}, {get:()=>blocked}),
    symbolStats:{check:()=>({blocked:false})}};
  class Clock extends Date {static now(){return now;}}
  const context=vm.createContext({Date:Clock,Math,Number,Array,Object,String,Boolean,Set,Map,JSON,
    console:Object.freeze({log:blocked,warn:blocked,error:blocked})}, {codeGeneration:{strings:false,wasm:false}});
  function load(name) {
    if(stubs[name])return stubs[name];
    if(cache[name])return cache[name].exports;
    const file=`frozen/lib/${name}.js`; if(!expected[file])throw Error(`IMPORT_DENIED:${name}`);
    const mod={exports:{}};cache[name]=mod;
    const req=x=>{if(!/^\.\/[\w]+$/.test(x))throw Error(`IMPORT_DENIED:${x}`);return load(x.slice(2));};
    new vm.Script(`(function(require,module,exports){${fs.readFileSync(path.join(root,file),'utf8')}\n})`,{filename:file})
      .runInContext(context,{timeout:5000})(req,mod,mod.exports);
    if(name==='util')mod.exports.uid=prefix=>`${prefix}_${now}_${serial++}`;
    return mod.exports;
  }
  const native=load('signals'),gates=load('gates'),levels=load('v3Levels'),trend=load('signals_trend_v30'),contracts=load('v3Contracts');
  // Literal frozen adapter functions, copied from sources/adapters.js (hash recorded).
  function structural(candles,btc,now){
    const error=contracts.validateClosedCandles(candles,900000,now);
    if(error)return {side:null,reason:error,prequote:false,research:null};
    const tr=trend.detectTrend(candles),side=tr.trend==='UP'?'BUY':tr.trend==='DOWN'?'SELL':null;
    const permission=contracts.trendPermission(btc.regime,side);
    const research=levels.measure({candles,side,price:candles.at(-1).close,intervalMs:900000,decisionAt:now});
    const qualifying=research.levels.filter(l=>l.active&&(!l.direction||l.direction===side)&&l.knownAt<=candles.at(-1).ts&&(l.reaction?.reclaim||l.reaction?.rejection));
    if(research.selected&&!research.levels.some(l=>l.id===research.selected.id)){
      const l=research.selected;if(l.active&&(!l.direction||l.direction===side)&&l.knownAt<=candles.at(-1).ts&&(l.reaction?.reclaim||l.reaction?.rejection))qualifying.push(l);
    }
    qualifying.sort((a,b)=>Math.abs(a.distancePct)-Math.abs(b.distancePct)||b.knownAt-a.knownAt||a.id.localeCompare(b.id));
    return {side,permission,research,prequote:Boolean(side&&permission&&qualifying.length),reaction:qualifying[0]||null,
      reason:!side?'NO_TREND':!permission?'V3.1_TREND_REGIME_NOT_PERMITTED':!qualifying.length?'NO_COMPLETED_STRUCTURAL_REACTION':null};
  }
  function v2(candles,ticker,btc,settings,symbol){
    const out=native.buildSignal({symbol,candles,ticker,btcRegime:btc,settings});
    if(!out.ok)return {born:false,eligible:false,reason:out.reason};
    const g=gates.evaluate(out.signal,{...settings,gateSymbolExpectancyEnabled:false},{openPositions:[],symbolLockouts:{}});
    const ignored=new Set(['MAX_PER_ENGINE','MAX_POSITIONS','MAX_PER_DIRECTION','NO_DUPLICATE_SYMBOL','SYMBOL_LOCKOUT','SYMBOL_EXPECTANCY','SPREAD']);
    const failed=g.failed.filter(x=>!ignored.has(x));
    return {born:true,eligible:failed.length===0,reason:failed.join('|')||null,signal:out.signal,checks:g.checks};
  }
  const cfg=JSON.parse(fs.readFileSync(path.join(root,'sources/frozen_config.json')));
  if(cfg.settings.activeEngine!=='TREND')throw Error('UNVERIFIED_SOURCE_POPULATION');
  return {native,structural,v2,cfg,trend,ind:load('indicators'),load};
}
function evaluate(x) {
  const A=makeAdapter(x.decisionAt);
  const btc=x.btcRegime||A.native.detectBtcRegime(x.btc);
  if(x.op==='regime')return btc;
  const v=A.v2(x.candles,x.ticker,btc,A.cfg.settings,x.symbol);
  const tr=A.trend.detectTrend(x.candles),side=tr.trend==='UP'?'BUY':tr.trend==='DOWN'?'SELL':null;
  const permitted=(side==='BUY'&&btc.regime==='BULL_TREND')||(side==='SELL'&&btc.regime==='BEAR_TREND');
  const st=permitted?A.structural(x.candles,btc,x.decisionAt):{side,prequote:false,reason:'V3.1_TREND_REGIME_NOT_PERMITTED'};
  const atr=A.ind.atr(x.candles,14);
  return {v2:v,v3:st,btc,trendExtension:atr?(x.candles.at(-1).close-tr.eFast)/atr:null};
}
if(require.main===module){
  const readline=require('node:readline').createInterface({input:process.stdin});
  readline.on('line',s=>{try{process.stdout.write(JSON.stringify({ok:true,result:evaluate(JSON.parse(s))})+'\n');}
    catch(e){process.stdout.write(JSON.stringify({ok:false,error:e.message})+'\n');}});
}
module.exports={evaluate,makeAdapter};
