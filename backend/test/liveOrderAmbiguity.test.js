'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const lib=path.join(__dirname,'../lib');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const observe=p=>p.then(value=>({value}),error=>({error}));
const response=(result={},retCode=0)=>({ok:true,status:200,text:async()=>JSON.stringify({retCode,result})});
const settings={mode:'live',testnet:false,leverage:2,entryWindowMin:10,makerFeePct:0.02,takerFeePct:0.055,
  maxHoldMin:60,entryBufferBps:0,tpThroughBps:0,slSlipBps:0,universeRefreshMin:60,
  universeSize:10,minTurnover24h:0,tradingEnabled:true,maxOpenPositions:10,maxPerDirection:10,
  timeframe:'1',riskUsdtPerTrade:1,maxNotionalUsdt:1000};
const trade=(id='original')=>({id,signalId:id,symbol:'BTCUSDT',side:'BUY',mode:'live',status:'PENDING',
  leverage:2,qty:1,plannedEntry:100,sl:99,tp:102,createdAt:1000000,expiresAt:1600000,exchangeOrderId:null});

// Actual transport, executor and engine; virtual clock, dummy credentials, in-memory durable
// store and simulated exchange only. No provider calls, real credentials or disk trade state.
function harness(initial=[]) {
  let now=1000000,seq=0,fetchFn=async()=>response(),writeOk=true;
  const timers=new Map(),posts=[],queries=[],events=[],disk={trades:JSON.parse(JSON.stringify(initial))};
  const timer=(fn,delay)=>{const id=++seq;timers.set(id,{at:now+delay,fn});return id;};
  const fakeDate=class extends Date {static now(){return now;}};
  const logger={info(){},warn(){},error(){},debug(){},setLevel(){}};
  const store={read:(key,dflt)=>JSON.parse(JSON.stringify(disk[key]??dflt)),write:(key,value)=>{
    if (!writeOk) return false;disk[key]=JSON.parse(JSON.stringify(value));return true;
  }};
  function load(file,deps={}) {
    const sandbox={module:{exports:{}},process:{env:{BYBIT_API_KEY:'dummy',BYBIT_API_SECRET:'dummy'}},
      Date:fakeDate,URL,URLSearchParams,AbortController,setTimeout:timer,clearTimeout:id=>timers.delete(id),
      fetch:(url,opts)=>fetchFn(url,opts),require:name=>deps[name]??(name==='./logger'?logger:
        name.startsWith('./')?require(path.join(lib,name)):require(name))};
    vm.runInNewContext(fs.readFileSync(path.join(lib,file),'utf8'),sandbox,{filename:file});
    return sandbox.module.exports;
  }
  const bybit=load('bybit.js',{'./util':{sleep:ms=>new Promise(r=>timer(r,ms))}});
  const candles=[{ts:1000000,open:100,high:101,low:99,close:100}];
  const marketData={getCandles:async()=>candles,getTickers:async()=>['BTCUSDT','ETHUSDT'].map(symbol=>({symbol,turnover24h:1000000})),
    getInstruments:async()=>new Map(['BTCUSDT','ETHUSDT'].map(s=>[s,{tickSize:0.1,qtyStep:1}]))};
  const executor=load('executor.js',{'./bybit':bybit,'./marketData':marketData});
  const trades=store.read('trades',[]),persist=()=>store.write('trades',trades);
  const flush=async()=>{for(let i=0;i<120;i++) await Promise.resolve();};
  async function advance(ms) {
    const target=now+ms;await flush();
    while(true) {
      const next=[...timers].filter(([,t])=>t.at<=target).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];
      if (!next) break;now=next[1].at;timers.delete(next[0]);next[1].fn();await flush();
    }
    now=target;await flush();
  }
  function engine(mode='live') {
    const noop=new Proxy({},{get:()=>()=>null});
    const capture={...noop,outcome:(id,event,t)=>events.push({id,event,trade:t}),watch(){},tickerDynamics:()=>new Map(),
      settingsHash:()=>null,candidateLink:()=>null,birth:()=>null};
    const builder=({symbol})=>({ok:true,signal:{id:symbol,symbol,side:'BUY',entry:100,sl:99,tp:102,
      score:100,rr:2,market:{turnover24h:1000000}}});
    return load('engine.js',{'./settings':{effective:()=>({...settings,mode})},'./bybit':bybit,'./store':store,
      './marketData':marketData,'./executor':executor,'./signals':{buildSignalStructure:builder,buildSignalTrend:builder,
        detectBtcRegime:()=>({regime:'UP'})},'./gates':{evaluate:()=>({passed:true})},
      './journal':{buildMarketObservation:()=>({}),captureMarketSnapshot:()=>null,recordSignals(){}},
      './researchCapture':capture,'./marciIndependent':{buildSignal:()=>({ok:false})},
      './locationResearch':noop,'./marciShadow':noop,'./symbolStats':noop,'./researchSupplement':noop,
      './earlyEntryShadow':noop,'./groqShadowProducer':noop,'./alibabaShadowProducer':noop,'./v3Shadow':noop,
      './researchRuntime':{canAdmit:()=>true}});
  }
  function exchange(fn) {
    fetchFn=(url,opts)=>{
      const u=new URL(url),params=opts.method==='POST'?JSON.parse(opts.body):Object.fromEntries(u.searchParams);
      (opts.method==='POST'?posts:queries).push({endpoint:u.pathname,params});
      return fn(u.pathname,params,opts);
    };
  }
  return {bybit,executor,trades,persist,disk,events,engine,exchange,posts,queries,advance,flush,
    writeOk:value=>{writeOk=value;},candles};
}
async function unknownEntry(h) {
  const late=deferred(),t=trade();h.trades.push(t);
  h.exchange(endpoint=>endpoint==='/v5/order/create'?late.promise:Promise.resolve(response()));
  const placed=observe(h.executor.placeLiveOrder({trade:t,settings,trades:h.trades,persist:h.persist}));
  await h.advance(60100);assert.equal((await placed).error.reasonCode,'UNKNOWN_PRIVATE_OUTCOME');
  return {t,late};
}
function order(t,status='New',extra={}) {
  return {symbol:t.symbol,orderLinkId:t.id,orderId:'exchange-original',orderStatus:status,cumExecQty:'0',...extra};
}
function queryExchange(h,rows=[],positions=[],pnl=[]) {
  h.exchange((endpoint,_params,opts)=>{
    assert.equal(opts.method,'GET','reconciliation must not mutate exchange state');
    const list=endpoint==='/v5/position/list'?positions:endpoint==='/v5/position/closed-pnl'?pnl:rows;
    return Promise.resolve(response({list}));
  });
}

test('accepted private entry with late response is UNKNOWN, durably retained and never retried',async()=>{
  const h=harness(),{t,late}=await unknownEntry(h);
  assert.equal(t.privateOutcome.endpoint,'/v5/order/create');assert.equal(t.privateOutcome.orderLinkId,t.id);
  assert.equal(h.disk.trades[0].privateOutcome.orderLinkId,t.id);
  assert.equal(h.posts.filter(x=>x.endpoint==='/v5/order/create').length,1);
  late.resolve(response({orderId:'exchange-original'}));await h.advance(5000);
  assert.equal(t.exchangeOrderId,null);assert.ok(t.privateOutcome);
  assert.equal(h.posts.filter(x=>x.endpoint==='/v5/order/create').length,1);
  queryExchange(h,[order(t)]);const synced=h.executor.syncLiveTrades(h.trades,settings,h.persist);
  await h.advance(1000);await synced;
  assert.equal(t.exchangeOrderId,'exchange-original');assert.equal(t.privateOutcome,undefined);
  assert.equal(h.disk.trades[0].exchangeOrderId,'exchange-original');
  assert.equal(h.queries.find(q=>q.endpoint==='/v5/order/realtime').params.orderLinkId,t.id);
});

test('unknown entry fences another LIVE symbol, including after restart; empty queries keep fence',async()=>{
  const h=harness(),{t}=await unknownEntry(h),second=trade('replacement');second.symbol='ETHUSDT';
  const before=h.posts.length;
  assert.equal((await observe(h.executor.placeLiveOrder({trade:second,settings,trades:h.trades,persist:h.persist}))).error.reasonCode,'LIVE_ADMISSION_FENCED');
  assert.equal(h.posts.length,before);
  const restarted=harness(h.disk.trades);queryExchange(restarted);
  const sync=restarted.executor.syncLiveTrades(restarted.trades,settings,restarted.persist);await restarted.advance(1000);await sync;
  assert.equal(restarted.executor.hasUnresolvedLiveOutcome(restarted.trades),true);
  assert.ok(restarted.queries.some(q=>q.endpoint==='/v5/order/history'&&q.params.orderLinkId===t.id));
});

for (const status of ['Rejected','Cancelled']) test(`matching definitive ${status} with zero fills clears obligation`,async()=>{
  const h=harness(),{t}=await unknownEntry(h);queryExchange(h,[order(t,status)]);
  const sync=h.executor.syncLiveTrades(h.trades,settings,h.persist);await h.advance(1000);await sync;
  assert.equal(t.privateOutcome,undefined);assert.equal(t.status,status.toUpperCase());
  assert.equal(h.executor.hasUnresolvedLiveOutcome(h.trades),false);
  assert.equal(h.disk.trades[0].status,status.toUpperCase());
});

test('history fallback recovers a filled order with ID and fill while ignoring unrelated P&L',async()=>{
  const h=harness(),{t}=await unknownEntry(h);
  h.exchange(endpoint=>Promise.resolve(response({list:endpoint==='/v5/order/history'?
    [order(t,'Filled',{cumExecQty:'1',avgPrice:'100',createdTime:'1000000'})]:
    endpoint==='/v5/position/closed-pnl'?[{symbol:t.symbol,orderId:'unrelated',closedPnl:'50'}]:[]})));
  const sync=h.executor.syncLiveTrades(h.trades,settings,h.persist);await h.advance(1000);await sync;
  assert.equal(t.exchangeOrderId,'exchange-original');assert.equal(t.status,'OPEN');assert.equal(t.fillPrice,100);
  assert.equal(t.privateOutcome,undefined);assert.equal(h.disk.trades[0].status,'OPEN');
});

test('partial fills, missing fill evidence and mismatched identifiers cannot clear fence',async()=>{
  for (const row of [order(trade(),'PartiallyFilled',{cumExecQty:'0.5',avgPrice:'100'}),
    order(trade(),'Rejected',{cumExecQty:undefined}),order(trade(),'New',{orderLinkId:'wrong'})]) {
    const h=harness(),{t}=await unknownEntry(h);queryExchange(h,[row]);
    const sync=h.executor.syncLiveTrades(h.trades,settings,h.persist);await h.advance(1000);await sync;
    assert.ok(t.privateOutcome);assert.equal(t.status,'PENDING');
  }
});

test('per-attempt abort is UNKNOWN without replay; explicit rejection and unsent credentials differ',async()=>{
  const h=harness();let calls=0;
  h.exchange((_endpoint,_params,{signal})=>new Promise((_,reject)=>{
    calls++;signal.addEventListener('abort',()=>{const e=new Error('aborted');e.name='AbortError';reject(e);});
  }));
  const p=observe(h.bybit.privatePost('/v5/order/create',{orderLinkId:'fixed'},false));
  await h.advance(15000);assert.equal((await p).error.reasonCode,'UNKNOWN_PRIVATE_OUTCOME');assert.equal(calls,1);
  h.exchange(()=>Promise.resolve(response({},110001)));
  const rejected=observe(h.bybit.privatePost('/v5/order/create',{},false));await h.advance(100);
  assert.equal((await rejected).error.reasonCode,'PROVEN_PRIVATE_REJECTION');
  h.bybit.keySet=()=>false;
  const result=await observe(h.executor.placeLiveOrder({trade:trade(),settings,trades:[],persist:()=>true}));
  assert.equal(result.error.reasonCode,'PRIVATE_REQUEST_NOT_SENT');
});

test('intent write failure prevents send; reconciliation write failure retains in-memory fence',async()=>{
  const h=harness(),t=trade();h.trades.push(t);h.writeOk(false);
  const p=await observe(h.executor.placeLiveOrder({trade:t,settings,trades:h.trades,persist:h.persist}));
  assert.equal(p.error.reasonCode,'PRIVATE_REQUEST_NOT_SENT');assert.equal(h.posts.length,0);
  h.writeOk(true);h.trades.length=0;const unknown=await unknownEntry(h);h.writeOk(false);
  queryExchange(h,[order(unknown.t)]);const sync=h.executor.syncLiveTrades(h.trades,settings,h.persist);
  await h.advance(1000);await sync;assert.ok(unknown.t.privateOutcome);
});

test('system/duplicate/unrecognised mutation errors and hanging body stay UNKNOWN without retries',async()=>{
  for (const retCode of [10000,10014,10016,110072,40004,999999]) {
    const h=harness();h.exchange(()=>Promise.resolve(response({},retCode)));
    const p=observe(h.bybit.privatePost('/v5/order/create',{orderLinkId:'fixed'},false));await h.flush();
    const e=(await p).error;assert.equal(e.reasonCode,'UNKNOWN_PRIVATE_OUTCOME');
    assert.equal(e.context.orderLinkId,'fixed');assert.equal(h.posts.length,1);
    assert.equal('headers' in e.context,false);assert.equal('params' in e.context,false);
  }
  const h=harness();h.exchange(()=>Promise.resolve({ok:true,status:200,text:()=>new Promise(()=>{})}));
  const body=observe(h.bybit.privatePost('/v5/order/create',{orderLinkId:'body'},false));await h.advance(60000);
  assert.equal((await body).error.reasonCode,'UNKNOWN_PRIVATE_OUTCOME');assert.equal(h.posts.length,1);
});

test('authenticated read-only watchdog stays ordinary deadline; stale private entry never sends',async()=>{
  const h=harness();h.exchange(()=>new Promise(()=>{}));
  const read=observe(h.bybit.privateGet('/v5/order/realtime',{},false));await h.advance(60000);
  assert.equal((await read).error.reasonCode,'EXECUTION_DEADLINE_EXCEEDED');
  const first=observe(h.bybit._test.schedule(()=>new Promise(()=>{})));
  const second=observe(h.bybit._test.schedule(()=>new Promise(()=>{})));
  const entry=observe(h.bybit.privatePost('/v5/order/create',{orderLinkId:'stale'},false));
  await h.advance(120100);await Promise.all([first,second]);
  assert.equal((await entry).error.reasonCode,'QUEUE_WAIT_EXPIRED');assert.equal(h.posts.length,0);
});

test('unknown leverage prevents entry send and resolves only after matching read-only setting',async()=>{
  const h=harness(),t=trade();h.trades.push(t);h.exchange(()=>new Promise(()=>{}));
  const p=observe(h.executor.placeLiveOrder({trade:t,settings,trades:h.trades,persist:h.persist}));await h.advance(60000);
  assert.equal((await p).error.reasonCode,'UNKNOWN_PRIVATE_OUTCOME');assert.equal(h.posts.length,1);
  assert.equal(h.posts[0].endpoint,'/v5/position/set-leverage');
  queryExchange(h,[],[{symbol:t.symbol,leverage:'2',size:'0'}]);
  const sync=h.executor.syncLiveTrades(h.trades,settings,h.persist);await h.advance(1000);await sync;
  assert.equal(t.status,'CANCELLED');assert.equal(t.privateOutcome,undefined);assert.equal(h.posts.length,1);
});

test('unknown cancel cannot expire a trade; matching cancelled state resolves it',async()=>{
  const t=trade();t.exchangeOrderId='exchange-original';t.expiresAt=1;const h=harness([t]);
  h.exchange((endpoint,_params,opts)=>opts.method==='POST'?new Promise(()=>{}):Promise.resolve(response({list:[]})));
  const sync=h.executor.syncLiveTrades(h.trades,settings,h.persist);await h.advance(61000);await sync;
  assert.equal(h.trades[0].status,'PENDING');assert.equal(h.trades[0].privateOutcome.purpose,'cancel');
  queryExchange(h,[order(t,'Cancelled')]);const resolved=h.executor.syncLiveTrades(h.trades,settings,h.persist);
  await h.advance(1000);await resolved;assert.equal(h.trades[0].status,'CANCELLED');assert.equal(h.trades[0].privateOutcome,undefined);
});

test('unknown close uses a deterministic identifier and awaits matching settled P&L',async()=>{
  const t=trade();t.status='OPEN';t.fillPrice=100;const h=harness([t]);
  h.exchange(()=>new Promise(()=>{}));const close=observe(h.executor.closeLivePosition({trade:h.trades[0],settings,persist:h.persist}));
  await h.advance(60000);assert.equal((await close).error.reasonCode,'UNKNOWN_PRIVATE_OUTCOME');
  assert.equal(h.posts[0].params.orderLinkId,`${t.id}-c1`);
  const closeRow=order(t,'Filled',{orderLinkId:`${t.id}-c1`,orderId:'close-id',cumExecQty:'1',avgPrice:'101'});
  queryExchange(h,[closeRow],[],[{symbol:t.symbol,orderId:'wrong',closedPnl:'10'}]);
  const first=h.executor.syncLiveTrades(h.trades,settings,h.persist);await h.advance(1000);await first;assert.ok(h.trades[0].privateOutcome);
  queryExchange(h,[closeRow],[],[{symbol:t.symbol,orderId:'close-id',closedPnl:'1',avgExitPrice:'101'}]);
  const second=h.executor.syncLiveTrades(h.trades,settings,h.persist);await h.advance(1000);await second;
  assert.equal(h.trades[0].status,'CLOSED');assert.equal(h.trades[0].privateOutcome,undefined);
});

test('partial unknown close cannot clear admission using a matching partial P&L record',async()=>{
  const t=trade();t.status='OPEN';t.fillPrice=100;
  t.privateOutcome={purpose:'close',endpoint:'/v5/order/create',orderLinkId:`${t.id}-c1`,symbol:t.symbol,testnet:false};
  const h=harness([t]),row=order(t,'Filled',{orderLinkId:`${t.id}-c1`,orderId:'partial-close',cumExecQty:'0.5'});
  queryExchange(h,[row],[],[{symbol:t.symbol,orderId:'partial-close',closedPnl:'1'}]);
  const sync=h.executor.syncLiveTrades(h.trades,settings,h.persist);await h.advance(1000);await sync;
  assert.equal(h.trades[0].status,'OPEN');assert.ok(h.trades[0].privateOutcome);
});

test('actual engine records UNKNOWN without rejection and fences next scan/reset/panic',async()=>{
  const h=harness();h.exchange(endpoint=>endpoint==='/v5/order/create'?new Promise(()=>{}):Promise.resolve(response()));
  const engine=h.engine();const scan=engine.scanOnce();await h.advance(61000);await scan;
  assert.equal(engine.state.lastError,null);assert.equal(h.events.some(x=>x.event==='ORDER_REJECTED'),false);
  assert.equal(h.events.filter(x=>x.event==='UNKNOWN_PRIVATE_OUTCOME').length,1);
  assert.equal(h.disk.trades.length,1);assert.ok(h.disk.trades[0].privateOutcome);
  queryExchange(h);const again=engine.scanOnce();await h.advance(1000);await again;
  assert.equal(engine.state.lastError,null);assert.equal(h.posts.filter(x=>x.endpoint==='/v5/order/create').length,1);
  assert.equal(engine.resetTrades().ok,false);
  await engine.panicClose();assert.ok(h.disk.trades[0].privateOutcome);assert.equal(h.disk.trades[0].status,'PENDING');
});

test('actual engine distinguishes proven rejection, not-sent and successful acknowledgement',async()=>{
  for (const outcome of ['reject','not-sent','success']) {
    const h=harness();h.exchange(endpoint=>Promise.resolve(endpoint==='/v5/order/create'?
      response({orderId:'ack'},outcome==='reject'?110001:0):response()));
    if (outcome==='not-sent') h.bybit.keySet=()=>false;
    const engine=h.engine(),scan=engine.scanOnce();await h.advance(2000);await scan;
    assert.equal(engine.state.lastError,null);
    assert.equal(h.events.filter(x=>x.event==={reject:'ORDER_REJECTED','not-sent':'ORDER_NOT_SENT',success:'ORDER_ACK'}[outcome]).length,2);
    if (outcome==='success') assert.ok(h.disk.trades.every(t=>t.exchangeOrderId==='ack'&&!t.privateOutcome));
    else assert.equal(h.disk.trades.length,0);
  }
});

test('an in-flight entry reserves LIVE admission before its outcome is known',async()=>{
  const h=harness(),t=trade();h.trades.push(t);h.exchange(()=>new Promise(()=>{}));
  const first=observe(h.executor.placeLiveOrder({trade:t,settings,trades:h.trades,persist:h.persist}));await h.flush();
  const second=await observe(h.executor.placeLiveOrder({trade:trade('next'),settings,trades:h.trades,persist:h.persist}));
  assert.equal(second.error.reasonCode,'LIVE_ADMISSION_FENCED');assert.equal(h.posts.length,1);
  await h.advance(60000);assert.equal((await first).error.reasonCode,'UNKNOWN_PRIVATE_OUTCOME');
});

test('history retention cannot trim an old unresolved obligation',async()=>{
  const t=trade();t.privateOutcome={purpose:'entry',endpoint:'/v5/order/create',orderLinkId:t.id,symbol:t.symbol,testnet:false};
  const history=Array.from({length:5001},(_,i)=>({id:`old-${i}`,mode:'paper',status:'CLOSED'}));
  const h=harness([t,...history]),engine=h.engine();await engine.panicClose();
  assert.equal(h.disk.trades.length,5001);assert.equal(h.disk.trades[0].id,t.id);assert.ok(h.disk.trades[0].privateOutcome);
});

test('tiny PAPER/risk smoke: normal paper admission, risk sizing and ambiguous candle resolves as loss',async()=>{
  const h=harness(),engine=h.engine('paper');await engine.scanOnce();assert.equal(engine.state.lastError,null);
  assert.equal(h.posts.length,0);assert.equal(h.disk.trades.length,2);
  const risk=require('../lib/risk');const sized=risk.sizePosition({entry:100,sl:99,settings,instrument:{qtyStep:1,tickSize:0.1}});
  assert.equal(sized.actualRisk,1);assert.equal(sized.qty,1);
  const t={...trade(),mode:'paper'};h.candles[0].high=103;h.candles[0].low=98;
  assert.equal(await h.executor.stepPaperTrade(t,settings),true);assert.equal(t.status,'CLOSED');
  assert.equal(t.exitPrice,99);assert.ok(t.netPnl<0);
});
