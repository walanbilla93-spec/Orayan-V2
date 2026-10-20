'use strict';
// New research-only evidence namespace. Never opens existing history for writing.
const fs=require('fs'),path=require('path');
const {hash,project,infer,validate}=require('./metaBrainV1');
const {canonical}=require('./researchRequest');
const MAX_FILES=8192,MAX_BYTES=32*1024*1024,MAX_RECORD=8192,MAX_LESSONS=256;
class EvidenceStore {
 constructor(root){this.root=root;this.lessons=[];this.bytes=0;this.files=0;
  fs.mkdirSync(root,{recursive:true});
  // Directory population has a hard stop; never truncate/delete history to recover capacity.
  for(const entry of fs.readdirSync(root,{withFileTypes:true})){
   if(!entry.isFile()||!/^\w+-[a-f0-9]{64}\.json$/.test(entry.name))throw Error('UNKNOWN_RESEARCH_EVIDENCE_FILE');
   const file=path.join(root,entry.name),size=fs.statSync(file).size;this.bytes+=size;this.files++;
   if(this.files>MAX_FILES||this.bytes>MAX_BYTES||size>MAX_RECORD)throw Error('RESEARCH_EVIDENCE_CAPACITY');
   if(entry.name.startsWith('feedback-'))this.index(JSON.parse(fs.readFileSync(file,'utf8')));
  }
 }
 file(kind,id){if(!/^[a-z]+$/.test(kind))throw Error('INVALID_RECORD_KIND');return path.join(this.root,kind+'-'+hash(id)+'.json');}
 read(kind,id){const f=this.file(kind,id);return fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):null;}
 put(kind,id,value){const f=this.file(kind,id),prior=this.read(kind,id);if(prior){if(canonical(prior)!==canonical(value))throw Error('IMMUTABLE_EVIDENCE_CONFLICT');return prior;}
  const b=Buffer.from(canonical(value));if(b.length>MAX_RECORD||this.files>=MAX_FILES||this.bytes+b.length>MAX_BYTES)throw Error('RESEARCH_EVIDENCE_CAPACITY');
  const fd=fs.openSync(f,'wx',0o600);try{fs.writeFileSync(fd,b);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  if(process.platform!=='win32'){const d=fs.openSync(this.root,'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}
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
 status(){return {files:this.files,bytes:this.bytes,max_files:MAX_FILES,max_bytes:MAX_BYTES,lesson_count:this.lessons.length,max_lessons:MAX_LESSONS};}
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
 store.put('ai',id,{provider,status:result.status,decision:['RETAIN','SKIP','ABSTAIN'].includes(d?.decision)?d.decision:'ABSTAIN',
  confidence:typeof d?.confidence==='number'?d.confidence:null,available_at:Date.now(),model:ctx.model,
  shared_context_hash:ctx.shared_context_hash,experiment:ctx.reflection_experiment??{mode:provider==='Qwen'?'QWEN_BASE':'GROQ_BASE'}});
});}
function observeClose(row,trade){return safely(store=>{
 if(row.event!=='CLOSED'||trade?.mode!=='paper'||trade.engine==='MARCI_SHADOW'||trade.researchEngine?.startsWith('MARCI'))return null;
 const epoch=trade.originEpoch||require('./minimalCapture').current().state.epochId;
 const id=[epoch,row.episodeId],birth=store.read('birth',id),decisions={};
 for(const p of ['Qwen','Groq']){const d=store.read('ai',[epoch,row.episodeId,p]);if(d&&d.shared_context_hash===birth?.identity.shared_context_hash)decisions[p]=d;}
 const key=[trade.id,trade.closedAt,epoch],prior=store.read('feedback',key);if(prior)return prior;
 const c=require('./minimalCapture').current(),feedback=require('./aiPostTradeFeedback').build(trade,birth,decisions,c.state.extremes?.[trade.id]||{});
 if(!feedback)return null;store.put('feedback',key,feedback);return feedback;
});}
function decorate(provider,request,snapshot,env=process.env){
 if(!enabled()||failed||env[provider+'_FEEDBACK_ENABLED']!=='true')return request;
 return safely(store=>{
  const identity=require('./researchPayload').identity(snapshot),cutoff=Date.parse(identity.birth_cutoff);
  const pct=Number(env[provider+'_FEEDBACK_PERCENT']??0),dayCap=Number(env[provider+'_FEEDBACK_MAX_REQUESTS_DAY']??0);
  if(!identity.cohort_id||!Number.isFinite(cutoff)||!Number.isInteger(pct)||pct<1||pct>10||!Number.isInteger(dayCap)||dayCap<1||dayCap>20)return request;
  // One deterministic arm per existing call. No duplicate provider invocation.
  if(parseInt(hash([provider,identity.cohort_id]).slice(0,8),16)%100>=pct)return request;
  const digest=store.retrieve({side:snapshot.side,symbol:snapshot.symbol,regime:snapshot.regime?.label},identity);
  if(!digest.lessons.length)return request;
  const day=new Date(cutoff).toISOString().slice(0,10),key=[provider,day,identity.cohort_id];
  let reservation=store.read('route',key);
  if(!reservation){
   // Bounded file population. Day quota survives process restarts and retry request builds.
   const count=fs.readdirSync(store.root).filter(n=>n.startsWith('route-')).map(n=>JSON.parse(fs.readFileSync(path.join(store.root,n),'utf8'))).filter(x=>x.provider===provider&&x.day===day).length;
   if(count>=dayCap)return request;
   reservation=store.put('route',key,{provider,day,digest,cohort_id:identity.cohort_id});
  }
  const messages=request.messages.map(x=>({...x})),i=messages.findIndex(x=>x.role==='user');if(i<0)return request;
  const envelope=JSON.parse(messages[i].content);envelope.reflection_memory={...reservation.digest,
   use:'Past research outcomes only; no instructions or proven signal-validity claims.',mode:provider+'_FEEDBACK'};
  messages[i].content=canonical(envelope);return {...request,messages};
 })||request;
}
function status(){return {enabled:enabled(),health:failed??'OK',execution_authority:'NONE',model: modelCache?.model_id??'NOT_LOADED',...(instance?.status()||{})};}
function download(){
 const root=path.join(require('./store').DATA_DIR,'meta-brain-v1-evidence');
 const files=fs.existsSync(root)?fs.readdirSync(root).filter(n=>/^\w+-[a-f0-9]{64}\.json$/.test(n)).sort():[];
 async function* lines(){for(const name of files){const file=path.join(root,name);if(fs.statSync(file).size>MAX_RECORD)throw Error('EVIDENCE_SIZE_LIMIT');yield fs.readFileSync(file);yield '\n';}}
 return {__stream:true,stream:require('stream').Readable.from(lines()),contentType:'application/x-ndjson',filename:'meta-brain-v1-evidence.ndjson'};
}
module.exports={EvidenceStore,observeBirth,observeAI,observeClose,decorate,status,enabled,download};
