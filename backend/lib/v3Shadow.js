'use strict';

// One-way observer. This module cannot place orders and never returns a trade signal.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {validateClosedCandles,trendPermission}=require('./v3Contracts');
const levels=require('./v3Levels');
const corrected=require('./signals_trend_v30');
const location=require('./locationResearch');
const {redact}=require('../../research/alibaba-shadow/src/security');
const runtime=require('./runtimeIdentity');
const VERSION='ORAYAN_V3_TRANCHE1';
const BENCHMARK='d7f2ba802a4b4204fad70bf502c6f996f76aabc4';
const frozen=require('./v3Benchmark.json');
const MAX_KEYS=512,MAX_RECENT=24,MAX_ROW_BYTES=65536,RETENTION_MS=96*3600000;
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?
  Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex').slice(0,24);
const implementationHash=crypto.createHash('sha256').update(['v3Shadow.js','v3Contracts.js','v3Levels.js','signals_trend_v30.js']
  .map(file=>fs.readFileSync(path.join(__dirname,file),'utf8').replace(/\r\n/g,'\n')).join('\n')).digest('hex');
function plan(signal) {return signal?{candidateId:signal.id,side:signal.side,entry:signal.entry,sl:signal.sl,tp:signal.tp,
  score:signal.score,rr:signal.rr,passed:signal.gates?.passed??null,failed:signal.gates?.failed||[]}:null;}

function observeProviders(j,exporters=[['Groq',require('./groqShadowExport')],['Alibaba',require('./alibabaShadowExport')]]) {
  for(const [provider,exporter] of exporters) {
    try {
      // Use the public path contract, not either exporter's test-only inspect helper.
      const {root,candidate}=exporter.ledgerPath();
      if(!fs.existsSync(candidate)){j.observeAI(provider,null);continue;}
      const relative=path.relative(fs.realpathSync(root),fs.realpathSync(candidate));
      if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('AI_LEDGER_OUTSIDE_DATA_ROOT');
      j.observeAI(provider,candidate);
    }catch(_){j.counts.errors++;}
  }
}

function evaluate({symbol,candles,ticker,btcRegime,settings,decisionAt,v2Signals=[]}) {
  const intervalMs=Number(settings.timeframe)*60000;
  const inputError=validateClosedCandles(candles,intervalMs,decisionAt);
  const configHash=hash(settings),regime=btcRegime?.regime||'UNKNOWN';
  const base={version:VERSION,benchmarkCommit:BENCHMARK,configHash,
    benchmarkConfigMatch:configHash===hash(frozen.deployedSettings),symbol,decisionAt,
    executionAllowed:false,stage:'V3.0+V3.1_RESEARCH+V3.2_SCAFFOLD',
    v2Decision:v2Signals.map(plan),v3Decision:'REJECT',rejectReason:inputError||'GEOMETRY_STAGE_NOT_IMPLEMENTED',
    geometry:{status:'V3.3_DEFERRED',invalidationPrice:null,objectivePrice:null,rawRR:null,costAdjustedRR:null,
      costs:{makerFeePct:settings.makerFeePct??null,takerFeePct:settings.takerFeePct??null,
        stopSlippageBps:settings.slSlipBps??null,targetThroughBps:settings.tpThroughBps??null}},
    groqContext:{status:'UNAVAILABLE_AT_DECISION',provider:'Groq',model:null,outputAt:null,agreedWithV2:null,agreedWithV3:null},
    alibabaContext:{status:'UNAVAILABLE_AT_DECISION',provider:'Alibaba',model:null,outputAt:null,agreedWithV2:null,agreedWithV3:null},
    outcomeLabels:{status:'NOT_EVALUATED',evaluatedFromAt:null,availableAt:null}};
  if(inputError)return {...base,side:null,regime,directionPermission:false,research:null};
  const trend=corrected.detectTrend(candles),side=trend.trend==='UP'?'BUY':trend.trend==='DOWN'?'SELL':null;
  const permitted=trendPermission(regime,side),price=candles.at(-1).close;
  const research=levels.measure({candles,side,price,intervalMs,decisionAt});
  const loc=side?location.measure({candles,signal:{side,price,entry:price}}):null;
  // V3.0 is an isolated pivot-only ablation of the frozen EMA builder. It is never
  // mistaken for the future structural engine or routed to V2 gates/execution.
  const ablation=corrected.buildSignal({symbol,candles,ticker,btcRegime,settings});
  return {...base,side,regime,directionPermission:permitted,closedBarOpenAt:candles.at(-1).ts,
    closedBarAvailableAt:candles.at(-1).ts+intervalMs,referencePrice:price,
    tickerObservedAt:ticker?.observedAt??null,
    rejectReason:!side?'NO_TREND':!permitted?'V3.1_TREND_REGIME_NOT_PERMITTED':'GEOMETRY_STAGE_NOT_IMPLEMENTED',
    ablations:{v30PivotOnly:{ok:ablation.ok,reason:ablation.reason||null,plan:plan(ablation.signal)},
      v31RegimeOnly:{nativeV2TrendPresent:v2Signals.some(s=>s.engine==='TREND'),directionPermission:permitted,
        wouldRemoveBullRange:regime==='BULL_RANGE' && v2Signals.some(s=>s.engine==='TREND'&&s.side==='BUY')}},
    research,trendLegNumber:loc?.trendLegNumber??null,trendStage:{method:loc?.trendLegMethod??null,hardGate:false},
    structuralInvalidationReference:research.selected?.invalidationPrice??null};
}

class ShadowJournal {
  constructor(dir) {
    this.dir=dir;this.checkpoint=path.join(dir,'checkpoint.json');this.index=new Map();this.recent=[];
    this.counts={v2:0,v3:0,ai:0,errors:0};this.aiOffsets={};this.lastPrune=0;
    fs.mkdirSync(dir,{recursive:true});
    // Restore ONLY a capped checkpoint, never materialise the research archive at boot.
    if(fs.existsSync(this.checkpoint) && fs.statSync(this.checkpoint).size<1024*1024) {
      try {const saved=JSON.parse(fs.readFileSync(this.checkpoint,'utf8'));
        this.index=new Map((saved.index||[]).slice(-MAX_KEYS));this.counts={...this.counts,...saved.counts};
        this.aiOffsets=saved.aiOffsets||{};}catch(_){this.counts.errors++;}
    }
  }
  append(channel,row) {
    const line=JSON.stringify(redact({...runtime.rowFields(),implementationHash,...row}))+'\n';
    if(Buffer.byteLength(line)>MAX_ROW_BYTES)throw Error('V3_ROW_TOO_LARGE');
    const file=path.join(this.dir,`${channel}-${new Date(row.capturedAt).toISOString().slice(0,13).replace('T','-')}.jsonl`);
    // One complete immutable row at a time; no accumulated candle arrays or write queue.
    fs.appendFileSync(file,line);this.counts[channel]++;
  }
  record(row,scanId,scanStartedAt,capturedAt=Date.now()) {
    const key=[row.configHash,row.symbol,row.side||'WATCH'].join('|');
    const previous=this.index.get(key);
    const signature=hash([row.closedBarOpenAt,row.regime,row.rejectReason,
      row.v2Decision.map(p=>[p.side,p.passed,p.failed]),row.research?.selected?.id]);
    if(previous && previous.signature===signature && row.decisionAt-previous.lastSeenAt<=30*60000) {
      previous.lastSeenAt=row.decisionAt;return;
    }
    const continuing=previous && row.decisionAt>=previous.lastSeenAt && row.decisionAt-previous.lastSeenAt<=30*60000;
    const firstBirthAt=continuing?previous.firstBirthAt:row.decisionAt;
    const episodeId=continuing?previous.episodeId:hash([key,firstBirthAt]);
    const record={...row,outputType:'V3_SHADOW_SIGNAL',kind:continuing?'candidate_update':'candidate_birth',
      candidateId:hash([episodeId,row.decisionAt,signature]),episodeId,firstBirthAt,currentUpdateAt:row.decisionAt,
      episodeAgeMs:row.decisionAt-firstBirthAt,scanId,scanStartedAt,capturedAt,
      captureLagMs:capturedAt-row.decisionAt,signature};
    this.append('v3',record);
    this.append('v2',{version:VERSION,outputType:'V2_SIGNAL',benchmarkCommit:BENCHMARK,symbol:row.symbol,
      configHash:row.configHash,scanId,decisionAt:row.decisionAt,capturedAt,v3CandidateId:record.candidateId,
      decision:row.v2Decision.length?'CANDIDATE':'NO_NATIVE_CANDIDATE',plans:row.v2Decision});
    const currentLinks=row.v2Decision.map(p=>({candidateId:p.candidateId,passed:p.passed,decisionAt:row.decisionAt}));
    const birthLinks=continuing?(previous.birthLinks||[]):currentLinks;
    this.index.delete(key);this.index.set(key,{signature,firstBirthAt,episodeId,lastSeenAt:row.decisionAt,
      birthLinks,currentLinks,v3Decision:row.v3Decision});
    while(this.index.size>MAX_KEYS)this.index.delete(this.index.keys().next().value);
    this.recent.push({candidateId:record.candidateId,symbol:row.symbol,side:row.side,regime:row.regime,
      decisionAt:row.decisionAt,firstBirthAt,kind:record.kind,directionPermission:row.directionPermission,
      levelType:row.research?.selected?.type??null,reaction:row.research?.reaction?.state??null,
      premiumDiscount:row.research?.premiumDiscount?.classification??null,rejectReason:row.rejectReason});
    if(this.recent.length>MAX_RECENT)this.recent.shift();
  }
  checkpointAndPrune(now=Date.now()) {
    for(const [key,value] of this.index)if(now-value.lastSeenAt>3*3600000)this.index.delete(key);
    const tmp=this.checkpoint+'.tmp';
    fs.writeFileSync(tmp,JSON.stringify({index:[...this.index],counts:this.counts,aiOffsets:this.aiOffsets}));
    fs.renameSync(tmp,this.checkpoint);
    if(now-this.lastPrune<3600000)return;
    this.lastPrune=now;
    for(const name of fs.readdirSync(this.dir)) {
      const m=/^(v2|v3|ai)-(\d{4}-\d{2}-\d{2})-(\d{2})\.jsonl$/.exec(name);
      if(m && Date.parse(`${m[2]}T${m[3]}:00:00Z`)+3600000<now-RETENTION_MS)
        fs.unlinkSync(path.join(this.dir,name));
    }
  }
  files(channel='v3') {
    if(!['v2','v3','ai'].includes(channel))throw Object.assign(Error('Invalid V3 export channel'),{statusCode:400});
    return fs.readdirSync(this.dir).filter(n=>new RegExp(`^${channel}-\\d{4}-\\d{2}-\\d{2}-\\d{2}\\.jsonl$`).test(n)).sort()
      .map(n=>{const file=path.join(this.dir,n);return {path:file,size:fs.statSync(file).size};});
  }
  export(channel) {
    const files=this.files(channel),at=Date.now();
    // Existing server __files route pipelines with backpressure and a fixed byte watermark.
    return {__files:true,files,contentType:'application/x-ndjson',filename:`orayan_v3_${channel}_${at}.jsonl`,
      headers:{'X-Orayan-V3-Watermark-At':String(at),'X-Orayan-V2-Benchmark':BENCHMARK}};
  }
  status() {
    const files=this.files('v3');return {version:VERSION,enabled:process.env.ORAYAN_V3_SHADOW_ENABLED!=='false',
      benchmarkCommit:BENCHMARK,executionAllowed:false,stage:'TRANCHE_1_RESEARCH_ONLY',retentionHours:96,
      counts:this.counts,recent:this.recent,indexSize:this.index.size,available:files.length>0,
      sizeBytes:files.reduce((a,f)=>a+f.size,0),memoryLimits:{indexKeys:MAX_KEYS,recentRows:MAX_RECENT,rowBytes:MAX_ROW_BYTES}};
  }
  observeAI(provider,file,now=Date.now()) {
    if(!file || !fs.existsSync(file)){this.aiOffsets[provider]=0;return;}
    const size=fs.statSync(file).size;
    let offset=this.aiOffsets[provider]??size; // New experiment starts NOW, not at historical output.
    if(offset>size)offset=0;
    if(offset===size){this.aiOffsets[provider]=offset;return;}
    const fd=fs.openSync(file,'r'),buffer=Buffer.alloc(Math.min(size-offset,MAX_ROW_BYTES));
    let count;try{count=fs.readSync(fd,buffer,0,buffer.length,offset);}finally{fs.closeSync(fd);}
    const data=buffer.subarray(0,count),end=data.lastIndexOf(10);
    if(end<0){if(count===MAX_ROW_BYTES){this.aiOffsets[provider]=offset+count;this.counts.errors++;}return;}
    for(const line of data.subarray(0,end).toString('utf8').split('\n')) {
      if(!line)continue;
      try {
        const r=JSON.parse(line);if(r.record_type!=='SHADOW_DECISION')continue;
        const episode=[...this.index.values()].find(x=>[...(x.birthLinks||[]),...(x.currentLinks||[])].some(p=>p.candidateId===r.candidate_id));
        const link=episode?[...(episode.birthLinks||[]),...(episode.currentLinks||[])].find(p=>p.candidateId===r.candidate_id):null;
        const outputAt=Date.parse(r.available_to_system_at_utc||r.completed_at_utc||r.requested_at_utc);
        const verdict=r.decision?.decision;
        this.append('ai',{version:VERSION,outputType:'AI_RESEARCH_CONTEXT',provider,model:r.model||null,
          requestId:r.request_id,candidateId:r.candidate_id,episodeId:episode?.episodeId??null,
          outputAt:Number.isFinite(outputAt)?outputAt:null,capturedAt:now,status:r.status,
          output:r.decision||null,availableAfterDecision:true,
          agreedWithV2:link && link.passed!==null && ['RETAIN','SKIP'].includes(verdict)?(verdict==='RETAIN')===link.passed:null,
          agreedWithV3:null,agreementReason:'V3_EXECUTABLE_GEOMETRY_NOT_IMPLEMENTED',executionAuthority:false});
      }catch(_){this.counts.errors++;}
    }
    this.aiOffsets[provider]=offset+end+1;
  }
}
let instance;
function journal(){return instance||(instance=new ShadowJournal(path.join(require('./store').DATA_DIR,'v3-shadow')));}
function observeScan({scanAt,scanId,candlesBySymbol,tickerBySymbol,btcRegime,settings,signals,marketSnapshot}) {
  if(process.env.ORAYAN_V3_SHADOW_ENABLED==='false')return;
  const j=journal();
  const errorsBefore=j.counts.errors;
  for(const [symbol,candles] of candlesBySymbol) {
    try {
      const row=evaluate({symbol,candles,ticker:tickerBySymbol.get(symbol),btcRegime,settings,decisionAt:Date.now(),
        v2Signals:signals.filter(s=>s.symbol===symbol && !s.signalSource?.startsWith('MARCI'))});
      row.btcContext={regime:btcRegime?.regime??null,strength:btcRegime?.strength??null,
        return1:marketSnapshot?.btcReturn1??null,return3:marketSnapshot?.btcReturn3??null};
      row.breadth={value:marketSnapshot?.directionalBreadth??null,momentum:marketSnapshot?.breadthMomentum??null,
        marketSnapshotId:marketSnapshot?.marketSnapshotId??null,availableAt:marketSnapshot?.observedAt??null};
      j.record(row,scanId,scanAt);
    }catch(_){j.counts.errors++;}
  }
  observeProviders(j);
  j.lastScanErrors=j.counts.errors-errorsBefore;
  j.checkpointAndPrune();
}
module.exports={VERSION,BENCHMARK,evaluate,ShadowJournal,observeProviders,observeScan,status:()=>({...journal().status(),lastScanErrors:journal().lastScanErrors??null}),
  download:channel=>journal().export(channel||'v3')};
