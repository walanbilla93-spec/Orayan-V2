'use strict';
// Additive observation termination. Never updates trades, outcomes, or canonical episodes.
const fs=require('fs'),path=require('path');
const {canonical}=require('./researchRequest');
const sha=x=>require('crypto').createHash('sha256').update(x).digest('hex');
const hash=x=>sha(canonical(x));
const NAME='marci-retirement-v1.json',LIMIT=4*1024*1024;
const unresolved=e=>!e.controlResolved||Object.values(e.controls||{}).some(v=>!v)||Object.values(e.arms||{}).some(v=>!v);
function ledger(root){
 const file=path.join(root,'marciShadowTrades.json'),bytes=fs.existsSync(file)?fs.readFileSync(file):null;
 const rows=bytes?JSON.parse(bytes.toString('utf8')):[];
 if(!Array.isArray(rows))throw Error('MARCI_LEDGER_INVALID');
 return {rows,sha256:bytes?sha(bytes):null};
}
async function build(c,root,commit,visit,at=Date.now()){
 if(!/^[a-f0-9]{40}$/.test(commit||'')||!Number.isFinite(at))throw Error('RETIREMENT_PROVENANCE_REQUIRED');
 const old=ledger(root),epoch=c.state.epochId,watermark=c.state.sequence,proof=new Map();
 const candidates=new Set(Object.entries(c.state.episodes).filter(([,e])=>unresolved(e)).map(([id])=>id));
 // Prove ownership from checksummed canonical records, never from an ID prefix.
 await visit(row=>{
  if(!candidates.has(row.episodeId))return;
  let p=proof.get(row.episodeId);if(!p)proof.set(row.episodeId,p={ids:new Set(),marci:true});
  p.ids.add(row.eventId);if(row.strategy!=='MARCI')p.marci=false;
 });
 if(c.state.epochId!==epoch||c.state.sequence!==watermark)throw Error('RETIREMENT_AUDIT_MOVED');
 const indexed=new Map();
 for(const e of Object.values(c.state.events))if(candidates.has(e.episodeId)){
  if(!indexed.has(e.episodeId))indexed.set(e.episodeId,[]);indexed.get(e.episodeId).push(e);
 }
 const episodes=[];
 for(const [id,e]of Object.entries(c.state.episodes)){
  if(!unresolved(e))continue;
  const p=proof.get(id),events=indexed.get(id)||[];
  if(!p?.marci||!events.length||events.some(x=>!p.ids.has(x.eventId)||x.at>at))continue;
  episodes.push({id,state_sha256:hash(e),event_manifest_sha256:hash(events.map(x=>[x.eventId,x.sha256]).sort())});
 }
 const obligations=[];
 old.rows.forEach((t,index)=>{
  if(!['OPEN','PENDING'].includes(t.status)&&t.marciCounterfactual?.tracking!==true)return;
  if(!t.id||!Number.isFinite(t.createdAt)||t.createdAt>at)throw Error('MARCI_TRADE_PROVENANCE_INVALID');
  obligations.push({index,id:t.id,row_sha256:hash(t),lifecycle:['OPEN','PENDING'].includes(t.status),counterfactual:t.marciCounterfactual?.tracking===true});
 });
 const body={contract:'MARCI_RETIREMENT_V1',state:'OBSERVATION_TERMINATED_EXPERIMENT_RETIRED',
  outcome_claim:'NONE',cutoff:at,source_epoch:epoch,implementation_commit:commit,
  audited_watermark:watermark,ledger_sha256:old.sha256,obligations,episodes:episodes.sort((a,b)=>a.id.localeCompare(b.id))};
 const receipt={...body,receipt_id:hash(body)};
 if(Buffer.byteLength(canonical(receipt))>LIMIT)throw Error('RETIREMENT_RECEIPT_SIZE_LIMIT');
 return receipt;
}
function publish(root,receipt){
 const file=path.join(root,NAME),bytes=Buffer.from(canonical(receipt));
 if(bytes.length>LIMIT)throw Error('RETIREMENT_RECEIPT_SIZE_LIMIT');
 // Exclusive publication. A partial file remains a visible blocker; never replace history.
 const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 if(process.platform!=='win32'){const d=fs.openSync(root,'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}
 return receipt;
}
function read(root){const file=path.join(root,NAME);if(!fs.existsSync(file))return null;
 if(fs.statSync(file).size>LIMIT)throw Error('RETIREMENT_RECEIPT_SIZE_LIMIT');return JSON.parse(fs.readFileSync(file,'utf8'));}
function accounting(c,root){
 const old=ledger(root),none={receipt:null,coveredEpisodes:new Set(),coveredRows:new Set(),failure:null};
 try{
  const r=read(root);if(!r)return {...none,rows:old.rows};
  const {receipt_id,...body}=r;
  if(r.contract!=='MARCI_RETIREMENT_V1'||r.state!=='OBSERVATION_TERMINATED_EXPERIMENT_RETIRED'||r.outcome_claim!=='NONE'||
   receipt_id!==hash(body)||r.source_epoch!==c.state.epochId||r.ledger_sha256!==old.sha256||
   !Number.isFinite(r.cutoff)||r.cutoff>Date.now()||!Array.isArray(r.obligations)||!Array.isArray(r.episodes))throw Error('RETIREMENT_RECEIPT_INVALID');
  const coveredRows=new Set(),coveredEpisodes=new Set(),wanted=new Set(r.episodes.map(x=>x.id)),manifests=new Map();
  for(const e of Object.values(c.state.events))if(wanted.has(e.episodeId)){
   if(!manifests.has(e.episodeId))manifests.set(e.episodeId,[]);manifests.get(e.episodeId).push([e.eventId,e.sha256]);
  }
  for(const x of r.obligations){const t=old.rows[x.index];
   if(!t||t.id!==x.id||hash(t)!==x.row_sha256||coveredRows.has(x.index))throw Error('RETIREMENT_LEDGER_MISMATCH');
   coveredRows.add(x.index);
  }
  for(const x of r.episodes){const e=c.state.episodes[x.id];
   const events=manifests.get(x.id)||[];
   if(!e||hash(e)!==x.state_sha256||coveredEpisodes.has(x.id)||
    hash(events.sort())!==x.event_manifest_sha256)throw Error('RETIREMENT_EPISODE_CHANGED');
   coveredEpisodes.add(x.id);
  }
  return {receipt:r,coveredEpisodes,coveredRows,rows:old.rows,failure:null};
 }catch(e){return {...none,rows:old.rows,failure:e.message};}
}
async function record(commit){
 const m=require('./maintenance').current(),root=require('./store').DATA_DIR,c=require('./researchRuntime').current();
 // Publication changes the snapshot boundary. Require a drained research seal, then reseal.
 if(m.state!=='SEALED'||m.fullSealed||m.operation||m.active.size)throw Object.assign(Error('DRAINED_RESEARCH_SEAL_REQUIRED'),{statusCode:409});
 const receipt=await build(c,root,commit,visit=>require('./researchArchive').rows(c,visit));
 if(m.state!=='SEALED'||m.fullSealed||m.operation||m.active.size)throw Error('RETIREMENT_BOUNDARY_CHANGED');
 m.state='FAILED';m.reason='RETIREMENT_PUBLICATION_REQUIRES_RESEAL';m.fullSealed=false;m.save();
 return publish(root,receipt);
}
module.exports={build,publish,read,accounting,record,unresolved};
