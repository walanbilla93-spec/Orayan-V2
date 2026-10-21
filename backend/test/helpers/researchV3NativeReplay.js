'use strict';
// Offline reuse of the frozen management function and PAPER executor. All market
// inputs are supplied; live transport imports are replaced with throwing stubs.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../../lib'),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function create(){let clock=Date.parse('2026-10-20T00:00:00Z'),trades=[],outcomes=[],locks=[],extremes={},persisted=0,ids=0;
  class FixtureDate extends Date {constructor(...a){super(...(a.length?a:[clock]));}static now(){return clock;}}
  const logger={info(){},warn(){},error(_area,message){throw Error(message);}},market={async getCandles(symbol){const index=Number(symbol.slice(1));return [{ts:clock,open:100,low:index%2?97:99,high:index%2?105:105,close:104}];}};
  const modules={};function module(name){if(modules[name])return modules[name];const filename=path.join(root,name+'.js'),exports={},sandbox={module:{exports},exports,Buffer,Date:FixtureDate,console,process:{env:{}},setTimeout,clearTimeout,require:n=>{
      if(n==='node:crypto'||n==='crypto')return crypto;if(n==='./bybit')return new Proxy({},{get(){return ()=>{throw Error('LIVE_TRANSPORT_FORBIDDEN');};}});if(n==='./marketData')return market;if(n==='./logger')return logger;if(['./util','./risk'].includes(n))return module(n.slice(2));throw Error('unexpected native dependency '+n);
    }};vm.runInNewContext(fs.readFileSync(filename,'utf8'),sandbox,{filename});modules[name]=sandbox.module.exports;if(name==='util')modules[name].uid=prefix=>prefix+'-'+ids++;return modules[name];}
  const risk=module('risk'),executor=module('executor'),excursions=require('../../lib/researchExcursions');
  const source=fs.readFileSync(path.join(root,'engine.js'),'utf8'),a=source.indexOf('async function manageOpenTrades(settings) {'),b=source.indexOf('async function scanOnce() {',a);if(a<0||b<a)throw Error('management span');
  const span=source.slice(a,b),ctx={trades,executor,logger,persistTrades:()=>{persisted++;},recordLockout:t=>locks.push([t.signalId,t.status]),researchCapture:{outcome:(id,status,t)=>outcomes.push([id,status,t.closeReason])},require:n=>{
    if(n!=='./researchExcursions')throw Error('native require '+n);return {observeMinute:(trade,bar)=>{const v=excursions.sample(trade,bar,extremes[trade.id]);if(v)extremes[trade.id]=v;}};
  }};vm.createContext(ctx);vm.runInContext(span,ctx);
  const settings={mode:'paper',riskUsdtPerTrade:.25,maxNotionalUsdt:1000,leverage:1,entryWindowMin:10,entryBufferBps:0,tpThroughBps:0,slSlipBps:0,makerFeePct:.02,takerFeePct:.055,maxHoldMin:60};
  return {identity:{engineSpan:hash(span),executor:hash(fs.readFileSync(path.join(root,'executor.js'))),risk:hash(fs.readFileSync(path.join(root,'risk.js')))},async run(index){clock=Date.parse('2026-10-20T00:00:00Z')+index*60000;outcomes=[];locks=[];extremes={};persisted=0;ids=0;trades.length=0;
      for(let i=0;i<12;i++){const signal={id:'signal-'+i,symbol:'T'+i,side:'BUY',entry:100,sl:98,tp:104,rr:2,score:75,market:{turnover24h:1000}},sizing=risk.sizePosition({entry:100,sl:98,settings,instrument:{qtyStep:.001,tickSize:.01,minOrderQty:.001}});trades.push(executor.createPendingOrder({signal,sizing,settings}));}
      await ctx.manageOpenTrades(settings);if(persisted!==1||outcomes.length!==12||locks.length!==12||trades.some(t=>t.status!=='CLOSED'||t.mode!=='paper'))throw Error('native decision omission');
      const body={outcomes,locks,persisted,extremes,trades:trades.map(t=>({id:t.id,status:t.status,fillPrice:t.fillPrice,exitPrice:t.exitPrice,netPnl:t.netPnl,fees:t.fees,closeReason:t.closeReason}))};return {digest:hash(JSON.stringify(body)),body};
    }};
}
module.exports={create};
