'use strict';
const C=require('./codec'),{fault}=require('./cooperative');
const CAPS=Object.freeze({encoded:8*1024*1024,accounted:16*1024*1024,entries:32768});
const TRIGGERS=Object.freeze({encoded:4*1024*1024,accounted:8*1024*1024,entries:16384});
const zero=()=>({encoded:0,accounted:0,entries:0});
function cost(r){return (r.key.length+r.value.length+80)*3+r.key.length*4+512;}
class Budget {
  // Unknown protected/completion envelope closes ordinary admission by default.
  constructor({reserve=null,completionBoundMs=null,clock=()=>performance.now()}={}){
    this.reserve=reserve&&{...reserve};this.completionBoundMs=completionBoundMs;this.clock=clock;
    this.used=zero();this.pending=null;this.P=null;this.N=new Map();this.high=zero();this.ordinaryReason=null;
    if(reserve)for(const k of Object.keys(CAPS))C.integer(reserve[k],CAPS[k]);
    if(completionBoundMs!==null)C.integer(completionBoundMs);
  }
  precommit(records,encoded,{protectedWrite=false,liability=zero(),scheduler=null}={}){
    if(this.pending)fault('WRITER_BUSY');if(!protectedWrite){const fence=scheduler?.ordinaryFence();
      if(fence||this.ordinaryReason||!this.reserve||!this.completionBoundMs||this.P&&this.clock()-this.pinnedAt>this.completionBoundMs)fault(fence||this.ordinaryReason||'ENVELOPE_UNQUALIFIED');}
    C.integer(encoded,CAPS.encoded);if(records.length>32768)fault('OVERLAY_CAPACITY');
    let accounted=0,entries=0,oldCost=0;const ids=new Set();
    for(const r of records){C.record(r.key,r.value,r.lsn,r.flags,r.digest);const id=r.key.toString('hex');if(ids.has(id))C.fail('duplicate transaction key');ids.add(id);accounted+=cost(r);entries++;oldCost+=this.N.get(id)?.cost||0;}
    // Reserve full replacement/transient copies before WAL acceptance; no shrink credit before apply.
    const request={encoded,accounted,entries};
    for(const k of Object.keys(CAPS)){C.integer(liability[k]);const protectedReserve=protectedWrite?0:(this.reserve?.[k]||0)+liability[k];if(this.used[k]+request[k]+protectedReserve>CAPS[k])fault('OVERLAY_CAPACITY');}
    this.pending={request,records,oldCost,ids,liability,protectedWrite};
    return this.pending;
  }
  apply(ticket){if(ticket!==this.pending)C.fail('reservation identity');
    const {request,records,liability,protectedWrite}=ticket;
    for(const r of records){const id=r.key.toString('hex'),prev=this.N.get(id);if(prev&&r.lsn<=prev.r.lsn)C.fail('overlay LSN');
      this.used.accounted-=prev?.cost||0;if(!prev)this.used.entries++;this.N.set(id,{r,cost:cost(r)});this.used.accounted+=cost(r);}
    this.used.encoded+=request.encoded;
    if(this.reserve)for(const k of Object.keys(CAPS))this.reserve[k]=protectedWrite?Math.max(0,this.reserve[k]-request[k]):this.reserve[k]+liability[k];
    this.pending=null;for(const k of Object.keys(CAPS))this.high[k]=Math.max(this.high[k],this.used[k]);this.assert();
  }
  cancel(ticket){if(ticket!==this.pending)C.fail('reservation identity');this.pending=null;}
  pin(){if(this.P||this.pending)fault('CYCLE_BUSY');this.P=this.N;this.N=new Map();this.prefix={...this.used};this.pinnedAt=this.clock();return this.P;}
  retire(){if(!this.P)C.fail('no prefix');let accounted=0,entries=0;for(const v of this.P.values()){accounted+=v.cost;entries++;}this.used.encoded-=this.prefix.encoded;this.used.accounted-=accounted;this.used.entries-=entries;this.P=null;this.prefix=null;this.assert();}
  lookup(key){const id=key.toString('hex');return this.N.get(id)?.r||this.P?.get(id)?.r||null;}
  trigger(){return Object.keys(CAPS).some(k=>this.used[k]>=TRIGGERS[k]);}
  assert(){for(const k of Object.keys(CAPS))if(this.used[k]<0||this.used[k]>CAPS[k])C.fail('global budget '+k);}
  status(){return {used:{...this.used},reserved:this.reserve&&{...this.reserve},pending:this.pending?.request||zero(),high:{...this.high},P:this.P?.size||0,N:this.N.size};}
}
module.exports={Budget,CAPS,TRIGGERS,cost,zero};
