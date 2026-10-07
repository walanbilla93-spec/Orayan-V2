'use strict';
// Observation-only: this module never imports signals, gates, risk or execution.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const SCHEMA='ORAYAN_MINIMAL_CAPTURE_V1';
const LIMITS={rowBytes:16384,segmentBytes:1048576,dailyBytes:10485760,reserveBytes:2097152,totalBytes:268435456,retentionDays:180};
const pick=(o,keys)=>Object.fromEntries(keys.filter(k=>o?.[k]!==undefined).map(k=>[k,o[k]]));
const digest=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const level=l=>l?pick(l,['id','type','source','direction','anchorAt','knownAt','price','zoneLow','zoneHigh','invalidationPrice','active','reaction']):null;
function geometry(g){if(!g)return null;return {...pick(g,['policy','status','reason','entryPrice','invalidationPrice','objectivePrice','rawRR','costAdjustedRR','minCostAdjustedRR','tickSize','qtyStep','minOrderQty','maxOrderQty','entryWindowMin','maxHoldMin','sizing','costs']),reactionLevel:level(g.reactionLevel),stopLevel:level(g.stopLevel),objectiveLevel:level(g.objectiveLevel)};}
function atomic(file,value){const tmp=file+'.tmp',fd=fs.openSync(tmp,'w');try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);}
const lifecycleKeys=['status','outcome','plannedEntry','initialStop','initialTarget','sl','tp','quantity','qty','notional','margin','leverage','plannedRiskUsdt','actualRisk','createdAt','signalAt','orderIntentAt','orderAckAt','exchangeOrderId','eligibleFromAt','expiresAt','filledAt','entryPrice','fillPrice','fillEconomics','closedAt','exitPrice','exitTimePrecision','grossPnl','fees','fundingCost','fundingStatus','netPnlBeforeFunding','netPnl','realizedR','realisedRR','realizedRBeforeFunding','holdMs','mfePerUnit','maePerUnit','mfeR','maeR','excursionPrecision','ambiguityCount','outcomeComplete','closeReason'];
const armKeys=['policy','version','definitionVersion','eligible','status','reason','admissionOrdinal','repeatEligible','atr1m','atrDefinition','atrCutoff','atrReceivedAt','decisionProvisionalStop','fillAdjustedActualStop','structuralControlStop','structuralObjective','decisionEconomics','decisionGeometryRejected','fillGeometryRejected','matchedFillSubset','fullGeometrySubset','newlyAdmittedOpportunity','firstAdmissionSensitivity','opportunityNetCash','netR','complete','fillStatus','outcome','holdMs'];
const code=x=>String(x||'UNKNOWN').replace(/[^A-Z0-9_]/gi,'_').slice(0,80);
class Capture {
  constructor(dir,{epochId,startedAt=Date.now(),limits={}}={}){
    this.dir=dir;this.limits={...LIMITS,...limits};fs.mkdirSync(dir,{recursive:true});this.file=path.join(dir,'status.json');this.pending=path.join(dir,'pending.json');
    this.state=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):{schemaVersion:SCHEMA,epochId:epochId||crypto.randomUUID(),startedAt,sequence:0,attemptedRows:0,acceptedRows:0,lostRows:0,attemptedBytes:0,acceptedBytes:0,lostBytes:0,countsByStream:{},countsByMode:{},closed:0,cancelled:0,expired:0,retainedRows:0,retainedBytes:0,prunedRows:0,segments:[],days:{},dedupe:{},healthBuckets:{},populationComplete:true};
    if(this.state.schemaVersion!==SCHEMA)throw Error('CAPTURE_SCHEMA_MISMATCH');
    this.lastFailure=null;this.recover();this.flush();
  }
  flush(){atomic(this.file,this.state);}
  recover(){if(!fs.existsSync(this.pending))return;const p=JSON.parse(fs.readFileSync(this.pending,'utf8'));
    if(this.state.sequence<p.sequence){const f=path.join(this.dir,p.segment),size=fs.existsSync(f)?fs.statSync(f).size:0;
      if(size===p.offset){const fd=fs.openSync(f,'a');try{fs.writeSync(fd,p.line);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
      else {const fd=fs.openSync(f,'r'),b=Buffer.alloc(Buffer.byteLength(p.line));try{fs.readSync(fd,b,0,b.length,p.offset);}finally{fs.closeSync(fd);}if(b.toString()!==p.line)throw Error('CAPTURE_WAL_CONTENT_MISMATCH');}
      this.state=p.after;this.flush();
    }fs.unlinkSync(this.pending);
  }
  failure(reason,bytes=0){this.state.attemptedRows++;this.state.lostRows++;this.state.attemptedBytes+=bytes;this.state.lostBytes+=bytes;this.state.populationComplete=false;
    this.state.lastError={code:code(reason),at:Date.now()};this.lastFailure=this.state.lastError;try{this.flush();}catch{/* bounded in-memory health still exposed */}return false;}
  emit(stream,record,{key=null,signature=null,priority=false}={}){
    try{
      this.recover();if(key&&this.state.dedupe[key]===signature)return false;
      const at=record.at??Date.now(),day=new Date(at).toISOString().slice(0,10),sourceEpisodeId=record.sourceEpisodeId??record.episodeId??record.candidateId??record.tradeId??null;
      const row={...record,stream,schemaVersion:SCHEMA,epochId:this.state.epochId,episodeId:sourceEpisodeId?this.state.epochId+':'+sourceEpisodeId:null,sourceEpisodeId,
        at,utc:new Date(at).toISOString(),eventId:this.state.epochId+':'+(this.state.sequence+1)};
      const line=JSON.stringify(row)+'\n',bytes=Buffer.byteLength(line);this.prune(at);
      if(bytes>this.limits.rowBytes)return this.failure('ROW_CAP',bytes);
      const dayBytes=this.state.days[day]||0,cap=priority?this.limits.dailyBytes:this.limits.dailyBytes-this.limits.reserveBytes;
      if(dayBytes+bytes>cap||this.state.retainedBytes+bytes>this.limits.totalBytes)return this.failure('CAPTURE_CAP',bytes);
      let s=this.state.segments.at(-1);if(!s||s.day!==day||s.bytes+bytes>this.limits.segmentBytes){s={name:'events-'+day+'-'+String(this.state.sequence+1).padStart(8,'0')+'.jsonl',day,bytes:0,rows:0};}
      const after=JSON.parse(JSON.stringify(this.state));if(after.segments.at(-1)?.name!==s.name)after.segments.push({...s});const next=after.segments.at(-1);
      next.bytes+=bytes;next.rows++;after.sequence++;after.attemptedRows++;after.acceptedRows++;after.attemptedBytes+=bytes;after.acceptedBytes+=bytes;after.retainedBytes+=bytes;after.retainedRows++;
      after.days[day]=dayBytes+bytes;
      after.episodeMetadata??={};if(stream==='decision_episode'&&sourceEpisodeId){after.episodeMetadata[sourceEpisodeId]=pick(row,['symbol','side','configHash','regime']);while(Object.keys(after.episodeMetadata).length>4096)delete after.episodeMetadata[Object.keys(after.episodeMetadata)[0]];}after.countsByStream[stream]=(after.countsByStream[stream]||0)+1;after.countsByMode[row.mode||'RESEARCH']=(after.countsByMode[row.mode||'RESEARCH']||0)+1;
      if(stream==='trade_lifecycle'&&['CLOSED','CANCELLED','EXPIRED'].includes(row.status)){const k='terminal:'+row.tradeId+':'+row.status;if(!after.dedupe[k]){if(row.status==='CLOSED')after.closed++;if(row.status==='CANCELLED')after.cancelled++;if(row.status==='EXPIRED')after.expired++;after.dedupe[k]='COUNTED';}}
      after.earliestEventId??=row.eventId;after.earliestAt??=at;after.latestEventId=row.eventId;after.latestAt=at;
      if(key){after.dedupe[key]=signature;while(Object.keys(after.dedupe).length>4096)delete after.dedupe[Object.keys(after.dedupe)[0]];}
      atomic(this.pending,{sequence:after.sequence,segment:s.name,offset:s.bytes,line,after});this.recover();return true;
    }catch(e){return this.failure(e.code||e.message);}
  }
  prune(now){const cutoff=new Date(now-this.limits.retentionDays*86400000).toISOString().slice(0,10);let changed=false;
    for(const s of this.state.segments.filter(x=>x.day<cutoff)){const f=path.join(this.dir,s.name);if(fs.existsSync(f))fs.unlinkSync(f);this.state.retainedBytes-=s.bytes;this.state.retainedRows-=s.rows;this.state.prunedRows+=s.rows;this.state.prunedFiles=(this.state.prunedFiles||0)+1;changed=true;}
    if(changed){this.state.segments=this.state.segments.filter(x=>x.day>=cutoff);this.state.lastPrunedAt=now;this.state.retentionSubset=true;this.flush();}
    for(const d of Object.keys(this.state.days))if(d<cutoff)delete this.state.days[d];
  }
  health(error,context={}){const at=context.at??Date.now(),bucket=Math.floor(at/300000),c=code(error.code||error.reasonCode||error.errorCode||error.message||error),subsystem=code(context.subsystem),key=[bucket,c,subsystem].join('|');
    const previous=this.state.healthBuckets[key];const severe=['ENOSPC','EACCES','CAPTURE_WAL_CONTENT_MISMATCH'].includes(c);
    if(previous){previous.count++;previous.lastAt=at;return false;}
    // At most 128 first-occurrence error classes/buckets; repeated errors never append raw payloads.
    const keys=Object.keys(this.state.healthBuckets);if(keys.length>=128){const old=this.state.healthBuckets[keys[0]];this.emit('errors_health',{...old,mode:'RESEARCH',at,event:'BUCKET_FINAL'},{priority:true});delete this.state.healthBuckets[keys[0]];}
    const record={code:c,subsystem,severity:severe?'SEVERE':'ROUTINE',bucket,firstAt:at,lastAt:at,count:1,mode:'RESEARCH',at};this.state.healthBuckets[key]=record;
    return this.emit('errors_health',record,{priority:true});
  }
  status(){const {dedupe,days,segments,healthBuckets,episodeMetadata,...s}=this.state;return {...s,limits:this.limits,segments:segments.map(x=>({...x})),healthBuckets:Object.values(healthBuckets),lastFailure:this.lastFailure,forensicBufferEnabled:false,
    retentionStatus:this.state.prunedRows?'SUBSET_RETAINED':'ALL_ACCEPTED_ROWS_RETAINED',reconciliation:this.state.attemptedRows===this.state.acceptedRows+this.state.lostRows};}
  export(){this.flush();const status=this.status(),sizes=this.state.segments.map(s=>({...s}));return {status,files:sizes.map(s=>({path:path.join(this.dir,s.name),size:s.bytes})),watermark:status.latestEventId};}
}
let singleton,enabledValue;
function enabled(){if(enabledValue===undefined)enabledValue=fs.existsSync(path.join(require('./store').DATA_DIR,'capture-minimal-policy.json'));return enabledValue;}
function current(){if(!singleton){const root=require('./store').DATA_DIR,policy=JSON.parse(fs.readFileSync(path.join(root,'capture-minimal-policy.json'),'utf8'));singleton=new (require('./captureProxy').CaptureProxy)(path.join(root,'capture-minimal-v1'),policy);}return singleton;}
let lastFailurePrint=0;
function safe(fn){try{return fn(current());}catch(e){if(Date.now()-lastFailurePrint>300000){lastFailurePrint=Date.now();console.error('Minimal capture unavailable:',code(e.code||e.message));}return false;}}
function config(settings,hash){return safe(c=>{const allowed=require('./settings').SCHEMA.map(x=>x.key).filter(k=>!/(key|secret|credential|token|password|endpoint|url)/i.test(k));
  const def=pick(settings,allowed);return c.emit('configuration',{at:Date.now(),configHash:hash,config:def,mode:'RESEARCH',definitionVersion:SCHEMA,activeExperiments:['FIRST_ADMISSION_ONLY','FIRST_FILLED_ONLY','ATR1M_BUFFER','ATR1M_1P5_REPLACEMENT']},{key:'config:'+hash,signature:hash});});}
function native(signal,row,settings){config(settings,row.configHash);return safe(c=>c.emit('decision_episode',{at:row.decisionAt,sourceEpisodeId:row.episodeId,candidateId:signal.id,symbol:signal.symbol,side:signal.side,strategy:row.engine,strategyVersion:row.engineVariant,mode:settings.mode.toUpperCase(),configHash:row.configHash,boundary:row.kind,admission:row.passed?'ELIGIBLE':'REJECTED',rejectReason:row.failedGates,score:signal.score,regime:signal.btcRegime,gateChecks:(signal.gates?.checks||[]).map(x=>pick(x,['name','enabled','pass','detail'])),failedGates:row.failedGates,
    features:{...pick(signal,['score','rr','slDistPct','structureEvent','structureTrend','entryPath']),components:signal.components,turnover24h:signal.market?.turnover24h,spreadPct:signal.market?.spreadPct,volRatio:signal.market?.volRatio,...(settings.gateFundingEnabled?{fundingRate:signal.market?.fundingRate}:{})},geometry:{entryPrice:signal.entry,invalidationPrice:signal.sl,objectivePrice:signal.tp},context:{regime:signal.btcRegime}},
    {key:'v2:'+row.candidateKey,signature:digest([row.episodeId,row.signature])}));}
function nativeOutcome(row,t){return safe(c=>c.emit('trade_lifecycle',{at:row.at,sourceEpisodeId:row.episodeId,candidateId:row.candidateId,tradeId:row.tradeId,symbol:row.symbol??c.state.episodeMetadata?.[row.episodeId]?.symbol,side:row.side??c.state.episodeMetadata?.[row.episodeId]?.side,strategy:row.engine,mode:t?.engine==='MARCI_SHADOW'?'SHADOW':String(row.mode||t?.mode||'WOULD_BE').toUpperCase(),originEpoch:t?.originEpoch,inheritedWorkingState:t?.inheritedWorkingState??false,configHash:row.configHash,transitions:[row.event],...pick(t,lifecycleKeys),realizedR:t?.realisedRR,plannedEntry:t?.plannedEntry,initialStop:t?.initialSl??t?.sl,initialTarget:t?.tp,holdMs:t?.holdMs??(t?.closedAt&&t?.filledAt?t.closedAt-t.filledAt:null),managementPolicy:t?.managementPolicy,outcomeComplete:t?['CLOSED','CANCELLED','EXPIRED'].includes(t.status):false},
  {key:'native:'+row.candidateId+':'+row.event+':'+row.tradeId,signature:row.signature,priority:true}));}
function observe(channel,row){return safe(c=>{
  if(channel==='v3'){
    if(!row.side||!row.directionPermission||(!row.geometry?.reactionLevel&&!row.v2Decision?.length))return false;
    const n=row.measurement34?.noise,q=row.measurement34?.quote;
    return c.emit('decision_episode',{at:row.decisionAt,sourceEpisodeId:row.episodeId,candidateId:row.candidateId,symbol:row.symbol,side:row.side,strategy:'ORAYAN_V3',strategyVersion:row.version,mode:'SHADOW',configHash:row.configHash,controlFingerprint:row.control?.fingerprint,boundary:row.kind,admission:row.v3Decision,rejectReason:row.rejectReason,regime:row.regime,directionPermission:row.directionPermission,closedBarOpenAt:row.closedBarOpenAt,geometry:geometry(row.geometry),atr:pick(n,['atr1m','definition','cutoff','sourceAt','receivedAt','positiveAtr','usableAtDecision','status','availabilityReason']),context:pick(row.btcContext,['regime','strength']),quality:{quoteStatus:q?.status,quoteReceivedAt:q?.receivedAt,quoteAgeMs:q?.ageMs},pairedNativeCandidateIds:(row.v2Decision||[]).map(x=>x.candidateId)},
      {key:'v3:'+row.symbol+':'+row.side+':'+row.configHash,signature:digest([row.closedBarOpenAt,row.v3Decision,row.rejectReason,row.geometry?.reactionLevel?.id,row.geometry?.entryPrice,row.geometry?.invalidationPrice,row.geometry?.objectivePrice])});
  }
  if(channel==='trades'){
    if(row.transitions?.every(x=>x==='MARK'))return false;const t=row.trade;
    return c.emit('trade_lifecycle',{at:row.capturedAt,sourceEpisodeId:t.episodeId,candidateId:t.candidateId,tradeId:t.tradeId,symbol:t.symbol,side:t.side,strategy:'ORAYAN_V3',mode:'SHADOW',configHash:t.configHash,transitions:row.transitions,initialStop:t.geometry?.invalidationPrice,initialTarget:t.geometry?.objectivePrice,geometry:geometry(t.geometry),...pick(t,lifecycleKeys),managementPolicy:t.research34?.managementPolicy},
      {key:'trade:'+t.tradeId,signature:digest([row.transitions,t.status,t.fundingStatus,t.closedAt,t.filledAt,t.netPnl,t.outcomeComplete]),priority:true});
  }
  if(channel==='arms'){let emitted=false;for(const [policy,a]of Object.entries(row.arm?.arms||{})){
    if(a.status==='DORMANT')continue;const t=a.trade;
    const rec={at:row.capturedAt,sourceEpisodeId:row.episodeId,tradeId:row.tradeId,controlTradeId:a.controlTradeId||row.tradeId,mode:'SHADOW',strategy:'ORAYAN_V3',...pick(a,armKeys),geometry:geometry(t?.geometry),endpoint:t?pick(t,lifecycleKeys):null,equalRiskUsdt:t?.plannedRiskUsdt,symbol:t?.symbol??c.state.episodeMetadata?.[row.episodeId]?.symbol,side:t?.side??c.state.episodeMetadata?.[row.episodeId]?.side,configHash:c.state.episodeMetadata?.[row.episodeId]?.configHash};
    const sig=digest([a.status,a.fillStatus,a.outcome,a.complete,a.opportunityNetCash,a.reason,t?.status,t?.filledAt,t?.closedAt,t?.netPnl,t?.geometry?.invalidationPrice,a.moves]);
    emitted=c.emit('experiment_arm',rec,{key:'arm:'+row.tradeId+':'+policy,signature:sig,priority:true})||emitted;
  }return emitted;}
  if(channel==='errors')return c.health(row,{subsystem:row.subsystem,at:row.capturedAt});
  return false; // Paired no-candidate rows, minute candles and unused AI contexts are intentionally absent.
});}
module.exports={SCHEMA,LIMITS,Capture,enabled,current,safe,config,native,nativeOutcome,observe,geometry,pick,digest,atomic};
