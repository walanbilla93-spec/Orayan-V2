'use strict';
const path=require('path'),crypto=require('crypto');
const lib=path.join(__dirname,'source_snapshot/backend/lib');
let clock=0,serial=0;Date.now=()=>clock;
const util=require(path.join(lib,'util'));util.uid=prefix=>`${prefix}_${clock}_${serial++}`;
const native=require(path.join(lib,'signals')),gates=require(path.join(lib,'gates'));
const levels=require(path.join(lib,'v3Levels')),trend=require(path.join(lib,'signals_trend_v30'));
const contracts=require(path.join(lib,'v3Contracts')),geom=require(path.join(lib,'v3Geometry'));
const simulator=require(path.join(lib,'v3Trades')),noise=require(path.join(lib,'v34Measurements'));
const arms=require(path.join(lib,'v34bResearch')),risk=require(path.join(lib,'risk'));
function at(t){clock=t;serial=0;}
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0,24);
function structural(candles,btc,now){
 const error=contracts.validateClosedCandles(candles,900000,now);
 if(error)return {side:null,reason:error,prequote:false,research:null};
 const tr=trend.detectTrend(candles),side=tr.trend==='UP'?'BUY':tr.trend==='DOWN'?'SELL':null;
 const permission=contracts.trendPermission(btc.regime,side);
 const research=levels.measure({candles,side,price:candles.at(-1).close,intervalMs:900000,decisionAt:now});
 // Literal reaction predicate copied from v3Geometry.build, no quote or economic gate.
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
 // Stateful expectancy, lockouts/capacity are recorded but excluded from opportunity Layer 1.
 const g=gates.evaluate(out.signal,{...settings,gateSymbolExpectancyEnabled:false},{openPositions:[],symbolLockouts:{}});
 const ignored=new Set(['MAX_PER_ENGINE','MAX_POSITIONS','MAX_PER_DIRECTION','NO_DUPLICATE_SYMBOL','SYMBOL_LOCKOUT','SYMBOL_EXPECTANCY','SPREAD']);
 const failed=g.failed.filter(x=>!ignored.has(x));
 return {born:true,eligible:failed.length===0,reason:failed.join('|')||null,signal:out.signal,checks:g.checks};
}
function executable(b,side,spread){
 const f=1+(side==='BUY'?1:-1)*spread/20000;
 return {...b,open:b.open*f,high:b.high*f,low:b.low*f,close:b.close*f};
}
function cap(t){
 const g=t.geometry,d=t.side==='BUY'?1:-1,E=t.entryPrice,loss=t.fillEconomics.lossPerUnit;
 const ef=g.costs.entryFeePct/100,xf=g.costs.exitFeePct/100;
 const target=d===1?geom.round((2*loss+E+E*ef)/(1-xf),g.tickSize,false):geom.round((E-E*ef-2*loss)/(1+xf),g.tickSize,true);
 g.objectivePrice=d===1?Math.min(g.objectivePrice,target):Math.max(g.objectivePrice,target);
 return t;
}
module.exports={lib,at,hash,native,structural,v2,geom,simulator,noise,arms,risk,executable,cap};
