'use strict';
const minimal=require('./minimalCapture');


// One-way observer. This module cannot place orders and never returns a trade signal.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {validateClosedCandles,trendPermission}=require('./v3Contracts');
const levels=require('./v3Levels');
const geometry=require('./v3Geometry');
const trades=require('./v3Trades');
const m34=require('./v34Measurements'),t34=require('./v34Trades'),control34=require('./v34Control');
const r35=require('./v34bResearch'),{Holdout}=require('./v34bHoldout'),{classify,CHANNELS}=require('./v34bCapture');
const {MeasurementCache}=require('./v34Cache');
const minuteCache=new MeasurementCache();
const {Archive,ROW_BYTES,TRADE_ROW_BYTES}=require('./v3Archive');
const corrected=require('./signals_trend_v30');
const location=require('./locationResearch');
const {redact}=require('../../research/alibaba-shadow/src/security');
const runtime=require('./runtimeIdentity');
const VERSION='ORAYAN_V3_TRANCHE2';
const BENCHMARK='d7f2ba802a4b4204fad70bf502c6f996f76aabc4';
const frozen=require('./v3Benchmark.json');
const MAX_KEYS=512,MAX_RECENT=24,MAX_ROW_BYTES=65536;
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?
  Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex').slice(0,24);
const implementationHash=crypto.createHash('sha256').update(['v3Shadow.js','v3Contracts.js','v3Levels.js','v3Geometry.js','v3Trades.js','v3Compact.js','v3Archive.js','signals_trend_v30.js','v34Measurements.js','v34Trades.js','v34Cache.js','v34Control.js','v34bResearch.js','v34bCapture.js','v34bCodec.js','v34bHoldout.js','minimalCapture.js','captureProxy.js','captureWorker.js','startupCaptureReset.js']
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
    }catch(e){j.captureError(e,{subsystem:'AI_LEDGER',affectedRecordType:'AI_RESEARCH_CONTEXT',retry:'NEXT_SCAN'});}
  }
}

function evaluate({symbol,candles,ticker,instrument,btcRegime,settings,decisionAt,v2Signals=[]}) {
  const intervalMs=Number(settings.timeframe)*60000;
  const inputError=validateClosedCandles(candles,intervalMs,decisionAt);
  const configHash=hash(settings),regime=btcRegime?.regime||'UNKNOWN';
  const base={version:VERSION,benchmarkCommit:BENCHMARK,configHash,
    benchmarkConfigMatch:configHash===hash(frozen.deployedSettings),symbol,decisionAt,
    executionAllowed:false,testnet:settings.testnet!==false,stage:'V3.3_GEOMETRY_AND_SHADOW_OUTCOMES',
    v2Decision:v2Signals.map(plan),v3Decision:'REJECT',rejectReason:inputError||'GEOMETRY_STAGE_NOT_IMPLEMENTED',
    geometry:{status:'INPUT_REJECTED',policy:geometry.POLICY,invalidationPrice:null,objectivePrice:null,rawRR:null,costAdjustedRR:null,
      costs:{makerFeePct:settings.makerFeePct??null,takerFeePct:settings.takerFeePct??null,
        stopSlippageBps:settings.slSlipBps??null,targetThroughBps:settings.tpThroughBps??null}},
    groqContext:{status:'UNAVAILABLE_AT_DECISION',provider:'Groq',model:null,outputAt:null,agreedWithV2:null,agreedWithV3:null},
    alibabaContext:{status:'UNAVAILABLE_AT_DECISION',provider:'Alibaba',model:null,outputAt:null,agreedWithV2:null,agreedWithV3:null},
    outcomeLabels:{status:'NOT_EVALUATED',evaluatedFromAt:null,availableAt:null}};
  if(inputError)return {...base,side:null,regime,directionPermission:false,research:null};
  const trend=corrected.detectTrend(candles),side=trend.trend==='UP'?'BUY':trend.trend==='DOWN'?'SELL':null;
  const permitted=trendPermission(regime,side),price=candles.at(-1).close;
  const research=levels.measure({candles,side,price,intervalMs,decisionAt});
  const g=side&&permitted?geometry.build({research,side,ticker,instrument,settings,decisionAt,
    closedBarOpenAt:candles.at(-1).ts,reactionLow:candles.at(-1).low,reactionHigh:candles.at(-1).high}):{status:'NOT_ELIGIBLE',policy:geometry.POLICY,
      reason:!side?'NO_TREND':'V3.1_TREND_REGIME_NOT_PERMITTED',invalidationPrice:null,objectivePrice:null,rawRR:null,costAdjustedRR:null};
  if(g.reactionLevel){research.selected=g.reactionLevel;research.reaction=g.reactionLevel.reaction;}
  research.distanceReferencePrice=price;research.candidatePrice=g.entryPrice??price;
  const pd=research.premiumDiscount;
  if(g.entryPrice && pd.rangeKnownAt!==null) {
    research.referencePremiumDiscount=pd;
    research.premiumDiscount=levels.premiumDiscount({high:pd.rangeHigh,low:pd.rangeLow,knownAt:pd.rangeKnownAt,
      highAnchorAt:pd.highAnchorAt,lowAnchorAt:pd.lowAnchorAt},g.entryPrice,side,decisionAt);
  }
  const loc=side?location.measure({candles,signal:{side,price,entry:price}}):null;
  // V3.0 is an isolated pivot-only ablation of the frozen EMA builder. It is never
  // mistaken for the future structural engine or routed to V2 gates/execution.
  const ablation=corrected.buildSignal({symbol,candles,ticker,btcRegime,settings});
  return {...base,side,regime,directionPermission:permitted,closedBarOpenAt:candles.at(-1).ts,
    closedBarAvailableAt:candles.at(-1).ts+intervalMs,referencePrice:price,
    tickerObservedAt:ticker?.observedAt??null,
    geometry:g,v3Decision:g.status==='ACCEPTED'?'ACCEPT_SHADOW':'REJECT',rejectReason:g.reason,
    outcomeLabels:{status:g.status==='ACCEPTED'?'SEPARATE_SHADOW_TRADE_LIFECYCLE':'NOT_APPLICABLE_REJECTED',
      evaluatedFromAt:null,availableAt:null,channel:'trades'},
    ablations:{v30PivotOnly:{ok:ablation.ok,reason:ablation.reason||null,plan:plan(ablation.signal)},
      v31RegimeOnly:{nativeV2TrendPresent:v2Signals.some(s=>s.engine==='TREND'),directionPermission:permitted,
        wouldRemoveBullRange:regime==='BULL_RANGE' && v2Signals.some(s=>s.engine==='TREND'&&s.side==='BUY')}},
    research,trendLegNumber:loc?.trendLegNumber??null,trendStage:{method:loc?.trendLegMethod??null,hardGate:false},
    structuralInvalidationReference:research.selected?.invalidationPrice??null};
}

class ShadowJournal {
  constructor(dir,{legacyDir=null}={}) {
    this.dir=dir;this.checkpoint=path.join(dir,'checkpoint.json');this.index=new Map();this.recent=[];
    this.counts={v2:0,v3:0,ai:0,trades:0,errors:0};this.aiOffsets={};this.lastPrune=0;
    this.errorRecent=[];this.errorClasses={};this.episodes={births:0,admitted:0};this.measurementCounts={decisions:0,noiseAvailable:0,quoteAvailable:0};
    this.observers=new Map();
    this.measurementStartedAt=Date.now();this.measurementTradeCounts={admitted:0,filled:0,closed:0,uniqueFilledEpisodes:0};
    this.filledEpisodes=new Map();
    this.activeTrades=new Map();this.armWorkers=new Map();this.recentTrades=[];this.tradeCounts={admitted:0,filled:0,closed:0,cancelled:0,expired:0,incomplete:0};
    this.tradePollAt=0;this.tradeWorkerBusy=false;this.lastTradeError=null;
    fs.mkdirSync(dir,{recursive:true});
    this.archive=new Archive(dir);this.holdout=new Holdout(dir);this.startedAt=Date.now();this.captureCohort='compact-v1-'+this.startedAt;
    this.archive.snapshotMetadata=()=>({control:control34,holdout:this.holdout.status(),captureCohort:this.captureCohort,implementationHash});
    this.legacySizeBytes=legacyDir && fs.existsSync(legacyDir)?fs.readdirSync(legacyDir)
      .filter(n=>/^(v2|v3|ai|trades)-\d{4}-\d{2}-\d{2}-\d{2}\.jsonl$/.test(n))
      .reduce((sum,n)=>sum+fs.statSync(path.join(legacyDir,n)).size,0):0;
    if(!fs.existsSync(this.checkpoint) && legacyDir) {
      const old=path.join(legacyDir,'checkpoint.json');
      if(fs.existsSync(old)&&fs.statSync(old).size<1024*1024) {
        try {const saved=JSON.parse(fs.readFileSync(old,'utf8'));
        this.activeTrades=new Map((saved.activeTrades||[]).slice(-trades.MAX_ACTIVE)
          .map(([id,t])=>[id,{...t,originCaptureCohort:'LEGACY_PRE_COMPACT'}]));
        this.aiOffsets=saved.aiOffsets||{};
        }catch(_){this.counts.errors++;this.lastTradeError='LEGACY_CHECKPOINT_UNREADABLE';}
      }
    }
    // Restore ONLY a capped checkpoint, never materialise the research archive at boot.
    if(fs.existsSync(this.checkpoint) && fs.statSync(this.checkpoint).size<8*1024*1024) {
      try {const saved=JSON.parse(fs.readFileSync(this.checkpoint,'utf8'));
        this.index=new Map((saved.index||[]).slice(-MAX_KEYS));this.counts={...this.counts,...saved.counts};
        this.aiOffsets=saved.aiOffsets||{};}catch(_){this.counts.errors++;}
      try {const saved=JSON.parse(fs.readFileSync(this.checkpoint,'utf8'));
        this.activeTrades=new Map((saved.activeTrades||[]).slice(-trades.MAX_ACTIVE));
        this.armWorkers=new Map(saved.armWorkers||[]);
        this.recentTrades=(saved.recentTrades||[]).slice(-trades.MAX_RECENT);this.tradeCounts={...this.tradeCounts,...saved.tradeCounts};
        this.startedAt=saved.startedAt??this.startedAt;this.captureCohort=saved.captureCohort??this.captureCohort;
        this.archive.restore(saved.archive);
        this.errorRecent=(saved.errorRecent||[]).slice(-16);this.errorClasses=saved.errorClasses||{};
        this.episodes=saved.episodes||this.episodes;this.measurementCounts=saved.measurementCounts||this.measurementCounts;
        this.measurementStartedAt=saved.measurementStartedAt??this.measurementStartedAt;
        this.measurementTradeCounts=saved.measurementTradeCounts||this.measurementTradeCounts;
        this.filledEpisodes=new Map((saved.filledEpisodes||[]).slice(-512));
      }catch(_){this.counts.errors++;}
    }
    if(minimal.enabled()&&!this.holdout.state.startedAt){
      const c=minimal.current();Object.assign(this.holdout.state,{startedAt:c.state.startedAt,cohortId:c.state.epochId,definitions:r35.DEFINITIONS,control:control34,awaitingLiveQualification:false,analyticalStatus:'MINIMAL_CANDIDATE_POPULATION'});this.holdout.save();this.startedAt=c.state.startedAt;this.captureCohort=c.state.epochId;
    }
    this.saveCheckpoint();
  }
  append(channel,row) {
    this.appendBatch([{channel,row}]);
  }
  appendBatch(entries) {
    try{this.archive.write(entries.map(({channel,row})=>({channel,
      row:redact({...runtime.rowFields(),implementationHash,captureCohort:this.captureCohort,holdoutCohort:row.trade?.holdoutCohort??this.holdout.state.cohortId??null,...row})})));}
    catch(e){e.affectedRecords=entries.slice(0,8).map(({channel,row})=>({channel,recordType:row.outputType,
      candidateId:row.candidateId??row.v3CandidateId??null,episodeId:row.episodeId??row.trade?.episodeId??null,
      tradeId:row.tradeId??row.trade?.tradeId??null,decisionAt:row.decisionAt??null,capturedAt:row.capturedAt}));throw e;}
    for(const {channel} of entries){const key=channel==='errors'?'errorRecords':channel;this.counts[key]=(this.counts[key]||0)+1;}
  }
  captureError(error,context={}) {
    const allowed=['V3_ARCHIVE_BUDGET_PAUSED','COMPACT_ROW_TOO_LARGE','SHADOW_CHECKPOINT_CAPACITY','INVALID_PATH_RESPONSE',
      'FUNDING_COVERAGE_UNAVAILABLE','INVALID_FUNDING_RESPONSE','DUPLICATE_FUNDING_RESPONSE','AI_LEDGER_OUTSIDE_DATA_ROOT',
      'RESEARCH_QUEUE_CAPACITY','RATE_LIMIT_10006','COOLDOWN_ACTIVE','PARSE_ERROR','TIMEOUT','HTTP_ERROR','ENOSPC','EACCES',
      'AI_JSON_INVALID','AI_ROW_TOO_LARGE','MEASUREMENT_FAILED','CHECKPOINT_UNREADABLE'];
    const proposed=error.reasonCode||error.code||error.message;
    const code=classify(error);
    // Never export raw exception messages, request URLs, headers or provider responses.
    const row=redact({outputType:'V3_CAPTURE_ERROR',capturedAt:Date.now(),timestamp:Date.now(),
      symbol:context.symbol??null,candidateId:context.candidateId??null,episodeId:context.episodeId??null,
      subsystem:context.subsystem||'SHADOW_CAPTURE',errorCode:code,messageClass:['Error','TypeError','RangeError','SyntaxError','AbortError'].includes(error.name)?error.name:'Error',
      tradeId:context.tradeId??null,retryCursor:context.retryCursor??error.affectedRecords?.[0]?.candidateId??null,
      affectedRecords:error.affectedRecords??[],
      firstAt:Date.now(),lastAt:Date.now(),recoveredAt:null,completenessStatus:error.permanentLoss||code==='V3_ARCHIVE_BUDGET_PAUSED'?'SKIPPED_PERMANENT':'RETRY_PENDING',
      httpStatus:Number.isInteger(error.status)?error.status:null,providerCode:Number.isInteger(error.retCode)?error.retCode:null,
      retry:context.retry||'NEXT_SCAN',skip:context.skip??false,affectedRecordType:context.affectedRecordType||'UNKNOWN',
      archiveWriteSkipped:Boolean(error.permanentLoss),downstreamDecisionSkipped:context.skip??false,permanentLoss:Boolean(error.permanentLoss),
      completenessImpacted:true,eventId:hash([Date.now(),code,context.symbol])});
    this.counts.errors++;this.errorClasses[code]=(this.errorClasses[code]||0)+1;
    this.errorRecent.push(row);if(this.errorRecent.length>16)this.errorRecent.shift();
    this.archive.ledger.error(row);
    try{this.append('errors',row);}catch(_){/* checkpoint keeps bounded fallback under disk/budget failure */}
  }
  record(row,scanId,scanStartedAt,capturedAt=Date.now()) {
    this.archive.ledger.measurement(capturedAt,Boolean(row.measurement34?.noise?.usableAtDecision&&row.measurement34?.quote?.status==='AVAILABLE'));
    try{this.receipts(row,capturedAt);}catch(e){this.receiptCoverageFailed=true;throw e;}
    const key=[row.configHash,row.symbol,row.side||'WATCH'].join('|');
    const previous=this.index.get(key);
    if(row.measurement34&&previous)for(const provider of ['Groq','Alibaba']){
      const observer=this.observers.get(provider+':'+previous.episodeId);
      if(observer)row.measurement34.observers[provider]=m34.observer(observer.row,provider,observer.capturedAt,row.decisionAt);
    }
    const setupId=hash([VERSION,row.configHash,row.symbol,row.side,row.closedBarOpenAt,row.geometry?.reactionLevel?.id]);
    if(row.v3Decision==='ACCEPT_SHADOW') {
      const duplicate=previous?.lastAdmittedSetup===setupId || [...this.activeTrades.values(),...this.recentTrades].some(t=>t.tradeId===setupId);
      if(duplicate)row={...row,v3Decision:'REJECT',rejectReason:'SHADOW_SETUP_ALREADY_TRACKED',
        outcomeLabels:{status:'NO_NEW_TRADE_EXISTING_SETUP',shadowTradeId:setupId,channel:'trades'}};
      else if(this.activeTrades.size>=trades.MAX_ACTIVE)row={...row,v3Decision:'REJECT',rejectReason:'SHADOW_CAPACITY_LIMIT',
        outcomeLabels:{status:'NOT_EVALUATED_CAPACITY_LIMIT',shadowTradeId:null,channel:'trades'}};
      else row={...row,outcomeLabels:{status:'SEPARATE_SHADOW_TRADE_LIFECYCLE',shadowTradeId:setupId,channel:'trades'}};
    }
    const signature=hash([row.closedBarOpenAt,row.regime,row.rejectReason,
      row.v2Decision.map(p=>[p.side,p.passed,p.failed]),row.research?.selected?.id,VERSION,
      row.v3Decision,row.geometry?.status,row.geometry?.invalidationPrice,row.geometry?.objectivePrice]);
    if(previous && previous.signature===signature && row.decisionAt-previous.lastSeenAt<=30*60000) {
      // Frozen control dedupe stays intact. Exact observer exposures are captured
      // separately instead of silently losing the repeated decision surface.
      this.appendBatch([{channel:'v3',row:{...row,outputType:'V3_SURFACE_EXPOSURE',kind:'repeated_surface',episodeId:previous.episodeId,
        candidateId:hash([previous.episodeId,row.decisionAt]),scanId,capturedAt,exposureCount:1}},
        {channel:'v2',row:{outputType:'V2_SIGNAL',symbol:row.symbol,decisionAt:row.decisionAt,capturedAt,
          v3CandidateId:hash([previous.episodeId,row.decisionAt]),plans:row.v2Decision,kind:'matched_repeated_surface'}}]);
      previous.lastSeenAt=row.decisionAt;return;
    }
    const continuing=previous && row.decisionAt>=previous.lastSeenAt && row.decisionAt-previous.lastSeenAt<=30*60000;
    const firstBirthAt=continuing?previous.firstBirthAt:row.decisionAt;
    const episodeId=continuing?previous.episodeId:hash([key,firstBirthAt]);
    const record={...row,outputType:'V3_SHADOW_SIGNAL',kind:continuing?'candidate_update':'candidate_birth',
      candidateId:hash([episodeId,row.decisionAt,signature]),episodeId,firstBirthAt,currentUpdateAt:row.decisionAt,
      episodeAgeMs:row.decisionAt-firstBirthAt,scanId,scanStartedAt,capturedAt,
      captureLagMs:capturedAt-row.decisionAt,signature};
    record.control={...control34,configHash:row.configHash,benchmarkConfigMatch:row.benchmarkConfigMatch};
    record.episodeAdmissionOrdinal=(continuing?previous.admissions||0:0)+(row.v3Decision==='ACCEPT_SHADOW'?1:0);
    if(record.measurement34) {
      for(const provider of ['Groq','Alibaba']) {
        const observer=this.observers.get(provider+':'+episodeId);
        if(observer)record.measurement34.observers[provider]=m34.observer(observer.row,provider,observer.capturedAt,row.decisionAt);
      }
    }
    const writes=[{channel:'v3',row:record},{channel:'v2',row:{version:VERSION,outputType:'V2_SIGNAL',benchmarkCommit:BENCHMARK,symbol:row.symbol,
      configHash:row.configHash,scanId,decisionAt:row.decisionAt,capturedAt,v3CandidateId:record.candidateId,
      decision:row.v2Decision.length?'CANDIDATE':'NO_NATIVE_CANDIDATE',plans:row.v2Decision}}];
    let trade;
    let prospective;
    if(this.holdout.state.startedAt&&row.rejectReason==='COST_ADJUSTED_RR_TOO_LOW'&&row.directionPermission&&previous?.lastReplacementSetup!==setupId){
      prospective={...trades.create(record,setupId+'-ATR15',capturedAt),originCaptureCohort:this.captureCohort,holdoutCohort:this.holdout.state.cohortId,
        regime:row.regime,controlGeometryRejected:true,status:'CANCELLED',outcome:'CONTROL_DECISION_GEOMETRY_REJECTED',netPnl:0,outcomeComplete:true};
      const all=r35.admit(prospective,record.measurement34,this.holdout.episode(episodeId));
      prospective.research35={...all,arms:{ATR1M_1P5_REPLACEMENT:all.arms.ATR1M_1P5_REPLACEMENT}};
      writes.push({channel:'arms',row:{outputType:'V34B_REPLACEMENT_FULL_GEOMETRY_OPPORTUNITY',capturedAt,episodeId,tradeId:prospective.tradeId,
        arm:prospective.research35,researchOnly:true,executionAllowed:false}});
    }
    if(row.v3Decision==='ACCEPT_SHADOW') {
      trade={...trades.create(record,setupId,capturedAt),originCaptureCohort:this.captureCohort};
      trade.controlFingerprint=control34.fingerprint;trade.episodeAdmissionOrdinal=record.episodeAdmissionOrdinal;
      if(record.measurement34)trade.research34=t34.init(trade,record.measurement34);
      // This state is consumed only by the research worker, never by control.
      if(this.holdout.state.startedAt){
        trade.holdoutCohort=this.holdout.state.cohortId;trade.regime=row.regime;
        trade.research35=r35.admit(trade,record.measurement34,this.holdout.episode(episodeId),Boolean(this.archive.ledger.state.trailingActivatedAt));
        writes.push({channel:'arms',row:{outputType:'V34B_PAIRED_ADMISSION',capturedAt,episodeId,tradeId:trade.tradeId,researchOnly:true,executionAllowed:false,arm:trade.research35}});
      }
      writes.push({channel:'trades',row:this.tradeRow(trade,['ADMITTED'],capturedAt)});
    }
    this.appendBatch(writes);
    if(prospective){this.holdout.admission(prospective,row.regime);if(r35.active(prospective.research35))this.armWorkers.set(prospective.tradeId,prospective);this.saveCheckpoint();}
    if(trade?.research35)this.holdout.admission(trade,row.regime);
    // Post-fill levels are observations only; their prices never become executable stops.
    if(!continuing)this.episodes.births++;
    if(trade&&record.episodeAdmissionOrdinal===1)this.episodes.admitted++;
    if(record.measurement34){this.measurementCounts.decisions++;if(record.measurement34.noise.returns20)this.measurementCounts.noiseAvailable++;
      if(record.measurement34.quote.status==='AVAILABLE')this.measurementCounts.quoteAvailable++;}
    if(trade) {
      this.activeTrades.set(setupId,trade);this.tradeCounts.admitted++;
      if(trade.research34)this.measurementTradeCounts.admitted++;
      this.saveCheckpoint(); // Persist admissions before any asynchronous path reads.
    }
    const currentLinks=row.v2Decision.map(p=>({candidateId:p.candidateId,passed:p.passed,decisionAt:row.decisionAt,
      v3Decision:row.geometry?.status==='ACCEPTED'?'ACCEPT_SHADOW':row.v3Decision}));
    const birthLinks=continuing?(previous.birthLinks||[]):currentLinks;
    this.index.delete(key);this.index.set(key,{signature,firstBirthAt,episodeId,lastSeenAt:row.decisionAt,
      birthLinks,currentLinks,v3Decision:row.v3Decision,
      admissions:record.episodeAdmissionOrdinal,
      lastAdmittedSetup:row.v3Decision==='ACCEPT_SHADOW'?setupId:previous?.lastAdmittedSetup??null});
    this.index.get(key).lastReplacementSetup=prospective?setupId:previous?.lastReplacementSetup??null;
    while(this.index.size>MAX_KEYS)this.index.delete(this.index.keys().next().value);
    this.recent.push({candidateId:record.candidateId,symbol:row.symbol,side:row.side,regime:row.regime,
      decisionAt:row.decisionAt,firstBirthAt,kind:record.kind,directionPermission:row.directionPermission,
      levelType:row.research?.selected?.type??null,reaction:row.research?.reaction?.state??null,
      premiumDiscount:row.research?.premiumDiscount?.classification??null,rejectReason:row.rejectReason,
      v3Decision:row.v3Decision,costAdjustedRR:row.geometry?.costAdjustedRR??null});
    if(this.recent.length>MAX_RECENT)this.recent.shift();
  }
  receipts(row,capturedAt) {
    for(const t of [...this.activeTrades.values(),...this.armWorkers.values()])if(t.symbol===row.symbol&&t.filledAt&&t.research34&&
      (t.status==='OPEN'||r35.active(t.research35))){
      const from=t.research34.defendedCursorAt??t.filledAt;
      const fresh=(row.research?.levels||[]).filter(l=>l.active&&l.direction===t.side&&l.knownAt>from&&l.knownAt<=row.closedBarOpenAt);
      const levels=fresh.map(l=>({id:l.id,type:l.type,price:l.price,zoneLow:l.zoneLow,zoneHigh:l.zoneHigh,
        invalidationPrice:l.invalidationPrice,knownAt:l.knownAt,receivedAt:capturedAt}));
      // A complete empty receipt proves inspection rather than missing coverage.
      this.append('paths',{outputType:'V3_DEFENDED_LEVEL_RECEIPT',capturedAt,tradeId:t.tradeId,episodeId:t.episodeId,
        eventId:hash([t.tradeId,row.decisionAt,levels.map(l=>l.id)]),levels,coverageComplete:true,researchOnly:true,executionAllowed:false});
      r35.receive(t.research35,levels,t.filledAt);
      if(levels.length){t.research34.defendedLevels=[...(t.research34.defendedLevels||[]),...levels].slice(-8);
        t.research34.defendedCursorAt=Math.max(...fresh.map(l=>l.knownAt));}
    }
  }
  cohort(){if(this.exportBuilding)return this.exportBuilding;
    this.exportBuilding=this.buildCohort().finally(()=>{this.exportBuilding=null;});return this.exportBuilding;}
  async buildCohort(){const status=JSON.parse(JSON.stringify(this.status())),retainedLogicalRows=JSON.parse(JSON.stringify(this.archive.summaryHours)),holdoutCohort=this.holdout.state.cohortId;
    const s=await this.archive.cohort(),{channels,tombstones,...manifest}=s;
    status.retainedExport=s.retained;status.captureLedger=s.captureLedger;
    status.exportGeneration=s.generation;status.watermarkAt=s.watermarkAt;status.ledgerChecksum=s.ledgerChecksum;s.status=status;
    for(const [channel,v] of Object.entries(channels)){
      const target=path.join(this.dir,`export-${s.generation}-${channel}-manifest.gz`),bytes=require('zlib').gzipSync(JSON.stringify({outputType:'SHARED_EXPORT_MANIFEST',
        ...manifest,channel,captureCohort:this.captureCohort,holdoutCohort,control:control34})+'\n');
      fs.writeFileSync(target,bytes);v.files.unshift({path:target,size:bytes.length});const oldCleanup=v.cleanup;
      v.cleanup=()=>{oldCleanup();if(fs.existsSync(target))fs.unlinkSync(target);};
    }
    return {...manifest,captureCohort:this.captureCohort,holdoutCohort,
      control:control34,status,retainedLogicalRows,
      channelFiles:Object.fromEntries(Object.entries(channels).map(([k,v])=>[k,v.files.map(f=>({size:f.size}))]))};}
  dailyExport(day){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(day||''))throw Object.assign(Error('INVALID_SNAPSHOT_DAY'),{statusCode:400});
    const snapshot=this.archive.dailyList().find(d=>d.day===day);if(!snapshot)throw Object.assign(Error('SNAPSHOT_NOT_FOUND'),{statusCode:404});
    const dir=path.join(this.dir,'daily-snapshots',day),manifest=path.join(dir,'download-manifest.jsonl.gz');
    if(!fs.existsSync(manifest))fs.writeFileSync(manifest,require('zlib').gzipSync(JSON.stringify({outputType:'DAILY_SNAPSHOT_MANIFEST',...snapshot,control:control34})+'\n'));
    return {__files:true,files:[{path:manifest,size:fs.statSync(manifest).size},...snapshot.files.map(f=>({path:path.join(dir,f.name),size:f.size}))],
      contentType:'application/gzip',filename:`orayan-v34b-immutable-${day}.jsonl.gz`,cleanup:()=>{}};
  }
  checkpointAndPrune(now=Date.now()) {
    for(const [key,value] of this.index)if(now-value.lastSeenAt>3*3600000)this.index.delete(key);
    const text=JSON.stringify({index:[...this.index].map(([key,x])=>[key,{signature:x.signature,episodeId:x.episodeId,lastAdmittedSetup:x.lastAdmittedSetup,lastReplacementSetup:x.lastReplacementSetup}]),activeTrades:[...this.activeTrades],armWorkers:[...this.armWorkers],tradeCounts:this.tradeCounts});
    if(!minimal.enabled()||minimal.digest(text)!==this.lastWorkingDigest){this.saveCheckpoint();this.lastWorkingDigest=minimal.digest(text);}
    if(!minimal.enabled())this.archive.prune(now);
  }
  files(channel='v3') {
    if(!CHANNELS.includes(channel))throw Object.assign(Error('Invalid V3 export channel'),{statusCode:400});
    return this.archive.list(channel).map(f=>({path:f.path,size:f.size}));
  }
  export(channel,generation) {
    if(['ledger','tombstones'].includes(channel)){
      if(!generation)return this.cohort().then(s=>this.export(channel,s.generation));
      const s=this.archive.sessions.get(generation);if(!s||s.expiresAt<Date.now())throw Object.assign(Error('EXPORT_GENERATION_EXPIRED'),{statusCode:410});
      const rows=channel==='ledger'?s.captureLedger:s.tombstones;
      const target=path.join(this.dir,`export-${s.generation}-${channel}-manifest.gz`),bytes=require('zlib').gzipSync([JSON.stringify({outputType:'SHARED_EXPORT_MANIFEST',generation:s.generation,watermarkAt:s.watermarkAt,
        sequence:s.sequence,reconciliation:s.reconciliation,ledgerChecksum:s.ledgerChecksum}),...rows.map(r=>JSON.stringify(r))].join('\n')+'\n');
      fs.writeFileSync(target,bytes);s.extraExports??=new Set();s.extraExports.add(target);return {__files:true,files:[{path:target,size:bytes.length}],contentType:'application/gzip',filename:`orayan_v3_${channel}_${s.watermarkAt}.jsonl.gz`,cleanup:()=>{},
        headers:{'X-Orayan-V3-Watermark-At':String(s.watermarkAt),'X-Orayan-Export-Generation':s.generation}};
    }
    this.files(channel);
    const cohort=generation?this.archive.sessions.get(generation):null;
    if(generation&&(!cohort||cohort.expiresAt<Date.now()))throw Object.assign(Error('EXPORT_GENERATION_EXPIRED'),{statusCode:410});
    const snapshot=cohort?{files:cohort.channels[channel].files,cleanup:()=>{}}:this.archive.snapshot(channel),at=cohort?.watermarkAt??Date.now();
    // Existing server __files route pipelines with backpressure and a fixed byte watermark.
    return {__files:true,...snapshot,contentType:'application/gzip',filename:`orayan_v3_${channel}_${at}.jsonl.gz`,
      headers:{'X-Orayan-V3-Watermark-At':String(at),'X-Orayan-Export-Generation':generation||'SINGLE_CHANNEL','X-Orayan-V2-Benchmark':BENCHMARK}};
  }
  status() {
    const files=this.files('v3');return {version:VERSION,enabled:process.env.ORAYAN_V3_SHADOW_ENABLED!=='false',
      benchmarkCommit:BENCHMARK,executionAllowed:false,implementationHash,stage:'V3.3_SHADOW_OUTCOMES',retentionHours:30,
      startedAt:this.startedAt,captureCohort:this.captureCohort,legacySizeBytes:this.legacySizeBytes,archive:this.archive.status(),
      holdout:this.holdout.status(),researchDefinitions:r35.DEFINITIONS,dailySnapshots:this.archive.dailyList().map(d=>({day:d.day,watermarkAt:d.watermarkAt,files:d.files.length})),
      trailingState:this.archive.ledger.state.trailingActivatedAt?'ACTIVE_FOR_NEW_ADMISSIONS':'DORMANT',
      memory:process.memoryUsage(),
      counts:this.counts,recent:this.recent,indexSize:this.index.size,available:files.length>0,
      sizeBytes:this.archive.total(),memoryLimits:{indexKeys:MAX_KEYS,recentRows:MAX_RECENT,rowBytes:TRADE_ROW_BYTES,candidateRowBytes:ROW_BYTES,
        activeTrades:trades.MAX_ACTIVE,recentTrades:trades.MAX_RECENT},tradeCounts:this.tradeCounts,
      shadowTrades:[...this.activeTrades.values(),...this.recentTrades].map(t=>({tradeId:t.tradeId,symbol:t.symbol,side:t.side,
        status:t.status,outcome:t.outcome,decisionAt:t.decisionAt,filledAt:t.filledAt,closedAt:t.closedAt,entryPrice:t.entryPrice,
        exitPrice:t.exitPrice,quantity:t.quantity,netPnl:t.netPnl??null,netPnlBeforeFunding:t.netPnlBeforeFunding??null,
        realizedR:t.realizedR??null,ambiguous:t.ambiguous,fundingStatus:t.fundingStatus,lastBarAt:t.lastBarAt})),
      lastTradeError:this.lastTradeError,tradeWorkerBusy:this.tradeWorkerBusy,
      control:control34,measurementVersion:m34.VERSION,episodes:this.episodes,measurementCounts:this.measurementCounts,
      measurementStartedAt:this.measurementStartedAt,measurementTradeCounts:this.measurementTradeCounts,
      captureErrors:{classes:this.errorClasses,recent:this.errorRecent,legacyUnexportedCount:this.counts.errors-Object.values(this.errorClasses).reduce((s,n)=>s+n,0)},
      measurementTrades:[...this.activeTrades.values(),...this.recentTrades].map(t=>({tradeId:t.tradeId,episodeId:t.episodeId,
        symbol:t.symbol,side:t.side,admissionOrdinal:t.episodeAdmissionOrdinal??null,status:t.status,
        stop:t.research34?.fill?.stop??t.research34?.decision?.stop??null,
        intendedRR:t.geometry?.rawRR??null,fillRR:t.fillEconomics?.rawRR??null,objective:t.geometry?.objectivePrice??null,
        nearestArm:t.research34?.nearestArm?{status:t.research34.nearestArm.status,objective:t.research34.nearestArm.trade?.geometry?.objectivePrice,
          identicalToControl:t.research34.nearestArm.identicalToControl,outcome:t.research34.nearestArm.outcome,netR:t.research34.nearestArm.netR??null}:null,
        rawTouches:t.research34?.rawTouches??{},mfeAt:t.research34?.mfeAt??null,maeAt:t.research34?.maeAt??null,
        premiumDiscount:t.research34?.decision?.premiumDiscount?.directionRelative??null,
        level:t.geometry?.reactionLevel?.type??null,reaction:t.geometry?.reactionLevel?.reaction?.type??null}))};
  }
  saveCheckpoint() {
    const text=JSON.stringify({index:[...this.index],counts:this.counts,aiOffsets:this.aiOffsets,
      activeTrades:[...this.activeTrades],armWorkers:[...this.armWorkers],recentTrades:this.recentTrades,tradeCounts:this.tradeCounts,
      startedAt:this.startedAt,captureCohort:this.captureCohort,archive:this.archive.checkpoint(),
      errorRecent:this.errorRecent,errorClasses:this.errorClasses,episodes:this.episodes,measurementCounts:this.measurementCounts,
      measurementStartedAt:this.measurementStartedAt,measurementTradeCounts:this.measurementTradeCounts,filledEpisodes:[...this.filledEpisodes]});
    // Measurement/error metadata is bounded and shares the existing checkpoint capacity contract.
    if(Buffer.byteLength(text)>=8*1024*1024)throw Error('SHADOW_CHECKPOINT_CAPACITY');
    const tmp=this.checkpoint+'.tmp';fs.writeFileSync(tmp,text);fs.renameSync(tmp,this.checkpoint);
  }
  tradeEvent(trade,transitions,now) {
    if(transitions.length===1 && transitions[0]==='MARK' && now-(trade.lastJournalMarkAt||0)<300000)return;
    this.append('trades',this.tradeRow(trade,transitions,now));
    if(trade.research35){this.append('arms',{outputType:'V34B_PAIRED_UPDATE',capturedAt:now,episodeId:trade.episodeId,
      holdoutCohort:trade.holdoutCohort??null,
      tradeId:trade.tradeId,transitions,executionAllowed:false,researchOnly:true,arm:trade.research35});this.holdout.update(trade);}
    if(transitions.includes('MARK'))trade.lastJournalMarkAt=now;
  }
  tradeRow(trade,transitions,now) {
    return {version:VERSION,outputType:'V3_SHADOW_TRADE',kind:'trade_update',
      eventId:hash([trade.tradeId,trade.status,trade.lastBarAt,trade.fundingStatus,transitions]),
      capturedAt:now,availableAt:now,transitions,trade};
  }
  summary() {
    // Small default analysis artifact: totals, hourly counts and a bounded set of examples.
    const s=this.status();return {captureSchema:'V3_COMPACT_V1',version:VERSION,captureCohort:this.captureCohort,
      startedAt:this.startedAt,exportedAt:Date.now(),executionAllowed:false,archive:s.archive,
      captureLedger:this.archive.ledger.records(),reconciliation:this.archive.ledger.identity(this.archive.skipped),
      counts:this.counts,tradeCounts:this.tradeCounts,hours:this.archive.summaryHours,
      recentCandidates:this.recent.slice(-6),recentTrades:s.shadowTrades.slice(-6),
      control:control34,measurementVersion:m34.VERSION,measurementCounts:this.measurementCounts,episodes:this.episodes,
      measurementStartedAt:this.measurementStartedAt,measurementTradeCounts:this.measurementTradeCounts,
      captureErrors:s.captureErrors,measurementTrades:s.measurementTrades.slice(-24),
      holdout:s.holdout,trailingState:s.trailingState,researchDefinitions:r35.DEFINITIONS,dailySnapshots:s.dailySnapshots,
      limitations:['Independent modelled trades; not portfolio P&L','Funding uses an entry-notional approximation',
        'Budget skips are explicit capture gaps','Raw data is available in separate compressed downloads']};
  }
  async advance(now=Date.now(),get=require('./bybit').researchGetStamped) {
    if(this.tradeWorkerBusy || now-this.tradePollAt<15000 || process.env.ORAYAN_V3_SHADOW_ENABLED==='false')return;
    this.tradeWorkerBusy=true;this.tradePollAt=now;
    try {
      // Eight trades per pass, up to sixteen sequential low-priority requests; trading has priority.
      const due=[...this.activeTrades.values()].filter(t=>!t.polledAt || now-t.polledAt>=60000)
        .sort((a,b)=>(a.polledAt||0)-(b.polledAt||0)).slice(0,8);
      // Extra arm workers have separate capacity; a surviving buffer can never
      // occupy a frozen control slot or displace its original eight-trade poll.
      due.push(...[...this.armWorkers.values()].filter(t=>!t.polledAt||now-t.polledAt>=60000)
        .sort((a,b)=>(a.polledAt||0)-(b.polledAt||0)).slice(0,4));
      for(const previous of due) {
        let isArmWorker=this.armWorkers.has(previous.tradeId);
        let next={...previous,polledAt:now};
        let committed=next;
        try {
          if(!trades.terminal(next)||r35.active(next.research35)) {
            const cursors=[...Object.values(next.research35?.arms||{}).filter(a=>a.trade&&!trades.terminal(a.trade)).map(a=>a.trade.lastBarAt===null?a.trade.eligibleFromAt:a.trade.lastBarAt+60000)];
            if(!trades.terminal(next))cursors.push(next.lastBarAt===null?next.eligibleFromAt:next.lastBarAt+60000);
            const start=Math.min(...cursors);
            const end=Math.min(Math.floor(now/60000)*60000-1,start+1000*60000-1);
            if(end<start)continue;
            const envelope=await get('/v5/market/kline',{category:'linear',symbol:next.symbol,interval:'1',start,end,limit:1000},next.testnet);
            const res=envelope?.result||envelope;
            if(!Array.isArray(res?.list))throw Error('INVALID_PATH_RESPONSE');
            const bars=res.list.map(r=>({ts:Number(r[0]),open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4])}))
              .sort((a,b)=>a.ts-b.ts);
            const cached=minuteCache.get(next.symbol,next.testnet,now);
            const result=t34.step(next,bars,now,{priorBars:cached?.bars||[],sourceAt:envelope.sourceAt??null,receivedAt:envelope.receivedAt??now,
              priorSourceAt:cached?.sourceAt??null,priorReceivedAt:cached?.receivedAt??null,
              quoteAt:at=>require('./bybit').quoteAt(next.symbol,next.testnet,at)});next=result.trade;
            next.research35=r35.advance(next.research35,next,bars,now);
            if(next.research35&&!bars.length&&now-start>180000){
              for(const a of Object.values(next.research35.arms))if(a.trade&&!trades.terminal(a.trade)){
                Object.assign(a.trade,{status:'DATA_GAP',outcome:'EMPTY_ARM_PATH',fundingStatus:'UNKNOWN_PATH',netPnl:null,outcomeComplete:false});
                Object.assign(a,{status:'DATA_GAP',reason:'EMPTY_ARM_PATH',opportunityNetCash:null,complete:false});
              }
              this.archive.ledger.receiptPulse(now,false);
              this.append('arms',{outputType:'V34B_ARM_PATH_CENSORED',capturedAt:Date.now(),tradeId:next.tradeId,episodeId:next.episodeId,
                arm:next.research35,executionAllowed:false});this.holdout.update(next);
            }
            if(next.research35)for(let p=0;p<bars.length;p+=32){const chunk=bars.slice(p,p+32);
              this.append('paths',{outputType:'V34B_ARM_MINUTE_PATH',capturedAt:Date.now(),
                tradeId:next.tradeId,episodeId:next.episodeId,eventId:hash([next.tradeId,'arms',chunk[0].ts,chunk.at(-1).ts]),
                bars:chunk.map(b=>({...b,receivedAt:envelope.receivedAt??now})),executionAllowed:false,researchOnly:true});}
            if(result.path?.length)for(let p=0;p<result.path.length;p+=32) {
              const chunk=result.path.slice(p,p+32);
              this.append('paths',{outputType:'V3_MANAGEMENT_MINUTE_PATH',version:m34.VERSION,tradeId:next.tradeId,
                episodeId:next.episodeId,symbol:next.symbol,executionAllowed:false,capturedAt:Date.now(),
                eventId:hash([next.tradeId,chunk[0].ts,chunk.at(-1).ts]),bars:chunk});
            }
            if(!trades.terminal(next)&&!bars.length && now-start>180000){next.status='DATA_GAP';next.outcome='EMPTY_PATH';
              next.fundingStatus='UNKNOWN_PATH';next.netPnl=null;next.outcomeComplete=false;result.events.push('DATA_GAP');}
            if(result.events.length) {
              this.tradeEvent(next,result.events,Date.now());
              for(const [event,key] of [['FILLED','filled'],['CLOSED','closed'],['CANCELLED','cancelled'],['EXPIRED','expired'],['DATA_GAP','incomplete']])
                if(result.events.includes(event)){this.tradeCounts[key]++;
                  if(next.research34&&['filled','closed'].includes(key))this.measurementTradeCounts[key]++;
                }
              if(next.research34&&result.events.includes('FILLED')&&!this.filledEpisodes.has(next.episodeId)){
                this.filledEpisodes.set(next.episodeId,next.filledAt);this.measurementTradeCounts.uniqueFilledEpisodes++;
                while(this.filledEpisodes.size>512)this.filledEpisodes.delete(this.filledEpisodes.keys().next().value);
              }
            }
            committed=next;
          }
          const armClosed=Object.values(next.research35?.arms||{}).filter(a=>a.trade?.status==='CLOSED'&&a.trade.fundingStatus==='PENDING').map(a=>a.trade);
          if(!isArmWorker&&trades.terminal(next)&&(next.status!=='CLOSED'||next.fundingStatus!=='PENDING')){
            this.activeTrades.delete(next.tradeId);this.recentTrades.push(next);if(this.recentTrades.length>trades.MAX_RECENT)this.recentTrades.shift();
            this.armWorkers.set(next.tradeId,next);isArmWorker=true;
          }
          if((next.status==='CLOSED' && next.fundingStatus==='PENDING')||armClosed.length) {
            // Settled rates are outcomes only, never decision-time features.
            const fundingEnd=next.status==='CLOSED'&&next.fundingStatus==='PENDING'?next.closedAt:Math.max(...armClosed.map(t=>t.closedAt));
            if(now<fundingEnd+120000){(isArmWorker?this.armWorkers:this.activeTrades).set(next.tradeId,next);this.saveCheckpoint();continue;}
            (isArmWorker?this.armWorkers:this.activeTrades).set(next.tradeId,next);this.saveCheckpoint();
            const envelope=await get('/v5/market/funding/history',{category:'linear',symbol:next.symbol,
              startTime:Math.min(next.filledAt||Infinity,...armClosed.map(t=>t.filledAt)),endTime:fundingEnd,limit:200},next.testnet);
            const res=envelope?.result||envelope;
            if(!Array.isArray(res?.list)||res.list.length===200)throw Error('FUNDING_COVERAGE_UNAVAILABLE');
            if(next.status==='CLOSED'&&next.fundingStatus==='PENDING')next=t34.funding(next,res.list,Date.now());
            next.research35=r35.funding(next.research35,res.list,Date.now(),fundingEnd);
            next.research35=r35.advance(next.research35,next,[],now);this.tradeEvent(next,['FUNDING_FINALIZED'],Date.now());
            committed=next;
          }
          this.archive.ledger.recovered('TRADE_PATH_OR_FUNDING',next.symbol,Date.now(),{tradeId:next.tradeId,
            retryCursor:{lastBarAt:previous.lastBarAt,fundingStatus:previous.fundingStatus},censored:next.status==='DATA_GAP'});this.lastTradeError=null;
        }catch(e){next=committed;this.captureError(e,{symbol:next.symbol,episodeId:next.episodeId,
          candidateId:next.candidateId,tradeId:next.tradeId,retryCursor:{lastBarAt:next.lastBarAt,fundingStatus:next.fundingStatus},subsystem:'TRADE_PATH_OR_FUNDING',affectedRecordType:'V3_SHADOW_TRADE',retry:'SAME_CURSOR_NEXT_POLL'});
          this.lastTradeError={at:Date.now(),symbol:next.symbol,reason:e.reasonCode||e.message};}
        (isArmWorker?this.armWorkers:this.activeTrades).set(next.tradeId,next);
        const armPending=r35.active(next.research35)||Object.values(next.research35?.arms||{}).some(a=>a.trade?.status==='CLOSED'&&a.trade.fundingStatus==='PENDING');
        if(trades.terminal(next) && (next.status!=='CLOSED'||next.fundingStatus!=='PENDING')) {
          this.activeTrades.delete(next.tradeId);if(armPending)this.armWorkers.set(next.tradeId,next);else this.armWorkers.delete(next.tradeId);
          if(!isArmWorker)this.recentTrades.push(next);
          if(this.recentTrades.length>trades.MAX_RECENT)this.recentTrades.shift();
        }
        this.saveCheckpoint();
      }
    }finally{this.tradeWorkerBusy=false;}
  }
  observeAI(provider,file,now=Date.now()) {
    if(minimal.enabled())return;
    if(!file || !fs.existsSync(file)){this.aiOffsets[provider]=0;return;}
    const size=fs.statSync(file).size;
    let offset=this.aiOffsets[provider]??size; // New experiment starts NOW, not at historical output.
    if(offset>size)offset=0;
    if(offset===size){this.aiOffsets[provider]=offset;return;}
    const fd=fs.openSync(file,'r'),buffer=Buffer.alloc(Math.min(size-offset,MAX_ROW_BYTES));
    let count;try{count=fs.readSync(fd,buffer,0,buffer.length,offset);}finally{fs.closeSync(fd);}
    const data=buffer.subarray(0,count),end=data.lastIndexOf(10);
    if(end<0){if(count===MAX_ROW_BYTES){this.aiOffsets[provider]=offset+count;this.captureError(Error('AI_ROW_TOO_LARGE'),{subsystem:'AI_LEDGER',skip:true});}return;}
    for(const line of data.subarray(0,end).toString('utf8').split('\n')) {
      if(!line)continue;
      try {
        const r=JSON.parse(line);if(r.record_type!=='SHADOW_DECISION')continue;
        const episode=[...this.index.values()].find(x=>[...(x.birthLinks||[]),...(x.currentLinks||[])].some(p=>p.candidateId===r.candidate_id));
        const link=episode?[...(episode.birthLinks||[]),...(episode.currentLinks||[])].find(p=>p.candidateId===r.candidate_id):null;
        const outputAt=Date.parse(r.available_to_system_at_utc||r.completed_at_utc||r.requested_at_utc);
        const verdict=r.decision?.decision;
        const timing=m34.observer(r,provider,now,link?.decisionAt??null);
        if(episode){this.observers.set(provider+':'+episode.episodeId,{row:r,capturedAt:now});
          while(this.observers.size>128)this.observers.delete(this.observers.keys().next().value);}
        this.append('ai',{version:VERSION,outputType:'AI_RESEARCH_CONTEXT',provider,model:r.model||null,
          requestId:r.request_id,candidateId:r.candidate_id,episodeId:episode?.episodeId??null,timing,
          outputAt:Number.isFinite(outputAt)?outputAt:null,capturedAt:now,status:r.status,
          output:r.decision||null,requestHash:r.request_hash??null,responseSchemaHash:r.response_schema_hash??null,matchedDecisionAt:link?.decisionAt??null,
          availableAfterDecision:link && Number.isFinite(outputAt)?outputAt>link.decisionAt:null,
          agreedWithV2:link && link.passed!==null && ['RETAIN','SKIP'].includes(verdict)?(verdict==='RETAIN')===link.passed:null,
          agreedWithV3:link && ['ACCEPT_SHADOW','REJECT'].includes(link.v3Decision) && ['RETAIN','SKIP'].includes(verdict)?
            (verdict==='RETAIN')===(link.v3Decision==='ACCEPT_SHADOW'):null,
          agreementReason:link?.v3Decision?'MATCHED_DETERMINISTIC_SHADOW_DECISION':'NO_V3_DECISION_LINK',executionAuthority:false});
      }catch(e){this.captureError(e,{subsystem:'AI_LEDGER',affectedRecordType:'AI_RESEARCH_CONTEXT',retry:'NEXT_LEDGER_ROW',skip:true});}
    }
    this.aiOffsets[provider]=offset+end+1;
  }
}
let instance;
function journal(){if(!instance){const root=require('./store').DATA_DIR;
  instance=new ShadowJournal(path.join(root,'v3-shadow-compact-v1'),{legacyDir:path.join(root,'v3-shadow')});
  const timer=setInterval(()=>{instance.advance().catch(e=>instance.captureError(e,{subsystem:'TRADE_WORKER'}));
    minuteCache.advance(undefined,(e,c)=>instance.captureError(e,c));},15000);timer.unref();}return instance;}
function observeScan({scanAt,scanId,candlesBySymbol,tickerBySymbol,instruments,btcRegime,settings,signals,marketSnapshot}) {
  if(process.env.ORAYAN_V3_SHADOW_ENABLED==='false')return;
  if(minimal.enabled())minimal.config(settings,hash(settings));
  const j=journal();
  const errorsBefore=j.counts.errors;
  j.receiptCoverageFailed=false;
  minuteCache.watch([...candlesBySymbol.keys()],settings.testnet);
  for(const [symbol,candles] of candlesBySymbol) {
    try {
      const row=evaluate({symbol,candles,ticker:tickerBySymbol.get(symbol),instrument:instruments?.get(symbol),btcRegime,settings,decisionAt:Date.now(),
        v2Signals:signals.filter(s=>s.symbol===symbol && !s.signalSource?.startsWith('MARCI'))});
      if(minimal.enabled())row.v2Decision=row.v2Decision.map(p=>({...p,...require('./researchCapture').previewCandidateLink(signals.find(s=>s.id===p.candidateId),scanAt,settings)}));
      row.btcContext={regime:btcRegime?.regime??null,strength:btcRegime?.strength??null,
        return1:marketSnapshot?.btcReturn1??null,return3:marketSnapshot?.btcReturn3??null};
      row.breadth={value:marketSnapshot?.directionalBreadth??null,momentum:marketSnapshot?.breadthMomentum??null,
        marketSnapshotId:marketSnapshot?.marketSnapshotId??null,availableAt:marketSnapshot?.observedAt??null};
      try{row.measurement34=m34.decision(row,{candles,minute:minuteCache.get(symbol,settings.testnet,row.decisionAt),
        ticker:require('./bybit').quoteStamp(symbol,tickerBySymbol.get(symbol),settings.testnet),btcRegime,marketSnapshot,
        universe:[...candlesBySymbol.keys()],structuralEvents:require('./researchSupplement').causalEvents(symbol,row.decisionAt),
        candleStamp:require('./bybit').klineStamp(symbol,settings.timeframe,settings.testnet)});
      }catch(e){j.captureError(Error('MEASUREMENT_FAILED'),{symbol,subsystem:'DECISION_MEASUREMENT'});}
      j.record(row,scanId,scanAt);
    }catch(e){j.captureError(e,{symbol,subsystem:'DECISION_CAPTURE',affectedRecordType:'V3_SHADOW_SIGNAL'});}
  }
  observeProviders(j);
  j.lastScanErrors=j.counts.errors-errorsBefore;
  const receiptsComplete=!j.receiptCoverageFailed&&!j.lastTradeError&&j.archive.total()<=j.archive.maxBytes;
  j.archive.ledger.receiptPulse(Date.now(),receiptsComplete,j.lastScanErrors===0);
  const qualificationFile=path.join(j.dir,'capture-live-qualification.json');
  const qualification=fs.existsSync(qualificationFile)?JSON.parse(fs.readFileSync(qualificationFile,'utf8')):null;
  if(receiptsComplete&&!j.holdout.state.startedAt&&qualification?.implementationHash===implementationHash&&require('../validation/v34b-capture-validation.json').passed){
    j.holdout.start(control34,hash(settings),Date.now(),{...qualification,ledgerBaseline:j.archive.ledger.identity(j.archive.skipped),capturePolicy:j.archive.status().capturePolicy,
      hourBudgetBytes:j.archive.hourBytes,archiveCapBytes:j.archive.maxBytes});
    if(j.holdout.state.startedAt)j.archive.ledger.beginCohort(j.holdout.state.cohortId,j.holdout.state.startedAt);
  }
  j.checkpointAndPrune();
  j.advance().catch(e=>j.captureError(e,{subsystem:'TRADE_WORKER'}));
}
module.exports={VERSION,BENCHMARK,evaluate,ShadowJournal,observeProviders,observeScan,status:()=>({...journal().status(),lastScanErrors:journal().lastScanErrors??null}),
  summary:generation=>generation?journal().archive.sessions.get(generation)?.status||journal().summary():journal().summary(),cohort:()=>journal().cohort(),daily:day=>journal().dailyExport(day),download:(channel,generation)=>journal().export(channel||'v3',generation)};
