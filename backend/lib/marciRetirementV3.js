'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const {canonical}=require('./researchRequest'),{Scratch}=require('./researchV3/scratch');
const C=require('./researchV3/codec'),Spool=require('./researchV3/spool'),IO=require('./researchV3/io');
const hash=x=>crypto.createHash('sha256').update(canonical(x)).digest('hex');
function ledger(root,visit){const file=path.join(root,'marciShadowTrades.json');if(!fs.existsSync(file))return null;require('./readCheckpointJson').visitJsonArray(file,visit);return IO.hashFile(file);}
function eventHash(c,episode,work) {
  function* records(){for(const e of c.values('events'))if(e.episodeId===episode){const pair=[e.eventId,e.sha256],k=C.key('E','record',[e.eventId]);yield C.record(k,Buffer.from(JSON.stringify(pair)),e.sequence);}}
  const cmp=(a,b)=>{const x=JSON.parse(a.value).toString(),y=JSON.parse(b.value).toString();return x<y?-1:x>y?1:0;};
  const sorted=Spool.sort(path.join(work.dir,crypto.randomUUID()),records(),cmp),input=new Spool.Input(sorted),h=crypto.createHash('sha256');let comma=false,n=0;
  try{h.update('[');let r;while((r=input.next())){if(comma)h.update(',');h.update(r.value);comma=true;n++;}h.update(']');return {sha256:h.digest('hex'),count:n};}finally{input.close();}
}
function accounting(c,root) {
  const none={receipt:null,coveredEpisodes:new Set(),coveredRows:new Set(),rows:[],failure:null,summary:{native:0,counterfactuals:0}};
  const work=new Scratch(os.tmpdir(),'orayan-v3-marci-');
  try {
    const R=require('./marciRetirement'),r=R.read(root);let coveredRows=new Set(),coveredEpisodes=new Set();
    if(r) {
      const {receipt_id,...body}=r;
      if(r.contract!=='MARCI_RETIREMENT_V1'||r.state!=='OBSERVATION_TERMINATED_EXPERIMENT_RETIRED'||r.outcome_claim!=='NONE'||receipt_id!==hash(body)||r.source_epoch!==c.state.epochId||!Number.isFinite(r.cutoff)||r.cutoff>Date.now())throw Error('RETIREMENT_RECEIPT_INVALID');
      for(const x of r.obligations){if(coveredRows.has(x.index))throw Error('RETIREMENT_LEDGER_MISMATCH');coveredRows.add(x.index);work.put('obligations',x.index,x);}
      for(const x of r.episodes){const e=c.get('episodes',x.id),events=eventHash(c,x.id,work);if(!e||hash(e)!==x.state_sha256||events.sha256!==x.event_manifest_sha256||coveredEpisodes.has(x.id))throw Error('RETIREMENT_EPISODE_CHANGED');coveredEpisodes.add(x.id);}
    }
    const summary={native:0,counterfactuals:0};let verified=0;
    const ledgerHash=ledger(root,(t,i)=>{const expected=work.get('obligations',i);if(expected){if(t.id!==expected.id||hash(t)!==expected.row_sha256)throw Error('RETIREMENT_LEDGER_MISMATCH');verified++;return;}if(['OPEN','PENDING'].includes(t.status))summary.native++;if(t.marciCounterfactual?.tracking===true)summary.counterfactuals++;});
    if(r&&(ledgerHash!==r.ledger_sha256||verified!==r.obligations.length))throw Error('RETIREMENT_LEDGER_MISMATCH');
    return {receipt:r,coveredRows,coveredEpisodes,rows:[],failure:null,summary};
  }catch(e){const summary={native:0,counterfactuals:0};ledger(root,t=>{if(['OPEN','PENDING'].includes(t.status))summary.native++;if(t.marciCounterfactual?.tracking===true)summary.counterfactuals++;});return {...none,failure:e.message,summary};}finally{work.close();}
}
async function build(c,root,commit,visit,at) {
  if(!/^[a-f0-9]{40}$/.test(commit||'')||!Number.isFinite(at))throw Error('RETIREMENT_PROVENANCE_REQUIRED');
  const epoch=c.state.epochId,watermark=c.state.sequence,work=new Scratch(os.tmpdir(),'orayan-v3-marci-build-');
  try {
    const episodes=[],obligations=[];let size=0;
    const ledgerHash=ledger(root,(t,index)=>{if(!['OPEN','PENDING'].includes(t.status)&&t.marciCounterfactual?.tracking!==true)return;if(!t.id||!Number.isFinite(t.createdAt)||t.createdAt>at)throw Error('MARCI_TRADE_PROVENANCE_INVALID');const row={index,id:t.id,row_sha256:hash(t),lifecycle:['OPEN','PENDING'].includes(t.status),counterfactual:t.marciCounterfactual?.tracking===true};size+=Buffer.byteLength(JSON.stringify(row));if(size>3*1024*1024)throw Error('RETIREMENT_RECEIPT_SIZE_LIMIT');obligations.push(row);});
    await visit(row=>{if(!c.get('openEpisodes',row.episodeId))return;work.put('seen',row.eventId,true);if(row.strategy!=='MARCI'||row.at>at)work.put('invalid',row.episodeId,true);});
    for(const [id,e]of c.openEpisodes()) {
      if(work.has('invalid',id))continue;let valid=true;for(const m of c.values('events'))if(m.episodeId===id&&!work.has('seen',m.eventId)){valid=false;break;}if(!valid)continue;
      const events=eventHash(c,id,work);if(!events.count)continue;const row={id,state_sha256:hash(e),event_manifest_sha256:events.sha256};size+=Buffer.byteLength(JSON.stringify(row));if(size>3*1024*1024)throw Error('RETIREMENT_RECEIPT_SIZE_LIMIT');episodes.push(row);
    }
    if(c.state.sequence!==watermark||c.state.epochId!==epoch)throw Error('RETIREMENT_AUDIT_MOVED');
    const body={contract:'MARCI_RETIREMENT_V1',state:'OBSERVATION_TERMINATED_EXPERIMENT_RETIRED',outcome_claim:'NONE',cutoff:at,source_epoch:epoch,implementation_commit:commit,audited_watermark:watermark,ledger_sha256:ledgerHash,obligations,episodes:episodes.sort((a,b)=>a.id.localeCompare(b.id))};
    return {...body,receipt_id:hash(body)};
  }finally{work.close();}
}
module.exports={accounting,build};
