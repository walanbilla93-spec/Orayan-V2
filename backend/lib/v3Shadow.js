'use strict';

// One-way observer. This module cannot place orders and never returns a trade signal.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {validateClosedCandles,trendPermission}=require('./v3Contracts');
const levels=require('./v3Levels');
const geometry=require('./v3Geometry');
const trades=require('./v3Trades');
const corrected=require('./signals_trend_v30');
const location=require('./locationResearch');
const {redact}=require('../../research/alibaba-shadow/src/security');
const runtime=require('./runtimeIdentity');
const VERSION='ORAYAN_V3_TRANCHE2';
const BENCHMARK='d7f2ba802a4b4204fad70bf502c6f996f76aabc4';
const frozen=require('./v3Benchmark.json');
const MAX_KEYS=512,MAX_RECENT=24,MAX_ROW_BYTES=65536,RETENTION_MS=96*3600000;
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?
  Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex').slice(0,24);
const implementationHash=crypto.createHash('sha256').update(['v3Shadow.js','v3Contracts.js','v3Levels.js','v3Geometry.js','v3Trades.js','signals_trend_v30.js']
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
  constructor(dir) {
    this.dir=dir;this.checkpoint=path.join(dir,'checkpoint.json');this.index=new Map();this.recent=[];
    this.counts={v2:0,v3:0,ai:0,trades:0,errors:0};this.aiOffsets={};this.lastPrune=0;
    this.activeTrades=new Map();this.recentTrades=[];this.tradeCounts={admitted:0,filled:0,closed:0,cancelled:0,expired:0,incomplete:0};
    this.tradePollAt=0;this.tradeWorkerBusy=false;this.lastTradeError=null;
    fs.mkdirSync(dir,{recursive:true});
    // Restore ONLY a capped checkpoint, never materialise the research archive at boot.
    if(fs.existsSync(this.checkpoint) && fs.statSync(this.checkpoint).size<1024*1024) {
      try {const saved=JSON.parse(fs.readFileSync(this.checkpoint,'utf8'));
        this.index=new Map((saved.index||[]).slice(-MAX_KEYS));this.counts={...this.counts,...saved.counts};
        this.aiOffsets=saved.aiOffsets||{};}catch(_){this.counts.errors++;}
      try {const saved=JSON.parse(fs.readFileSync(this.checkpoint,'utf8'));
        this.activeTrades=new Map((saved.activeTrades||[]).slice(-trades.MAX_ACTIVE));
        this.recentTrades=(saved.recentTrades||[]).slice(-trades.MAX_RECENT);this.tradeCounts={...this.tradeCounts,...saved.tradeCounts};
      }catch(_){this.counts.errors++;}
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
    if(row.v3Decision==='ACCEPT_SHADOW') {
      const trade=trades.create(record,setupId,capturedAt);
      this.tradeEvent(trade,['ADMITTED'],capturedAt);this.activeTrades.set(setupId,trade);this.tradeCounts.admitted++;
      this.saveCheckpoint(); // Persist admissions before any asynchronous path reads.
    }
    const currentLinks=row.v2Decision.map(p=>({candidateId:p.candidateId,passed:p.passed,decisionAt:row.decisionAt,
      v3Decision:row.geometry?.status==='ACCEPTED'?'ACCEPT_SHADOW':row.v3Decision}));
    const birthLinks=continuing?(previous.birthLinks||[]):currentLinks;
    this.index.delete(key);this.index.set(key,{signature,firstBirthAt,episodeId,lastSeenAt:row.decisionAt,
      birthLinks,currentLinks,v3Decision:row.v3Decision,
      lastAdmittedSetup:row.v3Decision==='ACCEPT_SHADOW'?setupId:previous?.lastAdmittedSetup??null});
    while(this.index.size>MAX_KEYS)this.index.delete(this.index.keys().next().value);
    this.recent.push({candidateId:record.candidateId,symbol:row.symbol,side:row.side,regime:row.regime,
      decisionAt:row.decisionAt,firstBirthAt,kind:record.kind,directionPermission:row.directionPermission,
      levelType:row.research?.selected?.type??null,reaction:row.research?.reaction?.state??null,
      premiumDiscount:row.research?.premiumDiscount?.classification??null,rejectReason:row.rejectReason,
      v3Decision:row.v3Decision,costAdjustedRR:row.geometry?.costAdjustedRR??null});
    if(this.recent.length>MAX_RECENT)this.recent.shift();
  }
  checkpointAndPrune(now=Date.now()) {
    for(const [key,value] of this.index)if(now-value.lastSeenAt>3*3600000)this.index.delete(key);
    this.saveCheckpoint();
    if(now-this.lastPrune<3600000)return;
    this.lastPrune=now;
    for(const name of fs.readdirSync(this.dir)) {
      const m=/^(v2|v3|ai|trades)-(\d{4}-\d{2}-\d{2})-(\d{2})\.jsonl$/.exec(name);
      if(m && Date.parse(`${m[2]}T${m[3]}:00:00Z`)+3600000<now-RETENTION_MS)
        fs.unlinkSync(path.join(this.dir,name));
    }
  }
  files(channel='v3') {
    if(!['v2','v3','ai','trades'].includes(channel))throw Object.assign(Error('Invalid V3 export channel'),{statusCode:400});
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
      benchmarkCommit:BENCHMARK,executionAllowed:false,stage:'V3.3_SHADOW_OUTCOMES',retentionHours:96,
      counts:this.counts,recent:this.recent,indexSize:this.index.size,available:files.length>0,
      sizeBytes:files.reduce((a,f)=>a+f.size,0),memoryLimits:{indexKeys:MAX_KEYS,recentRows:MAX_RECENT,rowBytes:MAX_ROW_BYTES,
        activeTrades:trades.MAX_ACTIVE,recentTrades:trades.MAX_RECENT},tradeCounts:this.tradeCounts,
      shadowTrades:[...this.activeTrades.values(),...this.recentTrades].map(t=>({tradeId:t.tradeId,symbol:t.symbol,side:t.side,
        status:t.status,outcome:t.outcome,decisionAt:t.decisionAt,filledAt:t.filledAt,closedAt:t.closedAt,entryPrice:t.entryPrice,
        exitPrice:t.exitPrice,quantity:t.quantity,netPnl:t.netPnl??null,netPnlBeforeFunding:t.netPnlBeforeFunding??null,
        realizedR:t.realizedR??null,ambiguous:t.ambiguous,fundingStatus:t.fundingStatus,lastBarAt:t.lastBarAt})),
      lastTradeError:this.lastTradeError,tradeWorkerBusy:this.tradeWorkerBusy};
  }
  saveCheckpoint() {
    const text=JSON.stringify({index:[...this.index],counts:this.counts,aiOffsets:this.aiOffsets,
      activeTrades:[...this.activeTrades],recentTrades:this.recentTrades,tradeCounts:this.tradeCounts});
    if(Buffer.byteLength(text)>=1024*1024)throw Error('SHADOW_CHECKPOINT_CAPACITY');
    const tmp=this.checkpoint+'.tmp';fs.writeFileSync(tmp,text);fs.renameSync(tmp,this.checkpoint);
  }
  tradeEvent(trade,transitions,now) {
    this.append('trades',{version:VERSION,outputType:'V3_SHADOW_TRADE',kind:'trade_update',
      eventId:hash([trade.tradeId,trade.status,trade.lastBarAt,trade.fundingStatus,transitions]),
      capturedAt:now,availableAt:now,transitions,trade});
  }
  async advance(now=Date.now(),get=require('./bybit').researchGet) {
    if(this.tradeWorkerBusy || now-this.tradePollAt<15000 || process.env.ORAYAN_V3_SHADOW_ENABLED==='false')return;
    this.tradeWorkerBusy=true;this.tradePollAt=now;
    try {
      // Eight trades per pass, up to sixteen sequential low-priority requests; trading has priority.
      const due=[...this.activeTrades.values()].filter(t=>!t.polledAt || now-t.polledAt>=60000)
        .sort((a,b)=>(a.polledAt||0)-(b.polledAt||0)).slice(0,8);
      for(const previous of due) {
        let next={...previous,polledAt:now};
        let committed=next;
        try {
          if(!trades.terminal(next)) {
            const start=next.lastBarAt===null?next.eligibleFromAt:next.lastBarAt+60000;
            const end=Math.min(Math.floor(now/60000)*60000-1,start+1000*60000-1);
            if(end<start)continue;
            const res=await get('/v5/market/kline',{category:'linear',symbol:next.symbol,interval:'1',start,end,limit:1000},next.testnet);
            if(!Array.isArray(res?.list))throw Error('INVALID_PATH_RESPONSE');
            const bars=res.list.map(r=>({ts:Number(r[0]),open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4])}))
              .sort((a,b)=>a.ts-b.ts);
            const result=trades.step(next,bars,now);next=result.trade;
            if(!bars.length && now-start>180000){next.status='DATA_GAP';next.outcome='EMPTY_PATH';
              next.fundingStatus='UNKNOWN_PATH';next.netPnl=null;next.outcomeComplete=false;result.events.push('DATA_GAP');}
            if(result.events.length) {
              this.tradeEvent(next,result.events,Date.now());
              for(const [event,key] of [['FILLED','filled'],['CLOSED','closed'],['CANCELLED','cancelled'],['EXPIRED','expired'],['DATA_GAP','incomplete']])
                if(result.events.includes(event))this.tradeCounts[key]++;
            }
            committed=next;
          }
          if(next.status==='CLOSED' && next.fundingStatus==='PENDING') {
            // Settled rates are outcomes only, never decision-time features.
            if(now<next.closedAt+120000){this.activeTrades.set(next.tradeId,next);this.saveCheckpoint();continue;}
            this.activeTrades.set(next.tradeId,next);this.saveCheckpoint();
            const res=await get('/v5/market/funding/history',{category:'linear',symbol:next.symbol,
              startTime:next.filledAt,endTime:next.closedAt,limit:200},next.testnet);
            if(!Array.isArray(res?.list)||res.list.length===200)throw Error('FUNDING_COVERAGE_UNAVAILABLE');
            next=trades.funding(next,res.list,Date.now());this.tradeEvent(next,['FUNDING_FINALIZED'],Date.now());
            committed=next;
          }
          this.lastTradeError=null;
        }catch(e){next=committed;this.counts.errors++;this.lastTradeError={at:Date.now(),symbol:next.symbol,reason:e.reasonCode||e.message};}
        this.activeTrades.set(next.tradeId,next);
        if(trades.terminal(next) && (next.status!=='CLOSED'||next.fundingStatus!=='PENDING')) {
          this.activeTrades.delete(next.tradeId);this.recentTrades.push(next);
          if(this.recentTrades.length>trades.MAX_RECENT)this.recentTrades.shift();
        }
        this.saveCheckpoint();
      }
    }finally{this.tradeWorkerBusy=false;}
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
          output:r.decision||null,matchedDecisionAt:link?.decisionAt??null,
          availableAfterDecision:link && Number.isFinite(outputAt)?outputAt>link.decisionAt:null,
          agreedWithV2:link && link.passed!==null && ['RETAIN','SKIP'].includes(verdict)?(verdict==='RETAIN')===link.passed:null,
          agreedWithV3:link && ['ACCEPT_SHADOW','REJECT'].includes(link.v3Decision) && ['RETAIN','SKIP'].includes(verdict)?
            (verdict==='RETAIN')===(link.v3Decision==='ACCEPT_SHADOW'):null,
          agreementReason:link?.v3Decision?'MATCHED_DETERMINISTIC_SHADOW_DECISION':'NO_V3_DECISION_LINK',executionAuthority:false});
      }catch(_){this.counts.errors++;}
    }
    this.aiOffsets[provider]=offset+end+1;
  }
}
let instance;
function journal(){if(!instance){instance=new ShadowJournal(path.join(require('./store').DATA_DIR,'v3-shadow'));
  const timer=setInterval(()=>instance.advance().catch(()=>instance.counts.errors++),15000);timer.unref();}return instance;}
function observeScan({scanAt,scanId,candlesBySymbol,tickerBySymbol,instruments,btcRegime,settings,signals,marketSnapshot}) {
  if(process.env.ORAYAN_V3_SHADOW_ENABLED==='false')return;
  const j=journal();
  const errorsBefore=j.counts.errors;
  for(const [symbol,candles] of candlesBySymbol) {
    try {
      const row=evaluate({symbol,candles,ticker:tickerBySymbol.get(symbol),instrument:instruments?.get(symbol),btcRegime,settings,decisionAt:Date.now(),
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
  j.advance().catch(()=>j.counts.errors++);
}
module.exports={VERSION,BENCHMARK,evaluate,ShadowJournal,observeProviders,observeScan,status:()=>({...journal().status(),lastScanErrors:journal().lastScanErrors??null}),
  download:channel=>journal().export(channel||'v3')};
