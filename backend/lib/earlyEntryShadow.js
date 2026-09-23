'use strict';

// EARLY_ENTRY_SHADOW_V1 is a research-only sidecar. No value produced here is imported by
// signal builders, gates, ranking, sizing, portfolio controls, Marci, or execution.
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const store=require('./store');
const logger=require('./logger');
const capture=require('./researchCapture');
const risk=require('./risk');

const VERSION='EARLY_ENTRY_SHADOW_V1';
const DIR=path.join(store.DATA_DIR,'early-entry-shadow-v1');
const RETENTION_MS=96*3600000; // max 72h hold + entry window/restart margin
const MAX_PENDING=512;
const seen=new Map(),pending=new Map(),pendingQuotes=new Map();
const quoteInFlight=new Set();
let timer=null,resolving=false,lastPrune=0;

const finite=x=>x==null||x===''||!Number.isFinite(Number(x))?null:Number(x);
const round=x=>x==null||!Number.isFinite(x)?null:Math.round(x*1e8)/1e8;
const digest=parts=>crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0,20);
function validDate(date) {
  return date==='all'||(/^\d{4}-\d{2}-\d{2}$/.test(date)&&
    new Date(`${date}T00:00:00Z`).toISOString().slice(0,10)===date);
}
function files(date='all') {
  if (!validDate(date)) throw Error('Invalid UTC date');
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter(name=>/^early-entry-\d{4}-\d{2}-\d{2}-\d{2}\.jsonl$/.test(name)&&
    (date==='all'||name.startsWith(`early-entry-${date}-`))).sort().map(name=>path.join(DIR,name));
}
function prune(now=Date.now()) {
  if (fs.existsSync(DIR)) {
    const cutoff=now-RETENTION_MS;
    for (const file of files()) {
      const m=/early-entry-(\d{4}-\d{2}-\d{2})-(\d{2})\.jsonl$/.exec(file);
      if (Date.parse(`${m[1]}T${m[2]}:00:00Z`)+3600000<cutoff) {
        try {fs.unlinkSync(file);} catch(e) {logger.warn('research','Early-entry prune failed',{error:e.message});}
      }
    }
    for (const [k,at] of seen) if (at<cutoff) seen.delete(k);
    for (const [k,v] of pending) if ((v.decisionAt||0)<cutoff) pending.delete(k);
    for (const [k,v] of pendingQuotes) if ((v.decisionAt||0)<cutoff) pendingQuotes.delete(k);
  }
}
function append(row,at=Date.now()) {
  const dedupe=`${row.kind}|${row.eventId}`;
  if (seen.has(dedupe)) return false;
  try {
    fs.mkdirSync(DIR,{recursive:true});
    const hour=new Date(at).toISOString().slice(0,13).replace('T','-');
    fs.appendFileSync(path.join(DIR,`early-entry-${hour}.jsonl`),JSON.stringify(row)+'\n');
    seen.set(dedupe,at);
    if (at-lastPrune>3600000) {lastPrune=at;prune(at);}
    return true;
  } catch(e) {logger.warn('research','Early-entry append failed',{error:e.message});return false;}
}
function trimPending() {
  for (const [map,stage] of [[pending,'OUTCOME'],[pendingQuotes,'QUOTE']]) {
    if (map.size<=MAX_PENDING) continue;
    const oldest=[...map.values()].sort((a,b)=>a.decisionAt-b.decisionAt).slice(0,map.size-MAX_PENDING);
    for (const row of oldest) {
      map.delete(row.experimentId);
      append({version:VERSION,kind:'incomplete',eventId:digest(['bounded-eviction',stage,row.experimentId]),
        at:Date.now(),experimentId:row.experimentId,episodeId:row.episodeId,
        reason:`BOUNDED_PENDING_${stage}_EVICTION`,incompleteData:true});
    }
  }
}

// Restore only the bounded 96-hour hourly stream. Pair rows are compact and pending is capped.
try {
  prune();
  const completed=new Set();
  for (const file of files()) for (const line of fs.readFileSync(file,'utf8').split('\n')) {
    if (!line) continue;
    const row=JSON.parse(line);
    seen.set(`${row.kind}|${row.eventId}`,finite(row.at)||Date.now());
    if (row.kind==='pair_created') pending.set(row.experimentId,row);
    if (row.kind==='paired_outcome'||row.kind==='incomplete') completed.add(row.experimentId);
    if (row.kind==='eligibility_assessment'&&row.eligible===true) pendingQuotes.set(row.experimentId,row);
  }
  for (const id of completed) {pending.delete(id);pendingQuotes.delete(id);}
  for (const id of pending.keys()) pendingQuotes.delete(id);
  trimPending();
} catch(e) {logger.warn('research','Early-entry restore failed',{error:e.message});}

function exactDirectionContext(signal,decisionAt) {
  const candidates=[
    ['signal.directionBrain',signal?.directionBrain],
    ['signal.dirBrainAdvice',signal?.dirBrainAdvice],
    ['signal.researchContext.directionBrain',signal?.researchContext?.directionBrain],
  ];
  for (const [source,x] of candidates) {
    const value=String(typeof x==='string'?x:(x?.verdict??x?.value??'')).toUpperCase();
    const observedAt=finite(x?.observedAt??x?.at??signal?.createdAt);
    if (['CAUTION','AGREE','OPPOSE'].includes(value)&&observedAt!==null&&observedAt<=decisionAt)
      return {value,source,observedAt};
  }
  return {value:'NOT_AVAILABLE',source:'NOT_AVAILABLE_IN_NEW_ORAYAN',observedAt:null};
}
function exactBreadthPercentile(signal,snapshot,decisionAt) {
  const candidates=[
    ['signal.breadthPercentile',signal?.breadthPercentile,signal?.breadthPercentileObservedAt??signal?.createdAt],
    ['signal.breadthRangePctileAtEntry',signal?.breadthRangePctileAtEntry,signal?.createdAt],
    ['signal.researchContext.breadthPercentile',signal?.researchContext?.breadthPercentile,
      signal?.researchContext?.breadthObservedAt??signal?.createdAt],
    ['snapshot.breadthPercentile',snapshot?.breadthPercentile,snapshot?.observedAt],
  ];
  for (const [source,valueRaw,atRaw] of candidates) {
    const value=finite(valueRaw),observedAt=finite(atRaw);
    if (value!==null&&value>=0&&value<=100&&observedAt!==null&&observedAt<=decisionAt)
      return {value,category:value>=85?'TOP_>=85':value<=15?'BOTTOM_<=15':'MID_15_85',source,observedAt};
  }
  return {value:null,category:'NOT_AVAILABLE',source:'NOT_AVAILABLE_IN_NEW_ORAYAN',observedAt:null};
}
function structureTag(value) {
  const text=String(value||'').toUpperCase();
  if (text.startsWith('BOS')) return 'BOS';
  if (text.startsWith('CHOCH')) return 'CHOCH';
  if (text.includes('TRAP')) return 'TRAP';
  if (text.includes('DIVERGENCE')) return 'DIVERGENCE';
  return text||'NOT_AVAILABLE';
}
function btcBuyPermission(signal) {
  const regime=String(signal?.btcRegime||'UNKNOWN');
  const check=(signal?.gates?.checks||[]).find(x=>x?.gate==='BTC_REGIME'||x?.name==='BTC_REGIME');
  const allowed=['BULL_TREND','BULL_RANGE'].includes(regime)&&signal?.regimeAligned===true&&check?.pass!==false;
  return {allowed,regime,gateCheck:check||null,source:'native regimeAligned + BTC_REGIME gate'};
}
function evaluateEligibility({signal,link,context}) {
  const scanAt=finite(context?.scanAt)??finite(signal?.createdAt)??Date.now();
  // scanAt is captured before the universe loop; a signal may be constructed milliseconds later.
  // The decision cannot predate either timestamp.
  const decisionAt=Math.max(scanAt,finite(signal?.createdAt)??scanAt);
  const direction=exactDirectionContext(signal,decisionAt);
  const breadth=exactBreadthPercentile(signal,context?.snapshot,decisionAt);
  const structure=structureTag(signal?.structureEvent);
  const permission=btcBuyPermission(signal);
  const originAt=finite(link?.originAt)??scanAt;
  const episodeAgeMs=Math.max(0,scanAt-originAt);
  const fresh=link?.isBirth===true&&episodeAgeMs===0;
  const cohort=direction.value==='CAUTION'?'CAUTION':direction.value==='AGREE'?'AGREE':'UNCLASSIFIED';
  const checks={buy:signal?.side==='BUY',nativeEpisodeFresh:fresh,directionContextAvailable:direction.value!=='NOT_AVAILABLE',
    directionContextEligible:['CAUTION','AGREE'].includes(direction.value),breadthTop85:breadth.category==='TOP_>=85',
    explicitStructure:['BOS','CHOCH','TRAP','DIVERGENCE'].includes(structure),
    bullishPermission:permission.allowed,strategyGatesPassed:signal?.gates?.passed===true,
    contemporaneous:direction.observedAt!==null&&breadth.observedAt!==null&&
      direction.observedAt<=decisionAt&&breadth.observedAt<=decisionAt};
  const eligible=Object.values(checks).every(Boolean);
  return {decisionAt,originAt,episodeAgeMs,fresh,cohort,direction,breadth,structure,permission,checks,eligible,
    reasons:Object.entries(checks).filter(([,ok])=>!ok).map(([name])=>name)};
}
function exhaustionContext(signal,decisionAt) {
  const type=structureTag(signal?.structureEvent);
  if (type!=='BOS') return {tag:'NOT_BOS',isGate:false,usesPostEvent:false,pre5:null,pre1:null};
  const liq=capture.liquidationWindows(signal.symbol,decisionAt,decisionAt);
  const supportive=signal.side==='BUY'&&liq.pre5?
    liq.pre5.shortNotional>liq.pre5.longNotional&&liq.pre5.totalNotional>0:null;
  return {tag:supportive===true?'BOS_DIRECTION_SUPPORTIVE_LIQUIDATION_AT_BIRTH':
    supportive===false?'BOS_NO_DIRECTION_SUPPORTIVE_LIQUIDATION_AT_BIRTH':'NOT_AVAILABLE',
    isGate:false,usesPostEvent:false,coverage:liq.pre5?'PRE_ONLY':'GAP_OR_WARMUP',pre5:liq.pre5||null,pre1:liq.pre1||null,
    sideMeaning:liq.sideMeaning};
}
function frozenSettings(settings) {
  return {entryWindowMin:finite(settings?.entryWindowMin),maxHoldMin:finite(settings?.maxHoldMin),
    entryBufferBps:finite(settings?.entryBufferBps),tpThroughBps:finite(settings?.tpThroughBps),
    adverseSlippageBps:finite(settings?.slSlipBps),makerFeePct:finite(settings?.makerFeePct),
    takerFeePct:finite(settings?.takerFeePct),riskUsdtPerTrade:finite(settings?.riskUsdtPerTrade),
    maxNotionalUsdt:finite(settings?.maxNotionalUsdt),leverage:finite(settings?.leverage),testnet:!!settings?.testnet};
}
function observeCandidate(signal,context={}) {
  const link=capture.candidateLink(signal?.id);
  if (!link||link.engine!=='NEW_ORAYAN'||link.isBirth!==true) return null;
  const assessment=evaluateEligibility({signal,link,context});
  const experimentId=digest([VERSION,link.episodeId,assessment.cohort]);
  const eventId=digest(['eligibility',experimentId]);
  if (seen.has(`eligibility_assessment|${eventId}`)) return experimentId;
  const row={version:VERSION,kind:'eligibility_assessment',eventId,at:Date.now(),experimentId,
    candidateId:signal.id,candidateKey:link.key,episodeId:link.episodeId,decisionAt:assessment.decisionAt,
    decisionTimeSource:'max(engine scanAt, signal.createdAt) after gate verdict is available',symbol:signal.symbol,side:signal.side,
    configHash:context.configHash||link.configHash||null,marketSnapshotId:context.snapshot?.marketSnapshotId||null,
    cohort:assessment.cohort,eligible:assessment.eligible,eligibilityChecks:assessment.checks,
    ineligibilityReasons:assessment.reasons,directionContext:assessment.direction,
    breadthPercentile:assessment.breadth.value,breadthCategory:assessment.breadth.category,
    breadthPercentileSource:assessment.breadth.source,structureAtBirth:assessment.structure,
    permissionAtBirth:assessment.permission,episodeFresh:assessment.fresh,
    freshnessDefinition:'FIRST_OBSERVATION_OF_NATIVE_30_MINUTE_CONTINUITY_EPISODE',
    episodeOriginAt:assessment.originAt,episodeAgeMs:assessment.episodeAgeMs,episodeState:assessment.fresh?'FRESH_BIRTH':'STALE_OR_CONTINUING',
    originRegime:link.originBtcRegime||signal.btcRegime||null,orderTimeRegime:signal.btcRegime||null,
    originToOrderRegime:link.originBtcRegime&&signal.btcRegime?`${link.originBtcRegime}->${signal.btcRegime}`:'NOT_AVAILABLE',
    exhaustionContext:exhaustionContext(signal,assessment.decisionAt),
    plannedEntry:finite(signal.entry),plannedSl:finite(signal.sl),plannedTp:finite(signal.tp),
    settings:frozenSettings(context.settings),instrument:context.instrument||null,
    quoteStatus:assessment.eligible?'PENDING_FIRST_POST_DECISION_QUOTE':'NOT_REQUESTED',
    incompleteData:!assessment.eligible&&assessment.reasons.some(x=>x.includes('Available')||x==='contemporaneous')};
  if (!append(row,row.at)||!assessment.eligible) return experimentId;
  pendingQuotes.set(experimentId,row);
  trimPending();
  pumpQuotes();
  start();
  return experimentId;
}
function quoteFromResult(result,symbol) {
  const x=(result?.list||[]).find(v=>v.symbol===symbol)||(result?.list||[])[0];
  return {bid:finite(x?.bid1Price),ask:finite(x?.ask1Price),last:finite(x?.lastPrice),mark:finite(x?.markPrice)};
}
async function acquireQuote(assessment) {
  if (!pendingQuotes.has(assessment.experimentId)||pending.has(assessment.experimentId)||
    quoteInFlight.has(assessment.experimentId)||quoteInFlight.size>=4) return;
  quoteInFlight.add(assessment.experimentId);
  const requestedAt=Math.max(Date.now(),assessment.decisionAt+1);
  try {
    const result=await capture.researchGet('/v5/market/tickers',{category:'linear',symbol:assessment.symbol},assessment.settings.testnet);
    const receivedAt=Date.now(),quote=quoteFromResult(result,assessment.symbol);
    if (!(quote.ask>0)||!(quote.bid>0)) throw Error('Executable bid/ask unavailable');
    const slipBps=assessment.settings.adverseSlippageBps||0;
    const earlyEntry=assessment.side==='BUY'?quote.ask*(1+slipBps/10000):quote.bid*(1-slipBps/10000);
    const controlSizing=risk.sizePosition({entry:assessment.plannedEntry,sl:assessment.plannedSl,
      settings:assessment.settings,instrument:assessment.instrument});
    const earlySizing=risk.sizePosition({entry:earlyEntry,sl:assessment.plannedSl,
      settings:assessment.settings,instrument:assessment.instrument});
    const executableEarlyEntry=earlySizing.ok?earlySizing.entry:earlyEntry;
    const executableControlEntry=controlSizing.ok?controlSizing.entry:assessment.plannedEntry;
    const frozenSl=controlSizing.ok?controlSizing.sl:assessment.plannedSl;
    const pair={version:VERSION,kind:'pair_created',eventId:digest(['pair',assessment.experimentId]),at:receivedAt,
      experimentId:assessment.experimentId,candidateId:assessment.candidateId,candidateKey:assessment.candidateKey,
      episodeId:assessment.episodeId,cohort:assessment.cohort,symbol:assessment.symbol,side:assessment.side,
      decisionAt:assessment.decisionAt,episodeOriginAt:assessment.episodeOriginAt,episodeAgeMs:assessment.episodeAgeMs,
      episodeState:assessment.episodeState,originRegime:assessment.originRegime,orderTimeRegime:assessment.orderTimeRegime,
      originToOrderRegime:assessment.originToOrderRegime,configHash:assessment.configHash,
      marketSnapshotId:assessment.marketSnapshotId,eligibilityChecks:assessment.eligibilityChecks,
      directionContext:assessment.directionContext,breadthPercentile:assessment.breadthPercentile,
      breadthCategory:assessment.breadthCategory,structureAtBirth:assessment.structureAtBirth,
      permissionAtBirth:assessment.permissionAtBirth,exhaustionContext:assessment.exhaustionContext,
      quoteRequestedAt:requestedAt,quoteReceivedAt:receivedAt,quoteLatencyMs:receivedAt-requestedAt,
      quoteTimestampPrecision:'LOCAL_REQUEST_AND_RECEIPT; EXCHANGE_TICK_TIMESTAMP_UNAVAILABLE',
      firstPostDecisionQuote:true,bid:quote.bid,ask:quote.ask,mark:quote.mark,last:quote.last,
      spreadAbs:round(quote.ask-quote.bid),spreadBps:round(10000*(quote.ask-quote.bid)/((quote.ask+quote.bid)/2)),
      frozenSl,frozenTp:assessment.plannedTp,settings:assessment.settings,
      early:{armId:digest([assessment.experimentId,'EARLY']),entryTime:receivedAt,entryPrice:round(executableEarlyEntry),
        executableSide:'ASK',spreadIncluded:true,additionalAdverseSlippageBps:slipBps,entryFeeRole:'TAKER',sizing:earlySizing},
      control:{armId:digest([assessment.experimentId,'CONTROL']),createdAt:assessment.decisionAt,
        plannedEntry:executableControlEntry,entryFeeRole:'MAKER',entryBufferBps:assessment.settings.entryBufferBps,
        entryWindowMin:assessment.settings.entryWindowMin,fillSemantics:'EXISTING_PULLBACK_LIMIT_CONTROL',sizing:controlSizing},
      geometryComparable:executableEarlyEntry>frozenSl&&executableEarlyEntry<assessment.plannedTp&&
        executableControlEntry>frozenSl&&executableControlEntry<assessment.plannedTp,
      incompleteData:!(earlySizing.ok&&controlSizing.ok)};
    const persisted=append(pair,pair.at);
    pendingQuotes.delete(assessment.experimentId);
    if (persisted&&pair.geometryComparable&&earlySizing.ok&&controlSizing.ok) {pending.set(pair.experimentId,pair);trimPending();}
    else append({version:VERSION,kind:'incomplete',eventId:digest(['invalid-pair',pair.experimentId]),at:Date.now(),
      experimentId:pair.experimentId,episodeId:pair.episodeId,reason:'INVALID_GEOMETRY_OR_SIZING',incompleteData:true});
  } catch(e) {
    pendingQuotes.delete(assessment.experimentId);
    append({version:VERSION,kind:'incomplete',eventId:digest(['quote-failed',assessment.experimentId]),at:Date.now(),
      experimentId:assessment.experimentId,candidateId:assessment.candidateId,episodeId:assessment.episodeId,
      symbol:assessment.symbol,reason:'FIRST_POST_DECISION_QUOTE_UNAVAILABLE',detail:String(e.message).slice(0,160),incompleteData:true});
  } finally {quoteInFlight.delete(assessment.experimentId);}
}
function pumpQuotes() {
  const capacity=Math.max(0,4-quoteInFlight.size);
  for (const row of [...pendingQuotes.values()].slice(0,capacity))
    acquireQuote(row).catch(e=>logger.warn('research','Early-entry quote acquisition failed',{symbol:row.symbol,error:e.message}));
}
async function fetchBars(pair) {
  const start=Math.floor(pair.decisionAt/60000)*60000;
  const end=pair.decisionAt+(pair.settings.entryWindowMin+pair.settings.maxHoldMin+3)*60000;
  const byTs=new Map();
  for (let from=start;from<end;from+=999*60000) {
    const to=Math.min(end,from+999*60000);
    const result=await capture.researchGet('/v5/market/kline',{category:'linear',symbol:pair.symbol,interval:'1',start:from,end:to,limit:1000},pair.settings.testnet);
    for (const x of result?.list||[]) {
      const row={ts:finite(x[0]),open:finite(x[1]),high:finite(x[2]),low:finite(x[3]),close:finite(x[4])};
      if (row.ts!==null&&row.high!==null&&row.low!==null&&row.close!==null) byTs.set(row.ts,row);
    }
  }
  return [...byTs.values()].sort((a,b)=>a.ts-b.ts);
}
function closeAt(bars,originAt,mins) {
  const cutoff=originAt+mins*60000;
  const rows=bars.filter(x=>x.ts+60000<=cutoff);
  return rows.length?rows.at(-1).close:null;
}
function dirReturn(entry,close,side) {return entry>0&&close>0?round((side==='BUY'?1:-1)*(close/entry-1)):null;}
function armOutcome({pair,bars,kind,entry,entryTime,filled=true,fillAt=null}) {
  const buy=pair.side==='BUY',dir=buy?1:-1,sl=pair.frozenSl,tp=pair.frozenTp;
  const riskPx=Math.abs(entry-sl),tpBuffer=tp*(pair.settings.tpThroughBps||0)/10000;
  if (!filled) return {filled:false,fillAt:null,entryPrice:null,tpSlOutcome:'ENTRY_NOT_FILLED',netR:0,
    directionalReturn15m:null,directionalReturn30m:null,directionalReturn60m:null,mfeR:null,maeR:null,
    timeToMfeMin:null,timeToMaeMin:null,ambiguity:false,incompleteData:false};
  const origin=fillAt??entryTime;
  const start=kind==='EARLY'?Math.ceil(origin/60000)*60000:Math.floor(origin/60000)*60000;
  const end=origin+pair.settings.maxHoldMin*60000;
  const usable=bars.filter(x=>x.ts>=start&&x.ts<end);
  let outcome='NEITHER',resolvedAt=null,exitPrice=null,ambiguity=false;
  for (const c of usable) {
    const hitTp=buy?c.high>=tp+tpBuffer:c.low<=tp-tpBuffer;
    const hitSl=buy?c.low<=sl:c.high>=sl;
    if (hitTp&&hitSl) {outcome='BOTH_SAME_MINUTE_STOP_FIRST';resolvedAt=c.ts;ambiguity=true;exitPrice=buy?sl*(1-(pair.settings.adverseSlippageBps||0)/10000):sl*(1+(pair.settings.adverseSlippageBps||0)/10000);break;}
    if (hitSl) {outcome='SL_FIRST';resolvedAt=c.ts;exitPrice=buy?sl*(1-(pair.settings.adverseSlippageBps||0)/10000):sl*(1+(pair.settings.adverseSlippageBps||0)/10000);break;}
    if (hitTp) {outcome='TP_FIRST';resolvedAt=c.ts;exitPrice=tp;break;}
  }
  if (exitPrice===null&&usable.length) {outcome='NEITHER_MAX_HOLD';resolvedAt=end;exitPrice=usable.at(-1).close;}
  const excursion=resolvedAt===null?usable:usable.filter(x=>x.ts<=resolvedAt);
  let mfeR=null,maeR=null,timeToMfeMin=null,timeToMaeMin=null;
  if (riskPx>0&&excursion.length) {
    const fav=excursion.map(x=>({at:x.ts,v:dir>0?x.high-entry:entry-x.low}));
    const adv=excursion.map(x=>({at:x.ts,v:dir>0?entry-x.low:x.high-entry}));
    const mf=fav.reduce((a,x)=>x.v>a.v?x:a,fav[0]),ma=adv.reduce((a,x)=>x.v>a.v?x:a,adv[0]);
    mfeR=round(Math.max(0,mf.v)/riskPx);maeR=round(Math.max(0,ma.v)/riskPx);
    timeToMfeMin=round((mf.at-origin)/60000);timeToMaeMin=round((ma.at-origin)/60000);
  }
  const inFee=(kind==='EARLY'?pair.settings.takerFeePct:pair.settings.makerFeePct)||0;
  const outFee=pair.settings.takerFeePct||0;
  const netR=exitPrice!==null&&riskPx>0?round((dir*(exitPrice-entry)-entry*inFee/100-exitPrice*outFee/100)/riskPx):null;
  return {filled:true,fillAt:origin,entryPrice:entry,stop:sl,target:tp,tpSlOutcome:outcome,resolvedAt,exitPrice,
    directionalReturn15m:dirReturn(entry,closeAt(bars,origin,15),pair.side),
    directionalReturn30m:dirReturn(entry,closeAt(bars,origin,30),pair.side),
    directionalReturn60m:dirReturn(entry,closeAt(bars,origin,60),pair.side),mfeR,maeR,timeToMfeMin,timeToMaeMin,
    netR,ambiguity,entryMinuteExcluded:kind==='EARLY',incompleteData:exitPrice===null};
}
function labelPair(pair,bars) {
  const buy=pair.side==='BUY',buffer=pair.control.plannedEntry*(pair.settings.entryBufferBps||0)/10000;
  const expires=pair.control.createdAt+pair.settings.entryWindowMin*60000;
  const fillBar=bars.find(c=>c.ts>=pair.control.createdAt&&c.ts<=expires&&
    (buy?c.low<=pair.control.plannedEntry-buffer:c.high>=pair.control.plannedEntry+buffer));
  const early=armOutcome({pair,bars,kind:'EARLY',entry:pair.early.entryPrice,entryTime:pair.early.entryTime});
  const control=armOutcome({pair,bars,kind:'CONTROL',entry:pair.control.plannedEntry,
    entryTime:pair.control.createdAt,filled:!!fillBar,fillAt:fillBar?.ts??null});
  early.sizing=pair.early.sizing;early.entryFeeRole='TAKER';
  control.sizing=pair.control.sizing;control.entryFeeRole='MAKER';
  return {version:VERSION,kind:'paired_outcome',eventId:digest(['outcome',pair.experimentId]),at:Date.now(),
    experimentId:pair.experimentId,candidateId:pair.candidateId,candidateKey:pair.candidateKey,episodeId:pair.episodeId,
    cohort:pair.cohort,symbol:pair.symbol,side:pair.side,decisionAt:pair.decisionAt,
    configHash:pair.configHash,marketSnapshotId:pair.marketSnapshotId,episodeOriginAt:pair.episodeOriginAt,
    episodeAgeMs:pair.episodeAgeMs,episodeState:pair.episodeState,originRegime:pair.originRegime,
    orderTimeRegime:pair.orderTimeRegime,originToOrderRegime:pair.originToOrderRegime,
    directionContext:pair.directionContext,breadthPercentile:pair.breadthPercentile,breadthCategory:pair.breadthCategory,
    structureAtBirth:pair.structureAtBirth,permissionAtBirth:pair.permissionAtBirth,
    exhaustionContext:pair.exhaustionContext,earlyQuote:{requestedAt:pair.quoteRequestedAt,receivedAt:pair.quoteReceivedAt,
      bid:pair.bid,ask:pair.ask,spreadAbs:pair.spreadAbs,spreadBps:pair.spreadBps,
      additionalAdverseSlippageBps:pair.early.additionalAdverseSlippageBps},frozenSl:pair.frozenSl,frozenTp:pair.frozenTp,
    controlPlannedEntry:pair.control.plannedEntry,
    controlExpiresAt:pair.control.createdAt+pair.settings.entryWindowMin*60000,
    settings:pair.settings,early,control,barsEvaluated:bars.length,
    armFairness:'SAME_FROZEN_STOP_TARGET_CONFIG_RISK_BASIS_HOLD_AND_EXIT_MODEL; ENTRY_ROLE_DIFFERS_BY_DESIGN',
    ambiguityOrIncomplete:early.ambiguity||control.ambiguity||early.incompleteData||control.incompleteData};
}
async function resolveDue(limit=2) {
  if (resolving) return;
  resolving=true;
  try {
    const now=Date.now();
    pumpQuotes();
    if (now-lastPrune>3600000) {lastPrune=now;prune(now);}
    const due=[...pending.values()].filter(x=>now>=x.decisionAt+(x.settings.entryWindowMin+x.settings.maxHoldMin+2)*60000)
      .sort((a,b)=>a.decisionAt-b.decisionAt).slice(0,limit);
    for (const pair of due) try {
      const bars=await fetchBars(pair);
      const expected=Math.min(60,pair.settings.maxHoldMin);
      if (bars.filter(x=>x.ts>=Math.ceil(pair.early.entryTime/60000)*60000).length<expected) continue;
      const requiredThrough=pair.decisionAt+(pair.settings.entryWindowMin+pair.settings.maxHoldMin)*60000;
      if (!bars.length||bars.at(-1).ts+60000<requiredThrough) continue;
      const row=labelPair(pair,bars);
      if (append(row,row.at)) pending.delete(pair.experimentId);
    } catch(e) {logger.warn('research','Early-entry outcome resolution failed',{symbol:pair.symbol,error:e.message});}
  } finally {resolving=false;}
}
function start() {
  if (timer) return;
  timer=setInterval(()=>resolveDue().catch(e=>logger.warn('research','Early-entry resolver failed',{error:e.message})),30000);
  if (timer.unref) timer.unref();
  pumpQuotes();
}
function stop() {if (timer) clearInterval(timer);timer=null;}

module.exports={VERSION,observeCandidate,evaluateEligibility,labelPair,armOutcome,resolveDue,files,prune,start,stop,
  _test:{exactDirectionContext,exactBreadthPercentile,structureTag,btcBuyPermission}};
