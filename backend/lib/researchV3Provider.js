'use strict';
const pair=(provider,id)=>JSON.stringify([provider,String(id)]);
function pointCollection(c,provider,table,p,{set=false}={}) {
  const collection={diskBacked:true,
    has:id=>c.get(table,pair(provider,id))!==undefined,
    get:id=>c.get(table,pair(provider,id)),
    set(id,value){const key=pair(provider,id);if(c.get(table,key)===undefined)p.counts[table]=(p.counts[table]||0)+1;c.put(table,key,value);return collection;},
    add(id){return collection.set(id,true);},
    delete(id){const key=pair(provider,id);if(c.get(table,key)!==undefined){c.remove(table,key);p.counts[table]--;return true;}return false;},
    *values(){for(const [id,value]of c.entries(table)){const [owner]=JSON.parse(id);if(owner===provider)yield set?JSON.parse(id)[1]:value;}},
    *keys(){for(const [id]of c.entries(table)){const [owner,key]=JSON.parse(id);if(owner===provider)yield key;}},
    get size(){return p.counts[table]||0;}
  };return collection;
}
function create(c,provider,nowMs,day) {
  const module=provider==='Alibaba'?'alibaba':'groq',Ledger=require('../../research/'+module+'-shadow/src/ledger').LedgerIndex;
  const index=new Ledger(c.dir),p=c.get('providerState',provider)||{summary:index.emptySummary(),recentRequests:[],counts:{}};
  p.counts??={};const daily=c.get('providerDays',pair(provider,day))||{dayRequests:0,dayTokens:0,dayCostUsd:0};
  Object.assign(index,daily,{day,summary:p.summary,recentRequests:p.recentRequests.filter(x=>x.at>=nowMs-60000&&x.at<=nowMs)});
  index.requestIds=pointCollection(c,provider,'providerRequestIds',p,{set:true});
  index.terminalRequestIds=pointCollection(c,provider,'providerTerminalIds',p,{set:true});
  index.startedCandidates=pointCollection(c,provider,'providerStartedCandidates',p,{set:true});
  index.candidateInputs=pointCollection(c,provider,'providerCandidates',p);
  index.openRequests=pointCollection(c,provider,'providerOpenRequests',p);
  return {index,p};
}
function reduce(c,provider,row,nowMs=Date.now()) {
  const day=String(row.requested_at_utc||new Date(nowMs).toISOString()).slice(0,10),{index,p}=create(c,provider,nowMs,day);
  index.apply(row,nowMs);
  // Provider admission budgets bound the live minute. A malformed historical
  // burst is represented conservatively by an overflow counter and fences new
  // dispatch for that minute, without dropping an open request or outcome.
  if(index.recentRequests.length>1024){p.minuteOverflowUntil=Math.max(...index.recentRequests.map(x=>x.at))+60000;index.recentRequests=index.recentRequests.slice(-1024);}
  p.summary=index.summary;p.recentRequests=index.recentRequests;
  c.put('providerState',provider,p);c.put('providerDays',pair(provider,day),{dayRequests:index.dayRequests,dayTokens:index.dayTokens,dayCostUsd:index.dayCostUsd||0});
}
async function hydrate(c,provider,index,nowMs) {
  const day=new Date(nowMs).toISOString().slice(0,10),built=create(c,provider,nowMs,day);
  for(const key of ['day','dayRequests','dayTokens','dayCostUsd','summary','recentRequests','requestIds','terminalRequestIds','startedCandidates','candidateInputs','openRequests'])index[key]=built.index[key];
  if(built.p.minuteOverflowUntil>nowMs){index.dayRequests=Number.MAX_SAFE_INTEGER;index.summary.providerMinuteOverflow=true;}
}
module.exports={reduce,hydrate,create,pair};
