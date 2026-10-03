'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const POLICY='V34B_REQUIRED_LOSSLESS_WAL_V4';
const digest=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const HOUR=3600000,CHANNELS=['v3','v2','ai','trades','paths','errors','arms'];
const hourOf=at=>new Date(at).toISOString().slice(0,13).replace('T','-');
const hourAt=h=>Date.parse(h.slice(0,10)+'T'+h.slice(11)+':00:00Z');
function atomic(file,value){const tmp=file+'.tmp',fd=fs.openSync(tmp,'w');try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);
  if(process.platform!=='win32'){const d=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}}
function priority(entries){return entries.some(({channel,row})=>['trades','paths','errors','arms'].includes(channel)||
  row.kind==='candidate_birth'||row.v3Decision==='ACCEPT_SHADOW'||
  row.outputType==='V3_SHADOW_TRADE')?'PRIORITY':'STANDARD';}
class CaptureLedger {
  constructor(dir){
    this.dir=path.join(dir,'capture-ledger');fs.mkdirSync(this.dir,{recursive:true});this.file=path.join(this.dir,'totals.json');
    this.state=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):
      {version:'EXACT_OFFERED_ROWS_BYTES_V1',startedAt:Date.now(),generation:0,totals:{},cursors:{},cleanHours:0,lastEvaluatedHour:null,receiptHours:{},errors:{}};
    this.hours=new Map();this.tombstones=path.join(this.dir,'tombstones');fs.mkdirSync(this.tombstones,{recursive:true});
    this.state.epochId=this.state.epochId||POLICY+'_'+Date.now();this.state.epochStartedAt=this.state.epochStartedAt||Date.now();this.save();
  }
  bucket(hour){if(!this.hours.has(hour)){const f=path.join(this.dir,hour+'.json');this.hours.set(hour,fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{});}
    return this.hours.get(hour);}
  save(){atomic(this.file,this.state);}
  reconcileInterrupted(){
    const repair=o=>{for(const b of Object.values(o)){const rows=b.attemptedRows-b.acceptedRows-b.skippedRows,bytes=b.attemptedBytes-b.acceptedBytes-b.skippedBytes;
      if(rows>0){b.skippedRows+=rows;b.skippedBytes+=bytes;b.interruptedUncommittedRows=(b.interruptedUncommittedRows||0)+rows;}}};
    repair(this.state.totals);
    for(const name of fs.readdirSync(this.dir).filter(n=>/^\d{4}-\d{2}-\d{2}-\d{2}\.json$/.test(n))){
      const file=path.join(this.dir,name),bucket=JSON.parse(fs.readFileSync(file,'utf8'));repair(bucket);atomic(file,bucket);
    }
    this.hours.clear();this.save();
  }
  account(entries,outcome,klass){
    for(const {channel,row} of entries){
      const h=hourOf(row.capturedAt),key=[channel,row.outputType||'UNKNOWN',klass].join('|'),bytes=Buffer.byteLength(JSON.stringify(row)+'\n');
      const add=o=>{const b=o[key]||(o[key]={channel,recordType:row.outputType||'UNKNOWN',priority:klass,
        attemptedRows:0,attemptedBytes:0,acceptedRows:0,acceptedBytes:0,skippedRows:0,skippedBytes:0});b[outcome+'Rows']++;b[outcome+'Bytes']+=bytes;};
      add(this.state.totals);const bucket=this.bucket(h);add(bucket);atomic(path.join(this.dir,h+'.json'),bucket);
      if(outcome==='accepted')this.state.cursors[channel]=(this.state.cursors[channel]||0)+1;
    }
    if(outcome==='accepted')this.state.generation++;
    while(this.hours.size>33)this.hours.delete([...this.hours.keys()].sort()[0]);this.save();
  }
  identity(headline){
    if(this.state.historicalResidual===undefined&&Number.isFinite(headline)){
      this.state.historicalResidual=headline-Object.values(this.state.totals).reduce((n,b)=>n+b.skippedRows,0);this.save();
    }
    const s=Object.values(this.state.totals),sum=k=>s.reduce((n,b)=>n+(b[k]||0),0);
    return {epochId:this.state.epochId,epochStartedAt:this.state.epochStartedAt,baselineRows:0,baselineSkippedRows:this.state.historicalResidual??null,
      baselineStatus:'UNRESOLVED_HISTORICAL_PRE_LEDGER_RESIDUAL',attemptedRows:sum('attemptedRows'),acceptedRows:sum('acceptedRows'),skippedRows:sum('skippedRows'),
      attemptedBytes:sum('attemptedBytes'),acceptedBytes:sum('acceptedBytes'),skippedBytes:sum('skippedBytes'),recoveredAdjustments:0,
      equation:'baselineRows(0) + attemptedRows = acceptedRows + skippedRows; historical residual is outside ledger epoch; recovery adjustments = 0',
      rowsReconciled:sum('attemptedRows')===sum('acceptedRows')+sum('skippedRows'),bytesReconciled:sum('attemptedBytes')===sum('acceptedBytes')+sum('skippedBytes')};
  }
  key(channel,row,klass){return [channel,row.outputType||'UNKNOWN',klass,this.state.epochId,row.holdoutCohort||'PRE_COHORT',row.implementationHash||'UNAVAILABLE'].join('|');}
  detailedAccount(entries,outcome,klass,reason=null){
    for(const {channel,row} of entries){const h=hourOf(row.capturedAt),key=this.key(channel,row,klass),bytes=Buffer.byteLength(JSON.stringify(row)+'\n');
      for(const o of [this.state.totals,this.bucket(h)]){const b=o[key]||(o[key]={channel,recordType:row.outputType||'UNKNOWN',priority:klass,hour:h,
        epochId:this.state.epochId,cohortId:row.holdoutCohort||null,writerImplementationHash:row.implementationHash||null,writerImplementationHashScope:'EXACT_KEY_PARTITION',
        attemptedRows:0,attemptedBytes:0,acceptedRows:0,acceptedBytes:0,skippedRows:0,skippedBytes:0,physicalCompressedBytesWritten:0,physicalCompressedGrowthBytes:0,skipReasons:{}});
        b[outcome+'Rows']++;b[outcome+'Bytes']+=bytes;if(outcome==='attempted'||outcome==='accepted'){
          b['first'+(outcome==='attempted'?'Attempted':'Accepted')+'At']??=row.capturedAt;b['last'+(outcome==='attempted'?'Attempted':'Accepted')+'At']=row.capturedAt;}
        if(reason)b.skipReasons[reason]=(b.skipReasons[reason]||0)+1;}
    }
    for(const h of new Set(entries.map(e=>hourOf(e.row.capturedAt))))atomic(path.join(this.dir,h+'.json'),this.bucket(h));this.save();
  }
  tombstone(entries,klass,reason){
    for(const {channel,row} of entries){const logical=JSON.stringify(row)+'\n',id=digest([channel,logical]);
      atomic(path.join(this.tombstones,id+'.json'),{outputType:'CAPTURE_SKIP_TOMBSTONE',eventId:row.eventId||id,logicalSha256:crypto.createHash('sha256').update(logical).digest('hex'),
        candidateId:row.candidateId??row.v3CandidateId??row.trade?.candidateId??null,scanId:row.scanId??null,decisionAt:row.decisionAt??null,
        symbol:row.symbol??row.trade?.symbol??null,side:row.side??row.trade?.side??null,regime:row.regime??null,scanOrdinal:row.scanOrdinal??null,
        channel,type:row.outputType,priority:klass,attemptedBytes:Buffer.byteLength(logical),reasonCode:reason,hour:hourOf(row.capturedAt),
        cohortId:row.holdoutCohort??null,epochId:this.state.epochId,capturedAt:row.capturedAt,archiveWriteSkipped:true,downstreamDecisionSkipped:false,
        permanentLoss:true,recovered:false,recoveredAt:null});}
  }
  records(){const out=[];for(const name of fs.readdirSync(this.dir).filter(n=>/^\d{4}-\d{2}-\d{2}-\d{2}\.json$/.test(n)).sort()){
    const hour=name.slice(0,-5);for(const b of Object.values(JSON.parse(fs.readFileSync(path.join(this.dir,name),'utf8'))))out.push({outputType:'CAPTURE_LEDGER_ROW',hour,...b,
      epochId:b.epochId||'LEGACY_EXACT_OFFERED_V1',cohortId:b.cohortId??null,writerImplementationHash:b.writerImplementationHashScope==='EXACT_KEY_PARTITION'?(b.writerImplementationHash??null):null,
      writerImplementationHashScope:b.writerImplementationHashScope||'UNPARTITIONED_LEGACY_UNVERIFIED',
      legacyWriterImplementationHashHint:b.writerImplementationHashScope==='EXACT_KEY_PARTITION'?null:(b.writerImplementationHash??null),
      firstAttemptedAt:b.firstAttemptedAt??null,lastAttemptedAt:b.lastAttemptedAt??null,firstAcceptedAt:b.firstAcceptedAt??null,lastAcceptedAt:b.lastAcceptedAt??null,
      physicalCompressedBytesWritten:b.physicalCompressedBytesWritten??null,physicalCompressedGrowthBytes:b.physicalCompressedGrowthBytes??null,
      skipReasons:b.skipReasons??{UNAVAILABLE_LEGACY_EXACT_REASON_DETAIL:b.skippedRows},
      legacyUnavailableFields:b.epochId?(b.writerImplementationHashScope==='EXACT_KEY_PARTITION'?[]:['writerImplementationHash']):['timestamps','physicalCompressedBytesWritten','skipReasons','cohortId','writerImplementationHash'],
      reconciliationChecksum:digest(b)});}return out;}
  beginCohort(id,at){this.state.cohortId=id;this.state.cohortStartedAt=at;this.state.completedHours={priority:0,standard:0,measurement:0,fullResearch:0};
    this.state.lastEvaluatedHour=Math.floor(at/HOUR)*HOUR-HOUR;this.state.cleanHours=0;delete this.state.trailingActivatedAt;this.save();}
  measurement(now,available){const h=hourOf(now);this.state.measurementHours??={};const b=this.state.measurementHours[h]??={attempted:0,available:0,unavailable:0};b.attempted++;b[available?'available':'unavailable']++;}
  receiptPulse(now,complete,standardSourceComplete=true){
    const h=hourOf(now),b=this.state.receiptHours[h]||(this.state.receiptHours[h]={firstAt:now,lastAt:now,maxGapMs:0,complete:true});
    b.maxGapMs=Math.max(b.maxGapMs,now-b.lastAt);b.lastAt=now;b.complete=b.complete&&complete;
    b.standardSourceComplete=(b.standardSourceComplete??true)&&standardSourceComplete;
    const end=hourAt(h);let previous=this.state.lastEvaluatedHour===null?Math.floor(this.state.startedAt/HOUR)*HOUR:this.state.lastEvaluatedHour+HOUR;
    while(previous<end){
      const key=hourOf(previous),r=this.state.receiptHours[key],stats=Object.values(this.bucket(key));
      const skips=stats.filter(s=>s.priority==='PRIORITY').reduce((n,s)=>n+s.skippedRows,0);
      const full=previous>=this.state.startedAt&&r?.complete&&r.firstAt<=previous+120000&&r.lastAt>=previous+HOUR-120000&&r.maxGapMs<=120000&&skips===0;
      const standardSkips=stats.filter(s=>s.priority==='STANDARD').reduce((n,s)=>n+s.skippedRows,0);
      const cohortFull=previous>=(this.state.cohortStartedAt??this.state.startedAt),pulse=cohortFull&&r?.complete&&r.firstAt<=previous+120000&&r.lastAt>=previous+HOUR-120000&&r.maxGapMs<=120000;
      const sourceComplete=r?.standardSourceComplete!==false;
      const measurements=this.state.measurementHours?.[key],measurement=Boolean(pulse&&sourceComplete&&measurements?.attempted>0&&measurements.unavailable===0);
      const flags={priority:Boolean(pulse&&skips===0),standard:Boolean(pulse&&sourceComplete&&standardSkips===0),measurement,fullResearch:Boolean(measurement&&skips===0&&standardSkips===0),standardSourceComplete:sourceComplete};
      this.state.completedHours??={priority:0,standard:0,measurement:0,fullResearch:0};
      for(const k of ['priority','standard','measurement','fullResearch'])this.state.completedHours[k]=flags[k]?this.state.completedHours[k]+1:0;
      this.state.lastCompletedHour={hour:key,...flags};
      this.state.cleanHours=this.state.cohortId?this.state.completedHours.fullResearch:(full&&standardSkips===0?this.state.cleanHours+1:0);this.state.lastEvaluatedHour=previous;previous+=HOUR;
      if(this.state.cleanHours>=30&&!this.state.trailingActivatedAt)this.state.trailingActivatedAt=now;
    }
    for(const key of Object.keys(this.state.receiptHours))if(hourAt(key)<now-33*HOUR){delete this.state.receiptHours[key];delete this.state.measurementHours?.[key];}this.save();
  }
  error(row){
    const key=[row.errorCode,row.subsystem,row.symbol||'',row.tradeId||'',row.candidateId||'',JSON.stringify(row.retryCursor??null)].join('|'),e=this.state.errors[key]||{firstAt:row.capturedAt,count:0};
    this.state.errors[key]={...e,count:e.count+1,lastAt:row.capturedAt,errorCode:row.errorCode,subsystem:row.subsystem,
      symbol:row.symbol,candidateId:row.candidateId,episodeId:row.episodeId,tradeId:row.tradeId,
      retryCursor:row.retryCursor,completenessStatus:row.completenessStatus||'RETRY_PENDING',recoveredAt:null};
    // Full immutable error rows stay on disk; bounded recovery index is monitoring only.
    if(Object.keys(this.state.errors).length>256)delete this.state.errors[Object.keys(this.state.errors)[0]];this.save();
  }
  recovered(subsystem,symbol,at,scope={}){
    for(const e of Object.values(this.state.errors))if(e.subsystem===subsystem&&e.symbol===symbol&&!e.recoveredAt&&
      e.completenessStatus==='RETRY_PENDING'&&(e.tradeId??null)===(scope.tradeId??null)){
      const same=JSON.stringify(e.retryCursor??null)===JSON.stringify(scope.retryCursor??null);
      if(same&&!scope.censored){e.recoveredAt=at;e.completenessStatus='RECOVERED_AT_SAME_CURSOR';}
      else{e.resumedAt=at;e.completenessStatus=scope.censored?'CENSORED_AFTER_RETRY':'RESUMED_PRIOR_CURSOR_COVERAGE_UNVERIFIED';}
    }this.save();
  }
  status(now=Date.now()){
    const normalize=b=>b.writerImplementationHashScope==='EXACT_KEY_PARTITION'?b:{...b,writerImplementationHash:null,writerImplementationHashScope:'UNPARTITIONED_LEGACY_UNVERIFIED',legacyWriterImplementationHashHint:b.writerImplementationHash??null};
    const h=hourOf(now),current=Object.values(this.bucket(h)).map(normalize);
    const total=Object.values(this.state.totals).map(normalize),cohort=this.state.cohortId?total.filter(b=>b.cohortId===this.state.cohortId):[],sum=(bs,k)=>bs.reduce((n,b)=>n+(b[k]||0),0);
    return {...this.state,totals:total,currentHour:h,currentHourPartial:true,currentHourCounters:current,reconciliation:this.identity(),
      completedHours:this.state.completedHours||{priority:0,standard:0,measurement:0,fullResearch:0},
      analyticallyClean:Boolean(this.state.cohortId&&sum(cohort,'skippedRows')===0&&this.state.completedHours?.fullResearch>0),
      skipCounters:{historicalResidual:this.state.historicalResidual??null,historicalResidualStatus:'UNRESOLVED',ledgerEra:sum(total,'skippedRows'),
        currentHoldout:this.state.cohortId?sum(cohort,'skippedRows'):null,currentHoldoutStatus:this.state.cohortId?'ACTIVE_COHORT':'NO_ACTIVE_ANALYTICAL_COHORT',currentHour:sum(current,'skippedRows'),priority:sum(total.filter(b=>b.priority==='PRIORITY'),'skippedRows'),
        standard:sum(total.filter(b=>b.priority==='STANDARD'),'skippedRows'),recovered:0,permanent:sum(total,'skippedRows')},
      currentStandardSkips:sum(current.filter(b=>b.priority==='STANDARD'),'skippedRows'),
      currentPrioritySkips:current.filter(b=>b.priority==='PRIORITY').reduce((n,b)=>n+b.skippedRows,0),
      counterByteDefinition:'UTF8 bytes of complete offered JSON row including newline; compressed physical growth reported separately',
      historicalHourlyCounters:'capture-ledger/YYYY-MM-DD-HH.json (outside research quota)'};
  }
}
function classify(error){
  const code=error.reasonCode||error.code||error.message;
  if(error.name==='TimeoutError'||code==='TIMEOUT'||code==='ETIMEDOUT')return 'TIMEOUT';
  if(error.name==='AbortError'||code==='ABORT_ERR')return 'ABORTED';
  if(error.status===429||error.retCode===10006||code==='RATE_LIMIT_10006')return 'RATE_LIMIT';
  if(/TOO_LARGE|OVERSIZE/.test(code))return 'OVERSIZE';
  if(/UNAVAILABLE|COOLDOWN|ENOTFOUND|ECONNRESET|ECONNREFUSED/.test(code))return 'UNAVAILABLE';
  if(['ENOSPC','EACCES','EIO'].includes(code))return 'STORAGE_'+code;
  if(code==='V3_ARCHIVE_BUDGET_PAUSED')return code;
  if(/INVALID|PARSE|DUPLICATE/.test(code))return 'INVALID_DATA';
  return 'UNCLASSIFIED_CAPTURE_ERROR';
}
module.exports={CaptureLedger,priority,classify,atomic,CHANNELS,hourOf,hourAt,HOUR,POLICY,digest};
