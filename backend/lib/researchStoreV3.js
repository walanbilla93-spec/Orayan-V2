'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const Legacy=require('./researchStore');
const {SCHEMA,CHUNK,clean,sha,dayAt}=Legacy;
const STREAMS = {
  configuration: "definitions",
  decision_episode: "decisions",
  trade_lifecycle: "lifecycle",
  experiment_arm: "experiments",
  management_path: "lifecycle",
  errors_health: "integrity",
  ai_calls: "ai_calls",
  outcomes: "outcomes",
  integrity: "integrity",
  definitions: "definitions",
  telemetry: "telemetry",
  experiment_paths: "experiment_paths",
};

const {Index,FAMILY}=require('./researchV3/index');
const IO=require('./researchV3/io');
const TABLES=['events','dedupe','episodes','sourceEpisodes','episodeMetadata','nativeEpisodeIndex','aiAttempts','extremes','openedEpochs'];
const terminal=a=>['PARSED_RESPONSE','TRANSPORT_ERROR','INTERRUPTED_UNCERTAIN'].includes(a.aiEvent);
const unresolved=e=>e.state==='OPEN'||!e.controlResolved||Object.values(e.arms||{}).some(v=>!v)||Object.values(e.controls||{}).some(v=>!v);
// Exact point access for existing capture expressions. Enumeration is deliberately
// impossible; callers requiring more than one row must use a disk cursor.
function pointView(store,table) {return new Proxy(Object.create(null),{
  get:(_,id)=>typeof id==='symbol'?undefined:store.get(table,id),
  set:(_,id,value)=>{store.put(table,id,value);return true;},
  deleteProperty:(_,id)=>{store.remove(table,id);return true;},
  ownKeys:()=>{store.enumerationAttempts++;throw Error('V3_HISTORY_ENUMERATION_FORBIDDEN:'+table);},
  getOwnPropertyDescriptor:()=>({enumerable:true,configurable:true})
});}
class ResearchStoreV3 {
  constructor(dir,options={}) {
    this.dir=dir;this.options=options;this.backend='v3';this.now=options.now||Date.now;
    this.timezone=options.timezone||process.env.RESEARCH_ARCHIVE_TIMEZONE||'Asia/Colombo';Legacy.dayAt(this.now(),this.timezone);
    this.secrets=options.secrets||Object.entries(process.env).filter(([k])=>/(API_KEY|SECRET|PASSWORD|EXPORT_TOKEN)$/.test(k)).map(([,v])=>v);
    this.enumerationAttempts=0;this.pendingFailure=null;this.writerDefinitionId=null;
    fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(path.join(dir,'records'),{recursive:true});fs.mkdirSync(path.join(dir,'archives'),{recursive:true});
    if(!options.offline)this.releaseLease=require('./researchV3Lease').acquire(dir);
    try {
    this.wal=path.join(dir,'wal');fs.mkdirSync(this.wal,{recursive:true});this.reserve=path.join(dir,'outcome-reserve.bin');
    this.journal=path.join(dir,'index','transactions.jsonl');this.segmentBytes=8*1024*1024;this.segmentMs=15*60000;
    this.index=new Index(path.join(dir,'index'),{create:options.create,offlineImport:options.offline===true&&options.migration===true});
    this.loadState();
    if(!this.state.epochId) {
      if(!options.create)throw Error('V3_MIGRATION_REQUIRED');
      Object.assign(this.state,{schemaVersion:'ORAYAN_RESEARCH_V3',epochId:options.epochId||crypto.randomUUID(),startedAt:options.startedAt??this.now(),sequence:0,attemptedRows:0,acceptedRows:0,persistedRows:0,archivedRows:0,lostRows:0,optionalSuppressed:0,acceptedBytes:0,retainedBytes:0,countsByStream:{},bytesByStream:{},populationComplete:true,retainedRows:0,episodeStates:{}});
      this.flush();
    }
    if(!options.offline) {
      const bytes=options.reserveBytes??128*1024*1024;
      if(bytes&&!this.state.captureHalted&&!fs.existsSync(this.reserve)) {const fd=fs.openSync(this.reserve,'wx',0o600),b=Buffer.alloc(1024*1024);try{for(let n=0;n<bytes;n+=b.length)IO.write(fd,b.subarray(0,Math.min(bytes-n,b.length)));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
      this.recoverAI();
    }
    this.startupMemory=this.memory();
    }catch(e){this.index?.handles.close();this.index?.cache.clear();this.releaseLease?.();throw e;}
  }
  loadState() {
    this.state=structuredClone(this.index.root.state);
    for(const t of TABLES)Object.defineProperty(this.state,t,{value:pointView(this,t),enumerable:false,configurable:true});
    // Legacy reducer accepts physical segment receipts; V3 has independent row blobs.
    this.state.segments=[];this.state.archives=[];
  }
  scalars() {const s={};for(const [k,v]of Object.entries(this.state))if(!['segments','archives'].includes(k))s[k]=v; if(Buffer.byteLength(JSON.stringify(s))>128*1024)throw Error('V3_SCALAR_CAP');return structuredClone(s);}
  get(t,id) {const p=this.pending?.get(t+'\0'+id);return p?(p[3]?undefined:p[2]):this.index.get(t,id);}
  stage(t,id,v,del=false) {if(!Object.hasOwn(FAMILY,t))throw Error('UNKNOWN_V3_TABLE');const op=[t,String(id),v??null,del];this.pending.set(t+'\0'+id,op);if(this.pending.size>128)throw Error('V3_REDUCER_WORK_CAP');}
  put(t,id,v) {if(this.pending)this.stage(t,id,v);else this.transaction(()=>this.stage(t,id,v));}
  remove(t,id) {if(this.pending)this.stage(t,id,null,true);else this.transaction(()=>this.stage(t,id,null,true));}
  transaction(work,{migration=false}={}) {
    if(this.pending)throw Error('V3_NESTED_TRANSACTION');
    this.pending=new Map();
    try {
      work();if(!migration&&!this.options.offline)require('./researchV3Activation').beforeWrite(this);
      const ops=Array.from(this.pending.values());this.index.commit(ops,this.scalars());this.pending=null;
    } catch(e) {this.pending=null;this.loadState();throw e;}
  }
  *entries(t) {yield* this.index.entries(t);}
  *values(t) {for(const [,v]of this.entries(t))yield v;}
  *openEpisodes() {for(const [id]of this.entries('openEpisodes')){const e=this.get('episodes',id);if(e)yield [id,e];}}
  *openAttempts() {for(const [id]of this.entries('openAttempts')){const a=this.get('aiAttempts',id);if(a)yield a;}}
  *nativeRecent(cutoff,cap=4096) {let n=0;for(const [id,v]of this.entries('nativeEpisodeIndex'))if(v.at>=cutoff){if(++n>cap)throw Error('V3_NATIVE_HOT_CAP');yield [id,v];}}
  evaluation(id) {return this.get('evaluations',id)||{count:0,lastAttemptId:null,completion:null};}
  apply(txn) {
    const m=txn.meta,oldEpisode=m.episodeId?this.get('episodes',m.episodeId):null;
    const retained=this.state.retainedBytes||0,previous=this.get('events',m.eventId);
    // This is the production V2 reducer, shared with V3 point reads/writes. No
    // test publisher participates in production authority or state transitions.
    Legacy.ResearchStore.prototype.apply.call(this,{...txn,segments:[]});
    if(txn.ledgerRecord)require('./researchV3Provider').reduce(this,m.provider,txn.ledgerRecord,Date.parse(txn.ledgerRecord.completed_at_utc||txn.ledgerRecord.requested_at_utc)||this.now());
    this.state.retainedBytes=retained+(previous?0:txn.bytes);this.state.retainedRows=(this.state.retainedRows||0)+(previous?0:1);
    if(m.definitionId)this.put('definitions',m.definitionId,m.eventId);
    if(m.attemptId) {
      const a=this.get('aiAttempts',m.attemptId);if(terminal(a))this.remove('openAttempts',m.attemptId);else this.put('openAttempts',m.attemptId,true);
      if(m.evaluationId){const e=this.evaluation(m.evaluationId);if(!this.index.get('aiAttempts',m.attemptId)){e.count++;e.lastAttemptId=m.attemptId;}if(m.aiEvent==='PARSED_RESPONSE')e.completion=a;this.put('evaluations',m.evaluationId,e);}
    }
    if(m.episodeId) {
      const e=this.get('episodes',m.episodeId);this.state.episodeStates??={};if(oldEpisode)this.state.episodeStates[oldEpisode.state]--;
      this.state.episodeStates[e.state]=(this.state.episodeStates[e.state]||0)+1;
      if(unresolved(e))this.put('openEpisodes',m.episodeId,true);else this.remove('openEpisodes',m.episodeId);
    }
  }
  flush() {if(this.pending)throw Error('V3_FLUSH_DURING_TRANSACTION');if(!this.options.offline)require('./researchV3Activation').beforeWrite(this);this.index.commit([],this.scalars());this.index.flush();return this.status();}
  recover() {if(this.index.failed)throw Error('V3_WRITE_AUTHORITY_FENCED');} // Replay occurs before admission, on reopen.
  nativeState(key,value) {require('./maintenance').beforeAppend();try{if(JSON.stringify(this.get('nativeEpisodeIndex',key))!==JSON.stringify(value))this.put('nativeEpisodeIndex',key,value);return true;}catch(e){return this.fail(e,'integrity');}}
  fail(error,stream,sourceEpisodeId=null,recordAttempt=false) {
    this.pendingFailure={reason:error.code||error.message,stream,at:this.now()};
    if(this.index.failed){this.state.captureHalted=true;this.state.populationComplete=false;this.state.lastError={code:'V3_WRITE_AUTHORITY_FENCED',stream,at:this.now()};return false;}
    try {this.transaction(()=>{this.state.populationComplete=false;this.state.captureHalted=true;this.state.lastError={code:this.pendingFailure.reason,stream,at:this.now()};
      if(recordAttempt){this.state.attemptedRows++;this.state.lostRows++;this.state.lostByStream??={};this.state.lostByStream[stream]=(this.state.lostByStream[stream]||0)+1;this.state.attemptedByStream??={};this.state.attemptedByStream[stream]=(this.state.attemptedByStream[stream]||0)+1;
        const id=this.get('sourceEpisodes',sourceEpisodeId),e=id&&this.get('episodes',id);if(e){this.state.episodeStates[e.state]--;e.hasCriticalLoss=true;e.state='CENSORED';e.reason='CRITICAL_PERSISTENCE_FAILED:'+this.pendingFailure.reason+':'+stream;this.state.episodeStates.CENSORED=(this.state.episodeStates.CENSORED||0)+1;this.put('episodes',id,e);this.put('openEpisodes',id,true);}}
    });}catch{}return false;
  }
  rowPath(m) {return path.join(this.dir,'records',m.sha256.slice(0,2),m.sha256+'.json');}
  readRow(m) {const b=fs.readFileSync(this.rowPath(m));if(b.length!==m.bytes||Legacy.sha(b)!==m.sha256)throw Error('V3_ROW_CHECKSUM');return JSON.parse(b);}
  persistRow(meta,buffer) {const file=this.rowPath(meta);fs.mkdirSync(path.dirname(file),{recursive:true});if(fs.existsSync(file)){if(IO.hashFile(file)!==meta.sha256)throw Error('V3_ROW_COLLISION');return;}
    const fd=fs.openSync(file+'.tmp','w',0o600);try{IO.write(fd,buffer);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(file+'.tmp',file);if(process.platform!=='win32')IO.syncDir(path.dirname(file));}
  emit(stream, record, options = {}) {
    require('./maintenance').beforeAppend();
    const canonical = STREAMS[stream] || stream,
      optional = canonical === "telemetry";
    if (
      options.key &&
      this.state.dedupe[options.key]?.signature === options.signature
    )
      return false;
    if (optional && (this.state.captureHalted || this.pressured())) {
      this.state.optionalSuppressed++;
      return false;
    }
    try {
      this.recover();
      const at = record.at ?? this.now(),
        sequence = this.state.sequence + 1,
        sourceEpisodeId =
          record.sourceEpisodeId ??
          record.episodeId ??
          record.candidate_episode_id ??
          (["lifecycle", "outcomes"].includes(canonical) && record.tradeId
            ? "INHERITED_UNLINKED_TRADE:" + record.tradeId
            : null);
      this.state.sourceEpisodes ??= {};
      const episodeId = sourceEpisodeId
        ? this.state.sourceEpisodes[sourceEpisodeId] ||
          this.state.epochId + ":" + sourceEpisodeId
        : null;
      const row = clean(
        {
          ...record,
          stream: canonical,
          sourceStream: stream,
          schemaVersion: SCHEMA,
          writerDefinitionId: this.writerDefinitionId || null,
          epochId: this.state.epochId,
          sourceEpisodeId,
          episodeId,
          eventId: this.state.epochId + ":" + sequence,
          sequence,
          at,
          utc: new Date(at).toISOString(),
          receivedAt: this.now(),
          persistedAt: this.now(),
        },
        this.secrets,
      );
      const buffer = Buffer.from(JSON.stringify(row)),
        chunks = Math.ceil(buffer.length / CHUNK),
        hash = sha(buffer);
      const meta = {
        eventId: row.eventId,
        sequence,
        at,
        day: dayAt(row.persistedAt, this.timezone),
        stream: canonical,
        sourceStream: stream,
        epochId: row.epochId,
        episodeId,
        sourceEpisodeId,
        boundary: row.boundary,
        excursion: row.excursion,
        tradeId: row.tradeId,
        admission: row.admission,
        armId:
          canonical === "experiments"
            ? [row.controlTradeId || row.tradeId, row.policy].join(":")
            : null,
        armResolved:
          canonical === "experiments" &&
          (row.complete === true ||
            row.endpoint?.outcomeComplete === true ||
            [
              "SUPPRESSED",
              "INELIGIBLE",
              "DORMANT",
              "REJECTED_BY_BUFFER_GEOMETRY",
              "REJECTED_BY_REPLACEMENT_GEOMETRY",
            ].includes(row.status)),
        sha256: hash,
        chunks,
        bytes: buffer.length,
        attemptId: row.attemptId,
        evaluationId: row.evaluationId,
        provider: row.provider,
        aiEvent: row.event,
        definitionId:
          canonical === "definitions"
            ? row.definitionId || row.configHash
            : null,
        dependencyIds: [
          ...new Set([
            ...(row.dependencyIds || []),
            ...(canonical !== "definitions" && this.writerDefinitionId
              ? [this.writerDefinitionId]
              : []),
            ...(canonical !== "definitions" && row.configHash
              ? [row.configHash]
              : []),
          ]),
        ],
        terminal:
          row.completeness === "CENSORED" ||
          row.event === "LEGACY_EVIDENCE" ||
          row.status === "DATA_GAP" ||
          row.outcomeComplete === true ||
          (row.outcomeComplete !== false &&
            ["CLOSED", "CANCELLED", "EXPIRED", "NO_ORDER"].includes(
              row.status,
            )) ||
          row.transitions?.includes("NO_ORDER"),
        censored:
          row.completeness === "CENSORED" ||
          row.event === "LEGACY_EVIDENCE" ||
          row.status === "DATA_GAP",
        reason:
          row.censorReason ||
          row.reasonCode ||
          row.reason ||
          row.closeReason ||
          row.outcome,
        context: {
          symbol: row.symbol,
          side: row.side,
          configHash: row.configHash,
        },
      };
      this.persistRow(meta,buffer);
      this.transaction(()=>this.apply({meta,key:options.key,signature:options.signature,bytes:buffer.length,nativeUpdate:options.nativeUpdate,ledgerRecord:row.ledgerRecord}));
      return true;
    } catch(error) {
      if(!options.reserveRetry && !['REQUEST_PREPARED'].includes(record.event) && canonical!=='decisions' && canonical!=='definitions' && fs.existsSync(this.reserve)) {
        fs.unlinkSync(this.reserve);this.state.captureHalted=true;
        this.state.lastError={code:error.code||'PROTECTED_CAPACITY_IN_USE',stream:canonical,at:this.now()};
        return this.emit(stream,record,{...options,reserveRetry:true});
      }
      return this.fail(error,canonical,record.sourceEpisodeId||record.episodeId||null,true);
    }
  }
  recoverAI() {for(const a of this.openAttempts())if(!terminal(a)&&!this.emit('ai_calls',{sourceEpisodeId:a.sourceEpisodeId,evaluationId:a.evaluationId,attemptId:a.attemptId,provider:a.provider,event:'INTERRUPTED_UNCERTAIN',disposition:'ERROR',completionUncertain:true,reason:'PROCESS_INTERRUPTED_BEFORE_FINAL_DISPOSITION',at:this.now()}))throw Error('AI_INTERRUPTION_NOT_PERSISTED');}
  memory() {let peak=null;for(const file of ['/sys/fs/cgroup/memory.peak','/sys/fs/cgroup/memory/memory.max_usage_in_bytes'])try{peak=Number(fs.readFileSync(file,'utf8').trim());break;}catch{}const m=process.memoryUsage(),structures=this.index.metrics();structures.reducerWork.count=this.pending?.size||0;structures.scalarDescriptor.bytes=Buffer.byteLength(JSON.stringify(this.scalars()));structures.pointViews={count:TABLES.length,cap:TABLES.length};structures.writerLease={count:this.releaseLease?1:0,cap:1};structures.providerRecent={};for(const provider of ['Groq','Alibaba'])structures.providerRecent[provider]={count:this.get('providerState',provider)?.recentRequests?.length||0,cap:1024};return {rss:m.rss,heapUsed:m.heapUsed,external:m.external,cgroupPeak:peak,structures,enumerationAttempts:this.enumerationAttempts};}
  status() {const s=this.scalars();return {...s,backend:'v3',storageLSN:this.index.root.lsn,acknowledgedLSN:this.index.root.lsn,pendingRows:0,pendingBytes:0,pendingFailure:this.pendingFailure,captureHalted:!!s.captureHalted,timezone:this.timezone,segments:[],archives:this.archiveStatus(),indexJournalBytes:fs.existsSync(this.journal)?fs.statSync(this.journal).size:0,health:s.captureHalted?'RESEARCH CAPTURE HALTED':this.pressured()?'RESEARCH CAPTURE DEGRADED':'HEALTHY',captureReason:s.captureHalted?s.lastError?.code:null,reconciliation:{attempted:s.attemptedRows,accepted:s.acceptedRows,persisted:s.persistedRows,archived:s.archivedRows},liveStructures:this.index.metrics()};}
  archiveStatus() {const rows=[];for(const a of this.values('archives'))if(!a.expired){rows.push(a);rows.sort((a,b)=>b.day.localeCompare(a.day));if(rows.length>7)rows.pop();}return rows;}
  async close(){try{this.flush();}finally{this.index.handles.close();this.index.cache.clear();this.releaseLease?.();}}
  async export(){throw Error('USE_STREAMING_RESEARCH_ARCHIVE');}
}
for(const method of ['pressured','canAdmit','health','epoch'])ResearchStoreV3.prototype[method]=Legacy.ResearchStore.prototype[method];
ResearchStoreV3.prototype.canDispatch=function(){return this.now()>=(this.state.providerRecoveryFenceUntil||0)&&Legacy.ResearchStore.prototype.canDispatch.call(this);};
module.exports={ResearchStoreV3,TABLES,unresolved,terminal};
