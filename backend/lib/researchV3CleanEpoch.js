'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {Scratch}=require('./researchV3/scratch'),IO=require('./researchV3/io');
const {visitCheckpointJson,visitJsonArray}=require('./readCheckpointJson');
const {jsonLines}=require('./researchV3/index'),{ResearchStore,sha,atomic}=require('./researchStore');
const {ResearchStoreV3,TABLES,terminal}=require('./researchStoreV3'),A=require('./researchV3Activation'),B=require('./researchV3Abandon');
const pointer=root=>path.join(root,'research-clean-v3-preparation.json');
const open=t=>['OPEN','PENDING'].includes(t?.status)||t?.mode==='live'&&!!t.privateOutcome;
const shadowOpen=t=>open(t)||t?.status==='CLOSED'&&t.fundingStatus==='PENDING'||Object.values(t?.research35?.arms||{}).some(a=>a.trade&&(open(a.trade)||a.trade.status==='CLOSED'&&a.trade.fundingStatus==='PENDING'));
function assertOffline(root){if(process.env.ORAYAN_V3_OFFLINE!=='true')throw Error('OFFLINE_ASSERTION_REQUIRED');if(!fs.existsSync(path.join(root,'research-v3-bulk-migration-abandoned.json')))throw Error('ABANDONMENT_RECEIPT_REQUIRED');if(A.readMarker(root)!==null)throw Error('CLEAN_EPOCH_REQUIRES_PRE_ACTIVATION_STATE');}
function stripAI(v){if(Array.isArray(v))return v.map(stripAI);if(!v||typeof v!=='object')return v;const out={};for(const [k,x]of Object.entries(v))if(!/^(groqContext|alibabaContext|qwenContext|reflection_memory|feedback|lessons|meta_lite|metaBrain|original_ai|aiContext|aiDecision|aiOutputs)$/i.test(k))out[k]=stripAI(x);return out;}
function sourceProjection(root,scratch){
  const source=path.join(root,'research-canonical-v2'),state={sequence:0,attemptedRows:0,acceptedRows:0,persistedRows:0,acceptedBytes:0,countsByStream:{},bytesByStream:{},segments:[]};
  const scalar=new Set(['epochId','startedAt','sequence','attemptedRows','acceptedRows','persistedRows','acceptedBytes','countsByStream','bytesByStream','latestAt','earliestAt','latestEventId','uniqueDecisionEpisodes']);
  const operational=new Set(['episodes','sourceEpisodes','episodeMetadata','nativeEpisodeIndex','aiAttempts','extremes']);
  for(const table of TABLES)state[table]=new Proxy(Object.create(null),{get:(_,key)=>operational.has(table)?scratch.get('source-'+table,key):undefined,set:(_,key,value)=>{if(operational.has(table))scratch.put('source-'+table,key,value);return true;}});
  visitCheckpointJson(path.join(source,'status.json'),(field,key,value)=>{
    if(operational.has(field)&&key!==null)scratch.put('source-'+field,key,value);
    else if(scalar.has(field)){if(key===null)state[field]=value;else{state[field]??={};Object.defineProperty(state[field],key,{value,writable:true,enumerable:true,configurable:true});}}
  });
  function replay(tx){if(tx.nativeOnly){scratch.put('source-nativeEpisodeIndex',tx.nativeUpdate.key,tx.nativeUpdate.value);return;}if(tx.meta.sequence<=state.sequence)return;if(tx.meta.sequence!==state.sequence+1)throw Error('OPERATIONAL_JOURNAL_SEQUENCE_GAP');ResearchStore.prototype.apply.call({state},{...tx,segments:[]});}
  const journal=path.join(source,'index-journal.jsonl');if(fs.existsSync(journal))for(const line of jsonLines(journal,32*1024*1024)){if(line.incomplete)break;if(sha(line.data)!==line.sha256)throw Error('OPERATIONAL_JOURNAL_CHECKSUM');replay(JSON.parse(line.data));}
  const wal=path.join(source,'wal','commit.json');if(fs.existsSync(wal))replay(JSON.parse(fs.readFileSync(wal)));
  return {epochId:state.epochId,sequence:state.sequence,latestAt:state.latestAt||state.startedAt};
}
function checkpoint(file,scratch,epochId,startedAt){
  fs.mkdirSync(path.dirname(file),{recursive:true});const fd=fs.openSync(file,'wx',0o600);try{
    IO.write(fd,Buffer.from(JSON.stringify({startedAt,captureCohort:epochId}).slice(0,-1)));
    for(const [name,table]of [['activeTrades','shadow-active'],['armWorkers','shadow-arms']]){IO.write(fd,Buffer.from(',"'+name+'":['));let comma=false;for(const pair of scratch.entries(table)){if(comma)IO.write(fd,Buffer.from(','));IO.write(fd,Buffer.from(JSON.stringify(pair)));comma=true;}IO.write(fd,Buffer.from(']'));}
    IO.write(fd,Buffer.from('}'));fs.fsyncSync(fd);
  }finally{fs.closeSync(fd);}if(fs.statSync(file).size>=8*1024*1024)throw Error('SHADOW_OPERATIONAL_CHECKPOINT_CAPACITY');
}
async function prepare(root){
  root=path.resolve(root);assertOffline(root);
  if(fs.existsSync(pointer(root))){const p=JSON.parse(fs.readFileSync(pointer(root)));const r=JSON.parse(fs.readFileSync(path.join(p.prepared,'migration-receipt.json')));if(r.currentSHA256!==IO.hashFile(path.join(p.prepared,'index','CURRENT')))throw Error('PREPARED_EPOCH_CHANGED');return r;}
  const fence=B.read(path.join(root,'research-v3-bulk-migration-abandoned.json')).body,abandoned=B.read(fence.receipt).body;
  B.verifySource(root,abandoned.sourceHashes);
  const epochId=crypto.randomUUID(),startedAt=Date.now(),prepared=path.join(root,'research-clean-v3-prepared-'+epochId),destination=path.join(root,'research-canonical-v3');
  const scratch=new Scratch(root,'clean-obligations-'),inputHashes={},counts={native:0,shadowActive:0,shadowArms:0,episodes:0,uncertainAttempts:0,nativeMappings:0,extrema:0};let c;
  const hashInput=file=>{if(fs.existsSync(file))inputHashes[path.relative(root,file)]=IO.hashFile(file);};
  try{
    const source=sourceProjection(root,scratch),nativeFile=path.join(root,'trades.json'),shadowFile=path.join(root,'v3-shadow-compact-v1','checkpoint.json');hashInput(nativeFile);hashInput(shadowFile);
    function owner(kind,id,t){if(!id)throw Error('OPERATIONAL_OWNER_ID_MISSING');const sourceId=t.episodeId||'INHERITED_UNLINKED_TRADE:'+id;scratch.put('owners',kind+':'+id,{kind,id,sourceEpisodeId:sourceId,status:t.status,snapshotSHA256:sha(JSON.stringify(t)),reason:t.status==='CLOSED'?'UNRESOLVED_FUNDING_OR_PRIVATE_OUTCOME':'OPEN_OR_PENDING_MANAGEMENT'});scratch.put('wantedSources',sourceId,true);scratch.put('wantedTrades',id,true);}
    if(fs.existsSync(nativeFile))visitJsonArray(nativeFile,t=>{if(open(t)&&t.engine!=='MARCI_SHADOW'&&!String(t.researchEngine||'').startsWith('MARCI')){owner('native',t.id,t);counts.native++;}});
    if(fs.existsSync(shadowFile))visitCheckpointJson(shadowFile,(field,key,value)=>{if(['activeTrades','armWorkers'].includes(field)&&key!==null){const [id,t]=value;if(!shadowOpen(t))return;owner(field==='activeTrades'?'shadow-active':'shadow-arms',id,t);scratch.put(field==='activeTrades'?'shadow-active':'shadow-arms',id,stripAI(t));counts[field==='activeTrades'?'shadowActive':'shadowArms']++;}});
    c=new ResearchStoreV3(prepared,{create:true,offline:true,migration:true,epochId,startedAt,reserveBytes:0});c.state.cleanProspectiveExperiment=true;c.state.historicalImport='NONE';c.state.feedbackMemoryStartedEmpty=true;c.state.previousEpochReference=source.epochId;
    for(const [,o]of scratch.entries('owners'))if(o.kind==='native')c.put('members','inherited-native:'+o.id,true);
    if(!c.emit('integrity',{event:'CLEAN_PROSPECTIVE_EPOCH_OPENED',at:startedAt,previousEpochReference:source.epochId,completedHistoryImported:false,feedbackMemoryImported:false}))throw Error('CLEAN_EPOCH_OPEN_NOT_PERSISTED');
    for(const [sourceId]of scratch.entries('wantedSources')){
      const oldId=scratch.get('source-sourceEpisodes',sourceId),old=oldId&&scratch.get('source-episodes',oldId),id=epochId+':'+sourceId;
      if(!c.emit('integrity',{event:'OPERATIONAL_CONTINUITY_ANCHOR',inheritedSourceEpisodeId:sourceId,previousEpochId:source.epochId,previousEpisodeId:oldId||null,previousOriginEventReference:old?.originEventId||null,at:startedAt,coverage:old?'CURRENT_OPEN_OBLIGATION_ONLY':'SOURCE_EPISODE_UNAVAILABLE'}))throw Error('CONTINUITY_ANCHOR_NOT_PERSISTED');
      const anchor=c.state.latestEventId,controls={},arms={};for(const [key,resolved]of Object.entries(old?.controls||{}))if(!resolved&&scratch.has('wantedTrades',key))controls[key]=false;for(const [key,resolved]of Object.entries(old?.arms||{}))if(!resolved)arms[key]=false;
      const e={state:old?.hasCriticalLoss?'CENSORED':'OPEN',originEventId:anchor,latestEventId:anchor,latestDecisionId:null,epochId,controlResolved:false,hasDecision:false,hasCriticalLoss:!!old?.hasCriticalLoss,reason:'INHERITED_OPERATIONAL_OBLIGATION_WITH_V2_REFERENCE',controls,arms,continuity:{previousEpochId:source.epochId,previousEpisodeId:oldId||null,birthEvidenceImported:false}};
      c.transaction(()=>{c.put('episodes',id,e);c.put('sourceEpisodes',sourceId,id);c.put('openEpisodes',id,true);const meta=scratch.get('source-episodeMetadata',sourceId)||{};c.put('episodeMetadata',sourceId,Object.fromEntries(['symbol','side','strategy','configHash'].filter(k=>meta[k]!==undefined).map(k=>[k,meta[k]])));c.state.episodeStates[e.state]=(c.state.episodeStates[e.state]||0)+1;});counts.episodes++;
      if(JSON.stringify(c.get('episodes',id))!==JSON.stringify(e)||c.get('sourceEpisodes',sourceId)!==id)throw Error('OPEN_OBLIGATION_RECONCILIATION');
    }
    for(const [id,v]of scratch.entries('source-nativeEpisodeIndex'))if(v.episodeId&&scratch.has('wantedSources',v.episodeId)){c.put('nativeEpisodeIndex',id,v);if(JSON.stringify(c.get('nativeEpisodeIndex',id))!==JSON.stringify(v))throw Error('NATIVE_MAPPING_RECONCILIATION');counts.nativeMappings++;}
    for(const [id,v]of scratch.entries('source-extremes'))if(scratch.has('wantedTrades',id)){c.put('extremes',id,v);if(JSON.stringify(c.get('extremes',id))!==JSON.stringify(v))throw Error('OPEN_EXTREMA_RECONCILIATION');counts.extrema++;}
    for(const [id,a]of scratch.entries('source-aiAttempts'))if(!terminal(a)){
      if(!c.emit('ai_calls',{event:'INTERRUPTED_UNCERTAIN',attemptId:id,evaluationId:a.evaluationId,provider:a.provider,inheritedSourceEpisodeId:a.sourceEpisodeId||null,previousEpochId:source.epochId,completionUncertain:true,reason:'PRE_CUTOVER_REQUEST_RECONCILED_WITHOUT_RETRY_OR_OLD_OUTPUT',at:startedAt}))throw Error('UNCERTAIN_ATTEMPT_NOT_PERSISTED');counts.uncertainAttempts++;
      if(c.get('aiAttempts',id)?.aiEvent!=='INTERRUPTED_UNCERTAIN')throw Error('UNCERTAIN_ATTEMPT_RECONCILIATION');
    }
    // Never reset a potentially spent provider budget mid-day. This expires at
    // the old capture's next UTC day; old lessons or provider outputs are not read.
    c.state.providerRecoveryFenceUntil=Date.parse(new Date(source.latestAt).toISOString().slice(0,10)+'T00:00:00Z')+86400000;
    c.state.operationalContinuity=counts;c.flush();
    checkpoint(path.join(prepared,'shadow-operational','checkpoint.json'),scratch,epochId,startedAt);
    fs.mkdirSync(path.join(prepared,'feedback-memory'),{recursive:true});
    const obligationFile=path.join(prepared,'operational-obligations.jsonl'),fd=fs.openSync(obligationFile,'wx',0o444);try{for(const [,o]of scratch.entries('owners')){const episodeId=c.get('sourceEpisodes',o.sourceEpisodeId);if(!episodeId||!c.get('openEpisodes',episodeId))throw Error('OPERATIONAL_OWNER_NOT_RECONCILED');IO.write(fd,Buffer.from(JSON.stringify({...o,newEpisodeId:episodeId,reconciled:true})+'\n'));}fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    for(const [rel,hash]of Object.entries(inputHashes))if(IO.hashFile(path.join(root,rel))!==hash)throw Error('OPERATIONAL_INPUT_CHANGED:'+rel);
    const sourceProof=B.verifySource(root,abandoned.sourceHashes);
    const body={contract:'ORAYAN_CLEAN_V3_EPOCH_1',state:'VERIFIED_NOT_ACTIVE',epochId,startedAt,destination,prepared,currentSHA256:IO.hashFile(path.join(prepared,'index','CURRENT')),storageLSN:c.index.root.lsn,sourceHashes:abandoned.sourceHashes,sourceHashesBefore:sourceProof.manifestSHA256,sourceHashesAfter:sourceProof.manifestSHA256,inputHashes,obligations:counts,obligationsSHA256:IO.hashFile(obligationFile),completedV2HistoryImported:false,oldAIOutputsImported:false,feedbackMemoryStartedEmpty:true,oldMetaLearningStateImported:false,at:Date.now()};
    const receipt={...body,sha256:sha(JSON.stringify(body))};atomic(path.join(prepared,'migration-receipt.json'),receipt);atomic(pointer(root),{prepared,epochId,receiptSHA256:receipt.sha256});return receipt;
  }finally{c?.index.handles.close();c?.index.cache.clear();scratch.close();}
}
function publish(root){root=path.resolve(root);assertOffline(root);if(fs.existsSync(path.join(root,'research-canonical-v3')))throw Error('ABANDONED_STAGING_MUST_BE_REMOVED_FIRST');const p=JSON.parse(fs.readFileSync(pointer(root))),file=path.join(p.prepared,'migration-receipt.json'),r=JSON.parse(fs.readFileSync(file)),{sha256,...body}=r;if(sha(JSON.stringify(body))!==sha256||sha256!==p.receiptSHA256||IO.hashFile(path.join(p.prepared,'index','CURRENT'))!==r.currentSHA256)throw Error('CLEAN_PREPARATION_INTEGRITY');for(const [rel,hash]of Object.entries(r.inputHashes))if(IO.hashFile(path.join(root,rel))!==hash)throw Error('OPERATIONAL_INPUT_CHANGED');B.verifySource(root,r.sourceHashes);fs.renameSync(p.prepared,r.destination);if(process.platform!=='win32')IO.syncDir(root);return A.verify(root);}
module.exports={prepare,publish,sourceProjection,open,shadowOpen,stripAI};
