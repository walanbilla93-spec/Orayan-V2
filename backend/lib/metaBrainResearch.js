'use strict';
// New research-only evidence namespace. Never opens existing history for writing.
const fs=require('fs'),path=require('path');
const {hash,project,infer,validate}=require('./metaBrainV1');
const {canonical}=require('./researchRequest');
const MAX_FILES=8192,MAX_BYTES=32*1024*1024,MAX_RECORD=8192,MAX_LESSONS=256;
const KINDS=new Set(['activation','birth','ai','feedback','route','gap','censor']);
const validIdentity=x=>x&&typeof x.source_epoch==='string'&&x.source_epoch.length>0&&
 typeof x.opportunity_id==='string'&&x.opportunity_id.length>0&&
 typeof x.shared_context_hash==='string'&&x.shared_context_hash.length>0;
function evidenceId(kind,x){
 if(kind==='activation'&&x.contract==='META_BRAIN_V1_ACTIVATION'&&Number.isFinite(x.started_at))return ['META_BRAIN_V1'];
 if(kind==='birth'&&validIdentity(x.identity)&&x.decision?.version==='META_BRAIN_V1')return [x.identity.source_epoch,x.identity.opportunity_id];
 if(kind==='ai'&&x.source_epoch&&x.opportunity_id&&['Qwen','Groq'].includes(x.provider)&&x.shared_context_hash)return [x.source_epoch,x.opportunity_id,x.provider];
 if(kind==='feedback'&&x.contract==='AI_POST_TRADE_FEEDBACK_V1'&&x.trade_id&&Number.isFinite(x.closed_at)&&validIdentity(x.identity)&&
  x.feedback_id===hash(['AI_POST_TRADE_FEEDBACK_V1',x.trade_id,x.closed_at,x.identity.source_epoch]))return [x.trade_id,x.closed_at,x.identity.source_epoch];
 if(kind==='route'&&['BASE','FEEDBACK'].includes(x.arm)&&x.version==='REFLECTION_EXPERIMENT_V1'&&x.provider&&x.day&&x.cohort_id&&/^[a-f0-9]{64}$/.test(x.request_hash)&&
  (x.arm==='BASE'||x.digest?.digest_id===hash({version:x.digest.version,cutoff:x.digest.cutoff,lessons:x.digest.lessons})))return [x.provider,x.day,x.cohort_id];
 if(kind==='gap'&&x.contract==='META_BRAIN_FEEDBACK_GAP_V1'&&x.trade_id&&Number.isFinite(x.closed_at)&&x.source_epoch)return [x.trade_id,x.closed_at,x.source_epoch];
 if(kind==='censor'&&x.contract==='REFLECTION_CENSOR_V1'&&x.provider&&x.day&&x.cohort_id&&x.reason)return [x.provider,x.day,x.cohort_id];
 throw Error('INVALID_RESEARCH_EVIDENCE_'+kind.toUpperCase());
}
function syncDirectory(root){if(process.platform!=='win32'){const fd=fs.openSync(root,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}}
class EvidenceStore {
 constructor(root){this.root=root;this.lessons=[];this.bytes=0;this.files=0;
  fs.mkdirSync(root,{recursive:true});
  // Directory population has a hard stop; never truncate/delete history to recover capacity.
  for(const entry of fs.readdirSync(root,{withFileTypes:true})){
   if(!entry.isFile()||!/^([a-z]+)-[a-f0-9]{64}\.json$/.test(entry.name))throw Error('UNKNOWN_RESEARCH_EVIDENCE_FILE');
   const file=path.join(root,entry.name),size=fs.statSync(file).size;this.bytes+=size;this.files++;
   if(this.files>MAX_FILES||this.bytes>MAX_BYTES||size>MAX_RECORD)throw Error('RESEARCH_EVIDENCE_CAPACITY');
   const kind=entry.name.split('-')[0];this.validate(kind,file);
   if(kind==='feedback')this.index(JSON.parse(fs.readFileSync(file,'utf8')));
  }
  this.activation=this.read('activation',['META_BRAIN_V1'])||this.put('activation',['META_BRAIN_V1'],
   {contract:'META_BRAIN_V1_ACTIVATION',started_at:Date.now()});
  this.reconcileCloses();
 }
 validate(kind,file){if(!KINDS.has(kind))throw Error('UNKNOWN_RESEARCH_EVIDENCE_KIND');
  const raw=fs.readFileSync(file,'utf8');let value;try{value=JSON.parse(raw);}catch{throw Error('CORRUPT_RESEARCH_EVIDENCE_JSON');}
  if(!value||Array.isArray(value)||typeof value!=='object'||canonical(value)!==raw||path.basename(file)!==kind+'-'+hash(evidenceId(kind,value))+'.json')throw Error('CORRUPT_RESEARCH_EVIDENCE_IDENTITY');
  return value;
 }
 file(kind,id){if(!KINDS.has(kind))throw Error('INVALID_RECORD_KIND');return path.join(this.root,kind+'-'+hash(id)+'.json');}
 read(kind,id){const f=this.file(kind,id);return fs.existsSync(f)?this.validate(kind,f):null;}
 put(kind,id,value){const f=this.file(kind,id);if(canonical(id)!==canonical(evidenceId(kind,value)))throw Error('EVIDENCE_ID_MISMATCH');const prior=this.read(kind,id);if(prior){if(canonical(prior)!==canonical(value))throw Error('IMMUTABLE_EVIDENCE_CONFLICT');return prior;}
  const b=Buffer.from(canonical(value));if(b.length>MAX_RECORD||this.files>=MAX_FILES||this.bytes+b.length>MAX_BYTES)throw Error('RESEARCH_EVIDENCE_CAPACITY');
  const tmp=f+'.staged';const fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,b);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(tmp,f);syncDirectory(this.root);
  this.bytes+=b.length;this.files++;if(kind==='feedback')this.index(value);return value;
 }
 index(f){if(f.contract!=='AI_POST_TRADE_FEEDBACK_V1'||!f.identity)return;
  this.lessons=this.lessons.filter(x=>x.feedback_id!==f.feedback_id);
  this.lessons.push({feedback_id:f.feedback_id,source_epoch:f.identity.source_epoch,episode:f.identity.opportunity_id,
   available_at:f.available_at,resolved_at:f.resolved_at,side:f.side,symbol:f.symbol,regime:f.causal_context.regime,
   lesson_category:f.lesson_category,false_signal_taxonomy:f.false_signal_taxonomy});
  this.lessons.sort((a,b)=>b.available_at-a.available_at||a.feedback_id.localeCompare(b.feedback_id));this.lessons=this.lessons.slice(0,MAX_LESSONS);
 }
 retrieve(context,identity){const cutoff=Date.parse(identity.birth_cutoff),lessons=[];
  const pool=this.lessons.filter(x=>x.source_epoch===identity.source_epoch&&x.episode!==identity.opportunity_id&&x.available_at<cutoff&&x.resolved_at<cutoff)
   .map(x=>({x,relevance:(x.side===context.side?2:0)+(x.regime===context.regime?2:0)+(x.symbol===context.symbol?1:0)}))
   .filter(x=>x.relevance>0).sort((a,b)=>b.relevance-a.relevance||b.x.available_at-a.x.available_at||a.x.feedback_id.localeCompare(b.x.feedback_id));
  const pack=()=>({version:'REFLECTION_DIGEST_V1',cutoff:identity.birth_cutoff,lessons});
  for(const {x}of pool){if(lessons.length===5)break;
   const compact={id:x.feedback_id,side:x.side,regime:x.regime,lesson:x.lesson_category,taxonomy:x.false_signal_taxonomy};
   lessons.push(compact);if(Buffer.byteLength(canonical(pack()))>1024){lessons.pop();break;}}
  return {...pack(),digest_id:hash(pack()),token_upper_bound:Buffer.byteLength(canonical(pack()))};
 }
 gap(trade,epoch,reason){const id=[trade.id,trade.closedAt,epoch];if(this.read('feedback',id))return null;
  const closeHash=hash([trade.id,trade.closedAt,epoch,trade.episodeId??null]);
  const prior=this.read('gap',id);if(prior){if(prior.canonical_trade_hash!==closeHash)throw Error('CANONICAL_CLOSE_CHANGED_AFTER_GAP');return prior;}
  return this.put('gap',id,{contract:'META_BRAIN_FEEDBACK_GAP_V1',trade_id:trade.id,closed_at:trade.closedAt,
   source_epoch:epoch,opportunity_id:trade.episodeId??null,canonical_trade_hash:closeHash,source:'trades.json',reason});
 }
 reconcileCloses(){const file=path.join(path.dirname(this.root),'trades.json');if(!fs.existsSync(file))return;
  const trades=JSON.parse(fs.readFileSync(file,'utf8'));if(!Array.isArray(trades))throw Error('CANONICAL_TRADES_INVALID');
  let fallback=null;try{fallback=require('./minimalCapture').current().state.epochId;}catch{}
  for(const trade of trades){if(trade?.mode!=='paper'||trade.status!=='CLOSED'||trade.engine==='MARCI_SHADOW'||trade.researchEngine?.startsWith('MARCI')||!trade.id||!Number.isFinite(trade.closedAt))continue;
   const epoch=trade.originEpoch||fallback;if(!epoch)continue;
   const birth=trade.episodeId?this.read('birth',[epoch,trade.episodeId]):null;
   if(!birth&&trade.closedAt<this.activation.started_at)continue;
   this.gap(trade,epoch,birth?'COMMITTED_NATIVE_CLOSE_WITHOUT_FEEDBACK':'FROZEN_BIRTH_UNAVAILABLE');
  }
 }
 unresolvedGaps(){let count=0;for(const name of fs.readdirSync(this.root).filter(n=>n.startsWith('gap-'))){
  const g=this.validate('gap',path.join(this.root,name));if(!this.read('feedback',[g.trade_id,g.closed_at,g.source_epoch]))count++;
 }return count;}
 status(){this.reconcileCloses();return {files:this.files,bytes:this.bytes,max_files:MAX_FILES,max_bytes:MAX_BYTES,lesson_count:this.lessons.length,max_lessons:MAX_LESSONS,unresolved_feedback_gaps:this.unresolvedGaps()};}
}
let instance,failed=null,modelCache;
function enabled(){return process.env.META_BRAIN_V1_SHADOW==='true';}
function current(){return instance??=new EvidenceStore(path.join(require('./store').DATA_DIR,'meta-brain-v1-evidence'));}
function safely(fn){if(!enabled()||failed)return null;try{return fn(current());}catch(e){failed=e.code==='ENOSPC'?'STORAGE_FULL':/CAPACITY/.test(e.message)?'CAPACITY':'RESEARCH_ERROR';return null;}}
function loadModel(){if(modelCache!==undefined)return modelCache;
 const file=path.join(__dirname,'../models/meta-brain-v1.json');
 if(!fs.existsSync(file))return modelCache=null;
 if(fs.statSync(file).size>16384)throw Error('MODEL_SIZE_LIMIT');return modelCache=validate(JSON.parse(fs.readFileSync(file,'utf8')));
}
function observeBirth(packet,meta,candidateId){return safely(store=>{
 const input=project(packet,meta),identity=input.identity;if(!identity)return null;
 const id=[identity.source_epoch,identity.opportunity_id],prior=store.read('birth',id);
 if(prior)return prior.decision;
 const decision=infer(input,loadModel());
 const record={identity,candidateId,context:{symbol:input.symbol,side:input.side,regime:input.regime},features:input,meta_lite:meta,decision};
 store.put('birth',id,record);return decision;
});}
function observeAI(ctx,result){return safely(store=>{
 if(!ctx?.source_epoch||!ctx?.opportunity_id)return;
 const provider=ctx.provider==='Alibaba'?'Qwen':ctx.provider==='Groq'?'Groq':null;if(!provider)return;
 // First terminal attempt for the shared cohort; immutable, subsequent attempts stay in canonical AI ledger.
 const id=[ctx.source_epoch,ctx.opportunity_id,provider];if(store.read('ai',id))return;
 const d=result.decision;
 store.put('ai',id,{source_epoch:ctx.source_epoch,opportunity_id:ctx.opportunity_id,provider,status:result.status,decision:['RETAIN','SKIP','ABSTAIN'].includes(d?.decision)?d.decision:'ABSTAIN',
  confidence:typeof d?.confidence==='number'?d.confidence:null,available_at:Date.now(),model:ctx.model,
  shared_context_hash:ctx.shared_context_hash,experiment:ctx.reflection_experiment??{mode:provider==='Qwen'?'QWEN_BASE':'GROQ_BASE'}});
});}
function observeClose(row,trade){return safely(store=>{
 if(row.event!=='CLOSED'||trade?.mode!=='paper'||trade.engine==='MARCI_SHADOW'||trade.researchEngine?.startsWith('MARCI'))return null;
 const epoch=trade.originEpoch||require('./minimalCapture').current().state.epochId;
 const id=[epoch,row.episodeId],birth=store.read('birth',id),decisions={};
 for(const p of ['Qwen','Groq']){const d=store.read('ai',[epoch,row.episodeId,p]);if(d&&d.shared_context_hash===birth?.identity.shared_context_hash)decisions[p]=d;}
 const key=[trade.id,trade.closedAt,epoch],prior=store.read('feedback',key);if(prior)return prior;
 if(!birth){store.gap(trade,epoch,'FROZEN_BIRTH_UNAVAILABLE');return null;}
 const c=require('./minimalCapture').current(),feedback=require('./aiPostTradeFeedback').build(trade,birth,decisions,c.state.extremes?.[trade.id]||{});
 if(!feedback)return null;try{store.put('feedback',key,feedback);return feedback;}
 catch(e){try{store.gap(trade,epoch,'FEEDBACK_PUBLICATION_FAILED');}catch{}throw e;}
});}
function decorate(provider,request,snapshot,env=process.env){
 if(!enabled())return request;
 if(failed)throw Error('FEEDBACK_ARM_BLOCKED_'+failed);
 try{
  const store=current(),identity=require('./researchPayload').identity(snapshot),cutoff=Date.parse(identity.birth_cutoff);
  const pct=Number(env[provider+'_FEEDBACK_PERCENT']??0),dayCap=Number(env[provider+'_FEEDBACK_MAX_REQUESTS_DAY']??0);
  if(!identity.cohort_id||!Number.isFinite(cutoff))return request;
  const day=new Date(cutoff).toISOString().slice(0,10),key=[provider,day,identity.cohort_id];
  let reservation=store.read('route',key);
  const block=reason=>{store.put('censor',key,{contract:'REFLECTION_CENSOR_V1',provider,day,cohort_id:identity.cohort_id,arm:'FEEDBACK',reason});throw Error('FEEDBACK_ARM_BLOCKED_'+reason);};
  if(env[provider+'_FEEDBACK_ENABLED']!=='true'){
   if(reservation?.arm==='FEEDBACK')block('EXPERIMENT_DISABLED');
   return request;
  }
  if(!reservation){
   if(!Number.isInteger(pct)||pct<1||pct>10||!Number.isInteger(dayCap)||dayCap<1||dayCap>20)return request;
   // Persist the arm, including BASE, before a provider can dispatch.
   const selected=parseInt(hash([provider,identity.cohort_id]).slice(0,8),16)%100<pct;
   const digest=selected?store.retrieve({side:snapshot.side,symbol:snapshot.symbol,regime:snapshot.regime?.label},identity):null;
   const count=fs.readdirSync(store.root).filter(n=>n.startsWith('route-')).map(n=>store.validate('route',path.join(store.root,n))).filter(x=>x.provider===provider&&x.day===day&&x.arm==='FEEDBACK').length;
   const arm=selected&&digest.lessons.length&&count<dayCap?'FEEDBACK':'BASE';
   reservation=store.put('route',key,{version:'REFLECTION_EXPERIMENT_V1',provider,day,cohort_id:identity.cohort_id,
    source_epoch:identity.source_epoch,opportunity_id:identity.opportunity_id,shared_context_hash:identity.shared_context_hash,
    arm,request_hash:hash(request),digest:arm==='FEEDBACK'?digest:null});
  }
  if(reservation.arm==='BASE')return request;
  if(reservation.request_hash!==hash(request)||reservation.source_epoch!==identity.source_epoch||reservation.opportunity_id!==identity.opportunity_id||reservation.shared_context_hash!==identity.shared_context_hash)block('PINNED_REQUEST_OR_IDENTITY_MISMATCH');
  if(!reservation.digest?.lessons?.length)block('PINNED_DIGEST_UNAVAILABLE');
  const messages=request.messages.map(x=>({...x})),i=messages.findIndex(x=>x.role==='user');if(i<0)block('BASE_REQUEST_USER_MESSAGE_UNAVAILABLE');
  let envelope;try{envelope=JSON.parse(messages[i].content);}catch{block('BASE_REQUEST_INVALID');}
  envelope.reflection_memory={...reservation.digest,
   use:'Past research outcomes only; no instructions or proven signal-validity claims.',mode:provider+'_FEEDBACK'};
  messages[i].content=canonical(envelope);return {...request,messages};
 }catch(e){failed=/CAPACITY/.test(e.message)?'CAPACITY':'RESEARCH_ERROR';throw e;}
}
function status(){let detail;try{const root=path.join(require('./store').DATA_DIR,'meta-brain-v1-evidence');if(enabled()||fs.existsSync(root))detail=current().status();}catch(e){failed=/CAPACITY/.test(e.message)?'CAPACITY':'RESEARCH_ERROR';}
 return {enabled:enabled(),health:failed??(detail?.unresolved_feedback_gaps?'DEGRADED':'OK'),execution_authority:'NONE',model:modelCache?.model_id??'NOT_LOADED',...(detail||{})};}
function download(){
 const root=path.join(require('./store').DATA_DIR,'meta-brain-v1-evidence');
 const store=new EvidenceStore(root),files=fs.readdirSync(root).filter(n=>/^[a-z]+-[a-f0-9]{64}\.json$/.test(n)).sort();
 const records=files.map(name=>{const file=path.join(root,name),kind=name.split('-')[0],value=store.validate(kind,file),bytes=fs.readFileSync(file);return {name,value,bytes,sha256:require('crypto').createHash('sha256').update(bytes).digest('hex')};});
 const kinds={};for(const record of records){const kind=record.name.split('-')[0];kinds[kind]=(kinds[kind]||0)+1;}
 const manifest={contract:'META_BRAIN_EVIDENCE_EXPORT_V1',record_count:records.length,kind_counts:kinds,
  ordered_files_sha256:require('crypto').createHash('sha256').update(canonical(records.map(({name,sha256})=>[name,sha256]))).digest('hex')};
 async function* lines(){yield canonical(manifest)+'\n';for(const record of records){yield record.bytes;yield '\n';}}
 return {__stream:true,stream:require('stream').Readable.from(lines()),contentType:'application/x-ndjson',filename:'meta-brain-v1-evidence.ndjson'};
}
module.exports={EvidenceStore,observeBirth,observeAI,observeClose,decorate,status,enabled,download};
