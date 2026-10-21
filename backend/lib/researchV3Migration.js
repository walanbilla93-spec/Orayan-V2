'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {ResearchStoreV3,TABLES,unresolved,terminal}=require('./researchStoreV3');
const {atomic,sha,SCHEMA}=require('./researchStore');
const {visitCheckpointJson}=require('./readCheckpointJson');
const {Scratch}=require('./researchV3/scratch');
const {jsonLines}=require('./researchV3/index');
const IO=require('./researchV3/io');
const SCALARS=new Set(['schemaVersion','epochId','startedAt','sequence','attemptedRows','acceptedRows','persistedRows','archivedRows','lostRows','optionalSuppressed','acceptedBytes','retainedBytes','countsByStream','bytesByStream','populationComplete','captureHalted','lastError','lostByStream','attemptedByStream','archivedByStream','uniqueDecisionEpisodes','latestEventId','latestAt','earliestAt','lastClosedDay','indexCompactedThroughDay']);
function* files(root,prefix='') {const dir=fs.opendirSync(path.join(root,prefix));try{let e;while((e=dir.readSync())){const rel=path.join(prefix,e.name);if(e.isSymbolicLink())throw Error('MIGRATION_SOURCE_SYMLINK');if(e.isDirectory())yield* files(root,rel);else if(e.isFile())yield rel;else throw Error('MIGRATION_SOURCE_NOT_REGULAR');}}finally{dir.closeSync();}}
function createHashes(source,target) {const fd=fs.openSync(target,'wx',0o600);let count=0;try{for(const rel of files(source)){const file=path.join(source,rel);IO.write(fd,Buffer.from(JSON.stringify({path:rel,bytes:fs.statSync(file).size,sha256:IO.hashFile(file)})+'\n'));count++;}fs.fsyncSync(fd);}finally{fs.closeSync(fd);}return count;}
function checkHashes(source,target,scratch) {let count=0;for(const e of jsonLines(target)){if(e.incomplete)throw Error('SOURCE_HASH_MANIFEST_TORN');const file=path.join(source,e.path);if(!fs.existsSync(file)||fs.statSync(file).size!==e.bytes||IO.hashFile(file)!==e.sha256)throw Error('MIGRATION_SOURCE_CHANGED:'+e.path);scratch.put('source',e.path,true);count++;}let actual=0;for(const rel of files(source)){if(!scratch.has('source',rel))throw Error('MIGRATION_SOURCE_FILE_ADDED:'+rel);actual++;}if(actual!==count)throw Error('MIGRATION_SOURCE_CHANGED');return count;}
function safeSource(source,name) {const file=path.resolve(source,name);if(!file.startsWith(path.resolve(source)+path.sep))throw Error('MIGRATION_SOURCE_PATH');return file;}
async function migrate(root,{afterStep=()=>{},reserveBytes=0}={}) {
  root=path.resolve(root);const source=path.join(root,'research-canonical-v2'),destination=path.join(root,'research-canonical-v3');
  if(!fs.existsSync(path.join(source,'status.json')))throw Error('V2_SOURCE_UNAVAILABLE');
  const marker=require('./researchV3Activation').readMarker(root);if(marker&&marker.state!=='V2')throw Error('MIGRATION_BACKEND_ALREADY_SELECTED');
  fs.mkdirSync(destination,{recursive:true});const release=require('./researchV3Lease').acquire(destination);
  let store;const scratch=new Scratch(destination,'migration-scratch-');
  const stageFile=path.join(destination,'migration-stage.json'),hashes=path.join(destination,'source-hashes.jsonl'),receiptFile=path.join(destination,'migration-receipt.json');
  try {
    let stage=fs.existsSync(stageFile)?JSON.parse(fs.readFileSync(stageFile,'utf8')):{stage:0};
    if(fs.existsSync(receiptFile)) {require('./researchV3Activation').verify(root);checkHashes(source,hashes,scratch);return JSON.parse(fs.readFileSync(receiptFile,'utf8'));}
    if(!fs.existsSync(hashes)) {const temp=hashes+'.building';if(fs.existsSync(temp))fs.unlinkSync(temp);createHashes(source,temp);fs.renameSync(temp,hashes);}
    checkHashes(source,hashes,scratch);
    store=new ResearchStoreV3(destination,{create:true,offline:true,migration:true,reserveBytes});
    function done(n){store.state.migrationCursor=0;store.flush();atomic(stageFile,{stage:n,sourceHashesSHA256:IO.hashFile(hashes)});stage.stage=n;afterStep('stage:'+n);}
    function visitStep(work){store.transaction(()=>{work();store.state.migrationCursor=(store.state.migrationCursor||0)+1;},{migration:true});afterStep('entry:'+store.state.migrationCursor);}
    if(stage.stage<1) {
      let n=0;const resume=store.state.migrationCursor||0;
      // Import bounded groups, rather than fsyncing the same scalar descriptor
      // for every source key (including archive IDs requiring no destination key).
      // The entry cursor and all keys in a group share one durable transaction.
      let batch=[],batchBytes=0;
      function flushBatch(){
        if(!batch.length)return;
        const entries=batch,start=store.state.migrationCursor||0;
        store.transaction(()=>{
          for(const [field,key,value]of entries){
          if(field==='archiveEventIds')continue; // IDs are reconciled from checked ZIP metadata below, never guessed.
          if(TABLES.includes(field)){if(key!==null)store.put(field,key,value);}
          else if(field==='segments'){if(key!==null)store.put('segments',value.name,value);}
          else if(field==='archives'){if(key!==null){const {eventIds,...descriptor}=value;store.put('archives',value.day,descriptor);}}
          else if(field==='garbageSegments'){if(key!==null)store.put('garbageSegments',value,true);}
          else if(SCALARS.has(field)) {
            if(field==='schemaVersion'){if(value!==SCHEMA)throw Error('V2_SCHEMA_MISMATCH');continue;}
            if(key===null)store.state[field]=value;else{store.state[field]??={};Object.defineProperty(store.state[field],key,{value,writable:true,enumerable:true,configurable:true});}
          }else throw Error('MIGRATION_UNKNOWN_SOURCE_FIELD:'+field);
          }
          store.state.migrationCursor=start+entries.length;
        },{migration:true});
        batch=[];batchBytes=0;
        for(let i=1;i<=entries.length;i++)afterStep('entry:'+(start+i));
      }
      visitCheckpointJson(path.join(source,'status.json'),(field,key,value)=>{
        if(++n<=resume)return;
        const bytes=Buffer.byteLength(JSON.stringify([field,key,value]));
        if(batch.length&&(batch.length>=64||batchBytes+bytes>128*1024))flushBatch();
        batch.push([field,key,value]);batchBytes+=bytes;
      });
      flushBatch();
      done(1);
    }
    if(stage.stage<2) {
      let n=0;const resume=store.state.migrationCursor||0;
      const journal=path.join(source,'index-journal.jsonl');
      function replay(txn) {
        if(++n<=resume)return;
        visitStep(()=>{
          if(txn.nativeOnly){store.put('nativeEpisodeIndex',txn.nativeUpdate.key,txn.nativeUpdate.value);return;}
          if(txn.meta.sequence<=store.state.sequence)return;
          if(txn.meta.sequence!==store.state.sequence+1)throw Error('V2_JOURNAL_SEQUENCE_GAP');
          store.apply({...txn,segments:[]});
        });
      }
      if(fs.existsSync(journal))for(const line of jsonLines(journal,32*1024*1024)) {
        if(line.incomplete){store.state.migrationIncompleteJournalTail=true;break;}
        if(sha(line.data)!==line.sha256)throw Error('V2_JOURNAL_CHECKSUM');replay(JSON.parse(line.data));
      }
      const wal=path.join(source,'wal','commit.json');if(fs.existsSync(wal))replay(JSON.parse(fs.readFileSync(wal,'utf8')));
      done(2);
    }
    if(stage.stage<3) {
      // Recover physical pieces into destination only. Neither journal recovery
      // nor WAL repair ever opens the source with write access.
      const A=require('./researchArchive');let rowCount=0;
      function piece(p) {
        const m=p.meta;if(!store.get('events',m.eventId))return;
        if(!Number.isInteger(p.index)||p.index<0||p.index>=m.chunks)throw Error('V2_PIECE_INDEX');
        const key=m.eventId+':'+p.index,existing=scratch.get('pieces',key);
        if(existing!==undefined){if(existing!==p.data)throw Error('V2_PIECE_CONFLICT');return;}
        scratch.put('pieces',key,p.data);const count=(scratch.get('counts',m.eventId)||0)+1;scratch.put('counts',m.eventId,count);
        if(count===m.chunks){
          const targetMeta=store.get('events',m.eventId);if(targetMeta.sha256!==m.sha256)throw Error('V2_EVENT_META_CONFLICT');
          const target=store.rowPath(m);fs.mkdirSync(path.dirname(target),{recursive:true});const temp=target+'.migrating',fd=fs.openSync(temp,'w',0o600),h=crypto.createHash('sha256');let bytes=0;
          try{for(let i=0;i<m.chunks;i++){const data=scratch.get('pieces',m.eventId+':'+i);if(data===undefined)throw Error('V2_PIECE_MISSING');const b=Buffer.from(data,'base64');h.update(b);bytes+=b.length;IO.write(fd,b);}fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
          if(h.digest('hex')!==m.sha256||bytes!==m.bytes)throw Error('V2_EVENT_CHECKSUM');
          fs.renameSync(temp,target);if(process.platform!=='win32')IO.syncDir(path.dirname(target));rowCount++;afterStep('row:'+rowCount);
        }
      }
      for(const a of store.values('archives'))if(!a.expired){
        const file=safeSource(source,path.join('archives',a.filename));if(IO.hashFile(file)!==a.sha256)throw Error('V2_ARCHIVE_CHECKSUM');
        await require('./researchArchiveV3').verify(file);
        const target=path.join(destination,'archives',a.filename);fs.copyFileSync(file,target);const fd=fs.openSync(target,'r+');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
        await A.zipEntries(file,async(name,s)=>{if(!name.startsWith('records/')){s.resume();return;}for await(const p of A.lines(s))piece(p);});
      }
      for(const name of files(source))if(/^segment-[^/\\]+\.jsonl$/.test(name)) {
        const file=safeSource(source,name);
        // Pending WAL may extend the destination-visible descriptor beyond source bytes.
        for(const p of jsonLines(file,16*1024*1024)){if(p.incomplete)break;piece(p);}
      }
      const wal=path.join(source,'wal','commit.json');if(fs.existsSync(wal)){const tx=JSON.parse(fs.readFileSync(wal,'utf8'));for(const p of tx.parts||[]){const file=safeSource(source,path.join('wal',p.name));if(IO.hashFile(file)!==p.sha256)throw Error('V2_WAL_CHECKSUM');for(const line of jsonLines(file,16*1024*1024)){if(line.incomplete)throw Error('V2_WAL_TORN');piece(line);}}}
      for(const m of store.values('events')){const file=store.rowPath(m);if(!fs.existsSync(file)||fs.statSync(file).size!==m.bytes||IO.hashFile(file)!==m.sha256)throw Error('MIGRATION_EVENT_MISSING:'+m.eventId);}
      done(3);
    }
    if(stage.stage<4) {
      // Rebuild compact projections by cursor; source projections remain exact.
      for(const [id]of store.entries('evaluations'))store.remove('evaluations',id);
      for(const table of ['providerState','providerDays','providerRequestIds','providerTerminalIds','providerCandidates','providerStartedCandidates','providerOpenRequests'])for(const [id]of store.entries(table))store.remove(table,id);
      store.state.episodeStates={};store.state.retainedRows=0;store.state.retainedBytes=0;
      for(const m of store.values('events')){store.state.retainedRows++;store.state.retainedBytes+=m.bytes;if(m.definitionId){const prior=store.get('events',store.get('definitions',m.definitionId));if(!prior||prior.sequence<m.sequence)store.put('definitions',m.definitionId,m.eventId);}}
      for(const [id,e]of store.entries('episodes')){store.state.episodeStates[e.state]=(store.state.episodeStates[e.state]||0)+1;if(unresolved(e))store.put('openEpisodes',id,true);else store.remove('openEpisodes',id);}
      for(const [id,a]of store.entries('aiAttempts')){if(terminal(a))store.remove('openAttempts',id);else store.put('openAttempts',id,true);if(a.evaluationId){const e=store.evaluation(a.evaluationId);e.count++;if(!e.lastSequence||a.sequence>e.lastSequence){e.lastSequence=a.sequence;e.lastAttemptId=id;}if(a.aiEvent==='PARSED_RESPONSE'&&(!e.completion||e.completion.sequence<a.sequence))e.completion=a;store.put('evaluations',a.evaluationId,e);}}
      await require('./researchArchiveV3').rows(store,row=>{if(row.ledgerRecord)store.transaction(()=>require('./researchV3Provider').reduce(store,row.provider,row.ledgerRecord,Date.now()),{migration:true});});
      done(4);
    }
    const reconciled=await reconcile(source,store,scratch);
    const sourceFileCount=checkHashes(source,hashes,scratch);
    delete store.state.migrationCursor;store.flush();
    const body={contract:'ORAYAN_V2_TO_V3_1',state:'VERIFIED_NOT_ACTIVE',source,destination,sourceFileCount,sourceHashesBefore:IO.hashFile(hashes),sourceHashesAfter:IO.hashFile(hashes),currentSHA256:IO.hashFile(path.join(destination,'index','CURRENT')),storageLSN:store.index.root.lsn,acknowledgedLSN:store.index.root.lsn,eventSequence:store.state.sequence,acceptedRows:store.state.acceptedRows,persistedRows:store.state.persistedRows,coverage:{dedupe:'EXACT_SOURCE_KEYS_ONLY',priorCompactionGaps:'PRESERVED_NOT_RECONSTRUCTED',retainedIndexedRows:store.state.retainedRows,acceptedRowsOutsideRetainedIndex:store.state.acceptedRows-store.state.retainedRows,incompleteJournalTail:!!store.state.migrationIncompleteJournalTail,sourceStorageLSN:'V2_HAS_EVENT_SEQUENCE_AND_NATIVE_JOURNAL_NO_GLOBAL_STORAGE_LSN'},reconciled,at:Date.now()};
    const receipt={...body,sha256:sha(JSON.stringify(body))};atomic(receiptFile,receipt);afterStep('verified');return receipt;
  }finally{if(store){store.index.handles.close();store.index.cache.clear();}scratch.close();release();}
}
async function reconcile(source,store,scratch) {
  let checked=0;const journalChanged=store.state.sequence;
  const expectedState={};
  visitCheckpointJson(path.join(source,'status.json'),(field,key,value)=>{
    if(TABLES.includes(field)&&key!==null) {
      // Later journal updates legitimately replace these keys. Equality is
      // checked against an independently replayed point expectation below.
      scratch.put('expect-'+field,key,value);checked++;
    }else if(SCALARS.has(field)&&field!=='schemaVersion'){if(key===null)expectedState[field]=value;else{expectedState[field]??={};Object.defineProperty(expectedState[field],key,{value,writable:true,enumerable:true,configurable:true});}}
  });
  const journal=path.join(source,'index-journal.jsonl');const transactions=function*(){if(fs.existsSync(journal))for(const line of jsonLines(journal,32*1024*1024)){if(line.incomplete)break;yield JSON.parse(line.data);}const wal=path.join(source,'wal','commit.json');if(fs.existsSync(wal))yield JSON.parse(fs.readFileSync(wal,'utf8'));};
  // Independently apply only touched projections with the same shared reducer,
  // using disk expectations rather than instantiating the V2 store.
  for(const table of TABLES)expectedState[table]=new Proxy(Object.create(null),{get:(_,k)=>scratch.get('expect-'+table,k),set:(_,k,v)=>{scratch.put('expect-'+table,k,v);return true;}});
  const expected={state:expectedState};
  for(const tx of transactions())if(tx.nativeOnly)scratch.put('expect-nativeEpisodeIndex',tx.nativeUpdate.key,tx.nativeUpdate.value);else if(tx.meta.sequence>expectedState.sequence)require('./researchStore').ResearchStore.prototype.apply.call(expected,{...tx,segments:[]});
  if(expectedState.sequence!==journalChanged)throw Error('MIGRATION_SEQUENCE_RECONCILIATION');
  for(const field of SCALARS)if(!['schemaVersion','retainedBytes'].includes(field)&&JSON.stringify(expectedState[field])!==JSON.stringify(store.state[field]))throw Error('MIGRATION_SCALAR_RECONCILIATION:'+field);
  for(const table of TABLES){for(const [key,v]of scratch.entries('expect-'+table))if(JSON.stringify(store.get(table,key))!==JSON.stringify(v))throw Error('MIGRATION_PROJECTION_RECONCILIATION:'+table+':'+key);for(const [key]of store.entries(table))if(scratch.get('expect-'+table,key)===undefined)throw Error('MIGRATION_INVENTED_KEY:'+table+':'+key);}
  if(store.state.acceptedRows!==store.state.persistedRows||store.state.attemptedRows!==store.state.acceptedRows+store.state.lostRows)throw Error('MIGRATION_COUNTER_RECONCILIATION');
  let openEpisodes=0,openAttempts=0,events=0;for(const [,e]of store.openEpisodes()){if(!unresolved(e))throw Error('MIGRATION_OPEN_PROJECTION');openEpisodes++;}for(const a of store.openAttempts()){if(terminal(a))throw Error('MIGRATION_PROVIDER_PROJECTION');openAttempts++;}for(const m of store.values('events')){if(IO.hashFile(store.rowPath(m))!==m.sha256)throw Error('MIGRATION_ROW_RECONCILIATION');events++;}
  const expectedProvider={dir:store.dir,get:(table,id)=>scratch.get('provider-'+table,id),put:(table,id,v)=>scratch.put('provider-'+table,id,v),remove:(table,id)=>scratch.put('provider-'+table,id,null)};
  // Deletions in this independent evidence replay use absence semantics.
  expectedProvider.get=(table,id)=>scratch.get('provider-'+table,id)??undefined;
  await require('./researchArchiveV3').rows(store,row=>{if(row.ledgerRecord)require('./researchV3Provider').reduce(expectedProvider,row.provider,row.ledgerRecord,Date.now());});
  const providerTables=['providerState','providerDays','providerRequestIds','providerTerminalIds','providerCandidates','providerStartedCandidates','providerOpenRequests'];
  const stable=(table,value)=>{if(table!=='providerState')return value;const {recentRequests,minuteOverflowUntil,...rest}=value;return rest;};
  for(const table of providerTables) {
    for(const [key,v]of scratch.entries('provider-'+table))if(v!==null&&JSON.stringify(stable(table,v))!==JSON.stringify(stable(table,store.get(table,key))))throw Error('MIGRATION_PROVIDER_RECONCILIATION:'+table);
    for(const [key,v]of store.entries(table))if(JSON.stringify(stable(table,v))!==JSON.stringify(stable(table,expectedProvider.get(table,key))))throw Error('MIGRATION_PROVIDER_EXTRA_KEY:'+table);
  }
  return {sourceProjectionKeys:checked,events,openEpisodes,openAttempts,sourceNativeAndExtrema:'EXACT',providerProjections:'EXACT_DURABLE_KEYS_COUNTERS_SUMMARIES',sourceBytes:'UNCHANGED',eventSequence:journalChanged};
}
module.exports={migrate,reconcile,files,createHashes,checkHashes};
