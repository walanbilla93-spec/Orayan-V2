'use strict';
const fs=require('fs'),path=require('path');
const HOUR=3600000,CHANNELS=['v3','v2','ai','trades','paths','errors','arms'];
const hourOf=at=>new Date(at).toISOString().slice(0,13).replace('T','-');
const hourAt=h=>Date.parse(h.slice(0,10)+'T'+h.slice(11)+':00:00Z');
function atomic(file,value){const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value));fs.renameSync(tmp,file);}
function priority(entries){return entries.some(({channel,row})=>['paths','errors','arms'].includes(channel)||
  row.kind==='candidate_birth'||row.v3Decision==='ACCEPT_SHADOW'||
  (channel==='trades'&&!(row.transitions?.length===1&&row.transitions[0]==='MARK')))?'PRIORITY':'STANDARD';}
class CaptureLedger {
  constructor(dir){
    this.dir=path.join(dir,'capture-ledger');fs.mkdirSync(this.dir,{recursive:true});this.file=path.join(this.dir,'totals.json');
    this.state=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):
      {version:'EXACT_OFFERED_ROWS_BYTES_V1',startedAt:Date.now(),generation:0,totals:{},cursors:{},cleanHours:0,lastEvaluatedHour:null,receiptHours:{},errors:{}};
    this.hours=new Map();this.save();
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
  receiptPulse(now,complete){
    const h=hourOf(now),b=this.state.receiptHours[h]||(this.state.receiptHours[h]={firstAt:now,lastAt:now,maxGapMs:0,complete:true});
    b.maxGapMs=Math.max(b.maxGapMs,now-b.lastAt);b.lastAt=now;b.complete=b.complete&&complete;
    const end=hourAt(h);let previous=this.state.lastEvaluatedHour===null?Math.floor(this.state.startedAt/HOUR)*HOUR:this.state.lastEvaluatedHour+HOUR;
    while(previous<end){
      const key=hourOf(previous),r=this.state.receiptHours[key],stats=Object.values(this.bucket(key));
      const skips=stats.filter(s=>s.priority==='PRIORITY').reduce((n,s)=>n+s.skippedRows,0);
      const full=previous>=this.state.startedAt&&r?.complete&&r.firstAt<=previous+120000&&r.lastAt>=previous+HOUR-120000&&r.maxGapMs<=120000&&skips===0;
      this.state.cleanHours=full?this.state.cleanHours+1:0;this.state.lastEvaluatedHour=previous;previous+=HOUR;
      if(this.state.cleanHours>=30&&!this.state.trailingActivatedAt)this.state.trailingActivatedAt=now;
    }
    for(const key of Object.keys(this.state.receiptHours))if(hourAt(key)<now-33*HOUR)delete this.state.receiptHours[key];this.save();
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
    const h=hourOf(now),current=Object.values(this.bucket(h));
    return {...this.state,totals:Object.values(this.state.totals),currentHour:h,currentHourCounters:current,
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
module.exports={CaptureLedger,priority,classify,atomic,CHANNELS,hourOf,hourAt,HOUR};
