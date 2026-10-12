'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../lib/bybit.js'),'utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const observe=p=>p.then(value=>({value}),error=>({error}));
const response=(result={},retCode=0,status=200)=>({ok:status===200,status,text:async()=>JSON.stringify({retCode,result,time:1})});

// Isolated real module, with only clock, network and logger replaced. No network or wall-clock waits.
function harness() {
  let now=1000000,id=0;
  const timers=new Map(),events=[];
  const setTimer=(fn,delay)=>{const key=++id;timers.set(key,{at:now+delay,fn});return key;};
  const sandbox={module:{exports:{}},process:{env:{}},URL,URLSearchParams,AbortController,
    Date:class extends Date {static now(){return now;}},setTimeout:setTimer,clearTimeout:key=>timers.delete(key),
    fetch:async()=>response(),require:name=>name==='./logger'?{warn(){},info(){}}:
      name==='./util'?{sleep:ms=>new Promise(resolve=>setTimer(resolve,ms))}:require(name)};
  vm.runInNewContext(source,sandbox,{filename:'bybit.js'});
  const api=sandbox.module.exports;
  api.setOperationalSink(event=>events.push(event));
  const flush=async()=>{for(let i=0;i<50;i++)await Promise.resolve();};
  async function advance(ms) {
    const target=now+ms;await flush();
    while(true){
      const next=[...timers].filter(([,t])=>t.at<=target).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];
      if(!next)break;
      now=next[1].at;timers.delete(next[0]);next[1].fn();await flush();
    }
    now=target;await flush();
  }
  return {api,events,advance,flush,now:()=>now,fetch:fn=>{sandbox.fetch=fn;}};
}

test('never-settling execution rejects at 60s and the serial worker proceeds',async()=>{
  const h=harness(),a=observe(h.api._test.schedule(()=>new Promise(()=>{}),{endpoint:'/wedged'}));
  let executed=0;const b=h.api._test.schedule(()=>++executed,{endpoint:'/next'});
  await h.advance(59999);assert.equal(executed,0);
  await h.advance(1);assert.equal((await a).error.reasonCode,'EXECUTION_DEADLINE_EXCEEDED');
  assert.equal(await b,1);assert.equal(h.api.getOperationalState().pumping,false);
  const event=h.events.find(e=>e.reasonCode==='EXECUTION_DEADLINE_EXCEEDED');
  assert.equal(event.endpoint,'/wedged');assert.equal(event.elapsedMs,60000);
});

for(const late of ['resolve','reject'])test(`late ${late} cannot settle twice or disturb the next active job`,async()=>{
  const h=harness(),first=deferred(),second=deferred();let settlements=0;
  const a=observe(h.api._test.schedule(()=>first.promise,{endpoint:'/first'})).then(x=>{settlements++;return x;});
  const b=h.api._test.schedule(()=>second.promise,{endpoint:'/second'});
  await h.advance(60000);assert.equal((await a).error.reasonCode,'EXECUTION_DEADLINE_EXCEEDED');
  first[late](late==='resolve'?'late':new Error('late failure'));await h.flush();
  assert.equal(settlements,1);assert.equal(h.api.getOperationalState().activeEndpoint,'/second');
  second.resolve('next');await h.flush();assert.equal(await b,'next');
  assert.equal(h.events.filter(e=>e.reasonCode==='EXECUTION_DEADLINE_EXCEEDED').length,1);
});

test('both stale queue classes are rejected without transport execution',async()=>{
  const h=harness(),block=deferred();const first=h.api._test.schedule(()=>block.promise);
  let calls=0;
  const critical=observe(h.api._test.schedule(()=>calls++,{endpoint:'/stale-critical'}));
  const research=observe(h.api._test.schedule(()=>calls++,{research:true,endpoint:'/stale-research'}));
  await h.flush();
  // Research expires behind a single job; critical expiry needs two bounded jobs.
  await h.advance(30000);block.resolve('done');await h.flush();await h.advance(1000);
  assert.equal(await first,'done');assert.equal((await research).error.reasonCode,'QUEUE_WAIT_EXPIRED');
  assert.equal((await critical).value,0);assert.equal(calls,1);
  const g=harness(),gates=[deferred(),deferred()];
  const running=gates.map(d=>observe(g.api._test.schedule(()=>d.promise)));
  let staleCalls=0;const stale=observe(g.api._test.schedule(()=>staleCalls++,{endpoint:'/stale'}));
  await g.advance(120000);
  assert.equal((await stale).error.reasonCode,'QUEUE_WAIT_EXPIRED');assert.equal(staleCalls,0);
  await Promise.all(running);
  assert.equal(g.events.find(e=>e.endpoint==='/stale').elapsedMs,120000);
});

test('critical three-attempt retry envelope succeeds before the outer deadline',async()=>{
  const h=harness();let attempts=0;
  h.fetch((_url,{signal})=>{
    attempts++;
    if(attempts<3)return new Promise((_,reject)=>signal.addEventListener('abort',()=>{
      const e=new Error('aborted');e.name='AbortError';reject(e);
    },{once:true}));
    return new Promise(resolve=>{
      // Third attempt remains slow, but settles just before its 15s abort.
      h.advanceThird=()=>resolve(response({ok:true}));
    });
  });
  const p=h.api.publicGet('/v5/market/kline',{symbol:'TEST'},false);
  await h.advance(46199);h.advanceThird();await h.flush();
  assert.equal((await p).ok,true);assert.equal(attempts,3);
  assert.equal(h.events.some(e=>e.reasonCode==='EXECUTION_DEADLINE_EXCEEDED'),false);
});

test('research retains one 7s abort attempt and stamped response semantics',async()=>{
  const h=harness();let attempts=0;
  h.fetch((_url,{signal})=>new Promise((_,reject)=>{
    attempts++;signal.addEventListener('abort',()=>{const e=new Error('aborted');e.name='AbortError';reject(e);},{once:true});
  }));
  const p=observe(h.api.researchGet('/research',{},false));await h.advance(6999);
  assert.equal(h.api.getOperationalState().activeEndpoint,'/research');await h.advance(1);
  assert.equal((await p).error.name,'AbortError');assert.equal(attempts,1);
  h.fetch(async()=>response({ok:true}));const stamped=h.api.researchGetStamped('/stamped',{},false);
  await h.advance(350);const r=await stamped;assert.equal(r.result.ok,true);assert.equal(r.sourceAt,1);
  assert.equal(h.events.some(e=>e.reasonCode==='EXECUTION_DEADLINE_EXCEEDED'),false);
});

test('research watchdog is independent of abort and proceeds after 10s',async()=>{
  const h=harness();h.fetch(()=>new Promise(()=>{}));
  const p=observe(h.api.researchGet('/hung-research',{},false));
  const next=h.api._test.schedule(()=>42);await h.advance(10000);
  assert.equal((await p).error.reasonCode,'EXECUTION_DEADLINE_EXCEEDED');assert.equal(await next,42);
});

test('critical priority includes arrivals during a research gap',async()=>{
  const h=harness(),order=[];await h.api._test.schedule(()=>order.push('first'));
  const research=h.api._test.schedule(()=>order.push('research'),{research:true});
  await h.advance(100);const critical=h.api._test.schedule(()=>order.push('critical'));
  await h.advance(1000);await Promise.all([critical,research]);
  assert.deepEqual(order,['first','critical','research']);
});

test('waiting capacities remain exactly 128 critical and 16 research',async()=>{
  const h=harness(),block=deferred(),first=h.api._test.schedule(()=>block.promise);
  await h.flush();
  const queued=Array.from({length:128},()=>observe(h.api._test.schedule(()=>1)));
  const research=Array.from({length:16},()=>observe(h.api._test.schedule(()=>1,{research:true})));
  const criticalOverflow=await observe(h.api._test.schedule(()=>1));
  const researchOverflow=await observe(h.api._test.schedule(()=>1,{research:true}));
  assert.match(criticalOverflow.error.message,/capacity exceeded/);
  assert.equal(researchOverflow.error.reasonCode,'RESEARCH_QUEUE_CAPACITY');
  const s=h.api.getOperationalState();assert.equal(s.criticalQueueDepth,128);assert.equal(s.researchQueueDepth,16);
  block.resolve(1);await h.advance(30000);await Promise.all([first,...queued,...research]);
});

test('state and operational events expose active/queue ages, limits and no params',async()=>{
  const h=harness(),block=deferred(),first=h.api._test.schedule(()=>block.promise,{endpoint:'/active'});
  const critical=h.api._test.schedule(()=>1,{endpoint:'/critical'});
  const research=h.api._test.schedule(()=>1,{endpoint:'/research',research:true});
  await h.advance(2000);const s=h.api.getOperationalState();
  assert.equal(s.pumping,true);assert.equal(s.activeEndpoint,'/active');assert.equal(s.activeClass,'critical');
  assert.equal(s.activeStartedAt,1000000);assert.equal(s.activeAgeMs,2000);
  assert.equal(s.criticalOldestQueuedAgeMs,2000);assert.equal(s.researchOldestQueuedAgeMs,2000);
  assert.equal(s.criticalQueueCapacity,128);assert.equal(s.researchQueueCapacity,16);
  assert.equal(s.criticalExecutionDeadlineMs,60000);assert.equal(s.researchExecutionDeadlineMs,10000);
  assert.equal(s.criticalQueueWaitDeadlineMs,120000);assert.equal(s.researchQueueWaitDeadlineMs,30000);
  block.resolve(1);await h.advance(1000);await Promise.all([first,critical,research]);
  assert.equal(h.api.getOperationalState().activeEndpoint,null);
  assert.equal(h.api.getOperationalState().criticalOldestQueuedAgeMs,null);
  assert.equal('params' in s,false);
});

test('endpoint/global rate-limit cooldowns remain 60s and critical bypass is preserved',async()=>{
  const h=harness();h.fetch(async()=>response({},10006));
  const limited=observe(h.api.researchGet('/limited',{},false));await h.flush();
  assert.equal((await limited).error.retCode,10006);
  const endpointEvent=h.events.find(e=>e.type==='BYBIT_RATE_LIMIT');
  assert.equal(endpointEvent.cooldownScope,'ENDPOINT');assert.equal(endpointEvent.endpointCooldownUntil,h.now()+60000);
  assert.equal(endpointEvent.pumping,true);assert.equal(endpointEvent.criticalQueueCapacity,128);
  assert.equal((await observe(h.api.researchGet('/limited',{},false))).error.reasonCode,'COOLDOWN_ACTIVE');
  h.fetch(async()=>response({ok:true}));const critical=h.api.publicGet('/limited',{},false);
  const other=h.api.researchGet('/other',{},false);await h.advance(1000);await Promise.all([critical,other]);
  h.api._test.applyRateLimitCooldown({status:429},'/other');
  assert.equal((await observe(h.api.researchGet('/unrelated',{},false))).error.reasonCode,'COOLDOWN_ACTIVE');
  await h.advance(60000);assert.equal((await h.api.researchGet('/limited',{},false)).ok,true);
});

test('late real fetch result cannot update quote stamps or start a retry burst',async()=>{
  const h=harness(),late=deferred();let calls=0;
  h.fetch(()=>{calls++;return calls===1?late.promise:Promise.resolve(response({ok:true}));});
  const first=observe(h.api.publicGet('/v5/market/tickers',{},false));
  const next=h.api.publicGet('/next',{},false);await h.advance(60000);
  assert.equal((await first).error.reasonCode,'EXECUTION_DEADLINE_EXCEEDED');assert.equal((await next).ok,true);
  late.resolve(response({list:[{symbol:'LATE',bid1Price:'1',ask1Price:'2'}]}));await h.flush();
  assert.equal(h.api.quoteAt('LATE',false,h.now()),null);assert.equal(calls,2);
  assert.equal(h.api.getOperationalState().pumping,false);
});

test('late rate-limit rejection cannot retry or change cooldown after expiry',async()=>{
  const h=harness(),late=deferred();let calls=0;
  h.fetch(()=>{calls++;return late.promise;});
  const first=observe(h.api.publicGet('/late-limit',{},false));await h.advance(60000);
  assert.equal((await first).error.reasonCode,'EXECUTION_DEADLINE_EXCEEDED');
  const e=new Error('rate limit');e.retCode=10006;late.reject(e);await h.advance(2000);
  assert.equal(calls,1);assert.equal(h.api.getOperationalState().researchCooldownUntil,0);
});

test('a hanging response body also releases the worker at the outer deadline',async()=>{
  const h=harness();h.fetch(async()=>({ok:true,status:200,text:()=>new Promise(()=>{})}));
  const p=observe(h.api.publicGet('/hung-body',{},false));const next=h.api._test.schedule(()=>42);
  await h.advance(60000);assert.equal((await p).error.reasonCode,'EXECUTION_DEADLINE_EXCEEDED');
  assert.equal(await next,42);
});
