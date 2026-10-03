'use strict';
// Pure observer functions. No signal/gate/order dependencies and no mutable control inputs.
const {round,economics}=require('./v3Geometry');
const crypto=require('crypto');
const VERSION='V3.4A_MEASUREMENT_V1',MINUTE=60000,TTL=120000;
const id=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0,24);
const ratio=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&b>0?a/b:null;
const mean=a=>a.length?a.reduce((n,x)=>n+x,0)/a.length:null;
function series(bars,interval,cutoff) {
  const b=(bars||[]).filter(x=>x.ts+interval<=cutoff).sort((a,b)=>a.ts-b.ts);
  const samples=[];
  for(let i=1;i<b.length;i++) {
    const c=b[i],p=b[i-1];
    if(c.ts-p.ts!==interval||![c.high,c.low,c.close,p.close].every(Number.isFinite)||Math.min(c.close,p.close)<=0)continue;
    samples.push({at:c.ts+interval,ret:Math.log(c.close/p.close),tr:Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close))});
  }
  return samples;
}
function noise({minuteBars=[],bars15=[],cutoff,sourceAt=null,receivedAt=null,capturedAt=null}) {
  const s=series(minuteBars,MINUTE,cutoff).slice(-20),a=series(bars15,15*MINUTE,cutoff).slice(-14);
  const contiguous=s.length===20&&s.every((x,i)=>!i||x.at-s[i-1].at===MINUTE);
  const p=minuteBars.filter(x=>x.ts+MINUTE<=cutoff).sort((a,b)=>a.ts-b.ts).at(-1)?.close;
  const rms=contiguous?Math.sqrt(mean(s.map(x=>x.ret*x.ret))):null;
  const stats=a=>{const avg=mean(a);return {count:a.length,mean:avg,rms:Math.sqrt(mean(a.map(x=>x*x))),
    populationStd:Math.sqrt(mean(a.map(x=>(x-avg)**2))),min:Math.min(...a),max:Math.max(...a)};};
  return {definition:'ATR_SMA_TR14_RV_RMS_LOG_RETURN20_TR_MEAN20_V1',cutoff,
    sourceAt,receivedAt,capturedAt,physicallyAvailableAtCutoff:receivedAt!==null&&receivedAt<=cutoff,
    firstReturnAt:contiguous?s[0].at:null,lastReturnAt:contiguous?s.at(-1).at:null,
    returns20:contiguous?s.map(x=>x.ret):null,trueRanges20:contiguous?s.map(x=>x.tr):null,
    compactStats:contiguous?{returns:stats(s.map(x=>x.ret)),trueRanges:stats(s.map(x=>x.tr))}:null,
    atr1m:contiguous?mean(s.slice(-14).map(x=>x.tr)):null,
    atr15m:a.length===14&&a.every((x,i)=>!i||x.at-a[i-1].at===15*MINUTE)?mean(a.map(x=>x.tr)):null,
    realizedVolatility:rms,realizedNoisePrice:rms===null?null:p*rms,trueRangeNoise:contiguous?mean(s.map(x=>x.tr)):null,
    sampleCount:s.length,status:contiguous?'AVAILABLE':'INSUFFICIENT_PRIOR_MINUTES'};
}
function quote(t,at,capturedAt=at) {
  const receivedAt=t?.receivedAt??t?.observedAt??null,sourceAt=t?.sourceAt??null;
  const valid=t&&t.bid>0&&t.ask>=t.bid&&receivedAt!==null&&receivedAt<=at&&
    (sourceAt===null||sourceAt<=receivedAt+5000)&&at-receivedAt<=TTL;
  const mid=valid?(t.bid+t.ask)/2:null,spread=valid?t.ask-t.bid:null;
  return {status:valid?'AVAILABLE':'UNAVAILABLE',bid:valid?t.bid:null,ask:valid?t.ask:null,mid,
    spread,spreadBps:mid?spread/mid*10000:null,sourceAt,receivedAt,capturedAt,ageMs:receivedAt===null?null:at-receivedAt,
    source:t?.source||'BYBIT_TICKER',sourceTimePrecision:sourceAt===null?'UNAVAILABLE':'RESPONSE_ENVELOPE_SERVER_TIME',depth:null};
}
function normalized(distance,price,n,q) {
  return {price:distance,pct:ratio(distance,price)===null?null:100*distance/price,
    atr1m:ratio(distance,n?.atr1m),atr15m:ratio(distance,n?.atr15m),
    realizedVolatility:ratio(distance,n?.realizedNoisePrice),trueRange:ratio(distance,n?.trueRangeNoise),spreads:ratio(distance,q?.spread)};
}
function spatial(selected,ob,poc,entry,tick,n) {
  const distance=(a,b)=>a&&b?Math.max(0,a.zoneLow-b.zoneHigh,b.zoneLow-a.zoneHigh):null;
  const point=selected?{zoneLow:selected.price,zoneHigh:selected.price}:null;
  const metrics=x=>({...normalized(x,entry,n,null),ticks:ratio(x,tick)});
  const describe=x=>x?{id:x.id,zoneLow:x.zoneLow,zoneHigh:x.zoneHigh,width:x.zoneHigh-x.zoneLow,knownAt:x.knownAt,ageMs:x.ageMs,active:x.active}:null;
  const sd=distance(point,poc),od=distance(ob,poc);
  return {selectedToPoc:metrics(sd),obToPoc:metrics(od),overlap:od===null?null:od===0,
    inventoryPresence:!!ob&&!!poc,selected:describe(selected),ob:describe(ob),poc:describe(poc)};
}
function inventory(row,n) {
  const g=row.geometry||{},d=row.side==='BUY'?1:-1,entry=g.entryPrice??row.referencePrice,tick=g.tickSize;
  if(!g.reactionLevel||!Number.isFinite(g.entryPrice))return [];
  const all=row.research?.levels||[],priorExtreme=d===1?row.research?.premiumDiscount?.rangeHigh:row.research?.premiumDiscount?.rangeLow;
  return all.filter(l=>l.active&&l.id!==g.reactionLevel?.id&&l.knownAt<=row.closedBarOpenAt&&
    (l.type==='POC'||l.direction===(d===1?'SELL':'BUY')))
    .map(l=>({level:l,price:tick?round(d===1?l.zoneLow:l.zoneHigh,tick,d!==1):d===1?l.zoneLow:l.zoneHigh}))
    .filter(x=>d*(x.price-entry)>0).sort((a,b)=>Math.abs(a.price-entry)-Math.abs(b.price-entry)||a.level.id.localeCompare(b.level.id))
    .slice(0,12).map((x,i)=>({definition:x.level,levelId:x.level.id,price:x.price,knownAt:x.level.knownAt,
      active:x.level.active,invalidatedAt:x.level.invalidatedAt??null,ageMs:row.decisionAt-x.level.knownAt,rank:i+1,
      selectionReason:'NEAREST_ACTIVE_INDEPENDENT_OPPOSING_BEFORE_REACTION_V1',selectedControl:x.level.id===g.objectiveLevel?.id,
      distance:{...normalized(Math.abs(x.price-entry),entry,n,null),rawR:ratio(Math.abs(x.price-entry),Math.abs(entry-g.invalidationPrice))},
      priorFavorableExtreme:priorExtreme??null,beyondPriorExtreme:Number.isFinite(priorExtreme)?d*(x.price-priorExtreme)>0:null,
      precedingImpulse:{source:'LATEST_CONFIRMED_OPPOSITE_SWING_RANGE_PROXY',
        distance:row.research?.premiumDiscount?.rangeHigh-row.research?.premiumDiscount?.rangeLow||null,
        highAnchorAt:row.research?.premiumDiscount?.highAnchorAt??null,lowAnchorAt:row.research?.premiumDiscount?.lowAnchorAt??null}}));
}
function exactEvent(row,n,candles) {
  const l=row.geometry?.reactionLevel;
  // Only an OB has an exact BOS identity in the frozen engine. Never infer CHOCH from trend labels.
  if(l?.type!=='ORDER_BLOCK'||!Number.isFinite(l.bosAt)||l.bosAt>row.closedBarOpenAt)return {status:'UNAVAILABLE',source:'FROZEN_V3_OB_BOS',eventId:null};
  const b=candles.find(c=>c.ts+15*MINUTE===l.bosAt),p=candles.find(c=>c.ts===l.brokenSwingAt);
  const breakPrice=l.direction==='BUY'?p?.high:p?.low,d=l.direction==='BUY'?1:-1;
  const displacement=b&&Number.isFinite(breakPrice)?d*(b.close-breakPrice):null;
  // Event-normalization baseline is frozen before the breaking candle, not the current decision ATR.
  const eventAtr=noise({bars15:candles,cutoff:l.bosAt-15*MINUTE}).atr15m;
  return {status:'AVAILABLE',eventId:id([row.symbol,l.bosAt,l.brokenSwingAt,l.direction]),type:'BOS',direction:l.direction,
    breakPrice:breakPrice??null,displacementPct:ratio(displacement,breakPrice)===null?null:100*displacement/breakPrice,
    displacementAtr:ratio(displacement,eventAtr),knownAt:l.bosAt,confirmedAt:l.bosAt,joinAgeMs:row.decisionAt-l.bosAt,source:'FROZEN_V3_OB_BOS'};
}
function momentum(candles,side,at) {
  const b=candles.filter(c=>c.ts+15*MINUTE<=at),d=side==='BUY'?1:side==='SELL'?-1:null,last=b.at(-1);
  const ret=(k,offset=0)=>d!==null&&b.length>k+offset?d*(b.at(-1-offset).close/b.at(-1-offset-k).close-1)*100:null;
  const baseline=b.slice(-21,-1),turn=mean(baseline.map(c=>c.turnover)),vol=mean(baseline.map(c=>c.volume));
  return {definition:'DIRECTION_SIGNED_CLOSE_RETURN_3_12_ACCEL_R3_MINUS_PRIOR_R3_15M_V1',
    momentum3:ret(3),momentum12:ret(12),acceleration:ret(3)!==null&&ret(3,3)!==null?ret(3)-ret(3,3):null,
    turnoverShock:baseline.length===20?ratio(last?.turnover,turn):null,volumeShock:baseline.length===20?ratio(last?.volume,vol):null,
    shockDefinition:'LATEST_COMPLETED_BAR_OVER_MEAN_PRIOR20_EXCLUDING_LATEST',sourceAt:last?last.ts+15*MINUTE:null,capturedAt:at};
}
function decision(row,{candles=[],minute=null,ticker=null,btcRegime=null,marketSnapshot=null,universe=[],structuralEvents=[],candleStamp=null}={}) {
  const available=minute&&minute.receivedAt<=row.decisionAt?minute:null;
  const n=noise({minuteBars:available?.bars||[],bars15:candles,cutoff:row.closedBarOpenAt??row.decisionAt,
    sourceAt:available?.sourceAt??null,receivedAt:available?.receivedAt??null,capturedAt:row.decisionAt});
  n.atr15mSource={sourceAt:candleStamp?.sourceAt??null,receivedAt:candleStamp?.receivedAt??null,capturedAt:row.decisionAt,
    physicalAvailability:candleStamp?'RECEIVED_BEFORE_DECISION':'ALREADY_FETCHED_CONTROL_INPUT_RECEIPT_TIME_UNAVAILABLE'};
  Object.assign(n,{measuredAtDecision:true,cachedAtDecision:Boolean(available),positiveAtr:Number.isFinite(n.atr1m)&&n.atr1m>0,
    usableAtDecision:n.status==='AVAILABLE'&&n.atr1m>0&&available?.receivedAt<=row.decisionAt,
    availabilityReason:!available?'CACHE_RECEIPT_UNAVAILABLE':n.status==='INSUFFICIENT_PRIOR_MINUTES'?'INSUFFICIENT_PRIOR_MINUTES':n.atr1m>0?'USABLE':'NON_POSITIVE_ATR',
    sourceReceipt:available?{sourceAt:available.sourceAt,receivedAt:available.receivedAt}:null,recoveryJoin:{symbol:row.symbol,subsystem:'PRIOR_NOISE',retryCursor:null}});
  const q=quote(ticker,row.decisionAt),g=row.geometry||{},entry=g.entryPrice??row.referencePrice;
  const ranked=inventory(row,n),poc=(row.research?.levels||[]).find(l=>l.type==='POC'),ob=g.reactionLevel?.type==='ORDER_BLOCK'?g.reactionLevel:
    (row.research?.levels||[]).filter(l=>l.type==='ORDER_BLOCK'&&l.active&&l.direction===row.side).sort((a,b)=>Math.abs(a.price-entry)-Math.abs(b.price-entry))[0];
  const d=row.side==='BUY'?1:-1,b=marketSnapshot,ba=b?.observedAt??b?.capturedAt??null;
  const btcSign=btcRegime?.regime?.startsWith('BULL')?1:btcRegime?.regime?.startsWith('BEAR')?-1:0;
  const breadthAvailable=ba!==null&&ba<=row.decisionAt&&row.decisionAt-ba<=17*MINUTE&&!!b?.breadthUniverse;
  const event=structuralEvents.filter(e=>e.direction===row.side&&e.knownAt<=row.closedBarOpenAt&&e.receivedAt<=row.decisionAt)
    .sort((a,b)=>b.knownAt-a.knownAt)[0];
  const executableQuote=row.side==='BUY'?q.ask:q.bid,slipped=executableQuote?executableQuote*(1+d*(g.costs?.entrySlippageBps??3)/10000):null;
  return {version:VERSION,measuredAt:row.decisionAt,researchOnly:true,noise:n,quote:q,
    stop:normalized(Number.isFinite(g.invalidationPrice)?Math.abs(entry-g.invalidationPrice):null,entry,n,q),intendedEntry:g.entryPrice??null,
    intendedRawRR:g.rawRR??null,intendedCostRR:g.costAdjustedRR??null,
    decisionEntryDecomposition:{quoteBase:executableQuote??null,slippagePrice:slipped===null?null:slipped-executableQuote,
      tickRoundingPrice:slipped===null?null:entry-slipped,modeledEntry:entry,slippageBps:g.costs?.entrySlippageBps??null},
    objectiveInventory:ranked,objectiveInventoryCount:ranked.length,inventoryLimit:12,
    nearestObjective:{policy:'NEAREST_ADMISSIBLE_INDEPENDENT_V1',levelId:ranked[0]?.levelId??null,
      price:ranked[0]?.price??null,identicalToControl:ranked[0]?.price===g.objectivePrice,researchOnly:true},
    spatial:spatial(g.reactionLevel,ob,poc,entry,g.tickSize,n),structuralEvent:event?
      {...event,status:'AVAILABLE',joinAgeMs:row.decisionAt-event.knownAt}:exactEvent(row,n,candles),
    momentum:momentum(candles,row.side,row.decisionAt),premiumDiscount:row.research?.premiumDiscount??null,
    btc:{regime:btcRegime?.regime??null,alignedStrength:btcRegime?.observedAt<=row.decisionAt?d*btcSign*(btcRegime?.strength??0):null,
      alignedReturn3:ba!==null&&ba<=row.decisionAt&&Number.isFinite(b?.btcReturn3)?d*b.btcReturn3:null,
      sourceAt:btcRegime?.closedBarAt??null,receivedAt:btcRegime?.observedAt??null,ageMs:btcRegime?.observedAt?row.decisionAt-btcRegime.observedAt:null},
    breadth:{status:breadthAvailable?'AVAILABLE':'UNAVAILABLE_OR_STALE',value:breadthAvailable?b.directionalBreadth??null:null,momentum:breadthAvailable?b.breadthMomentum??null:null,
      sourceAt:b?.barOpenAt?b.barOpenAt+15*MINUTE:null,receivedAt:ba,capturedAt:row.decisionAt,ageMs:ba===null?null:row.decisionAt-ba,
      universeId:b?.breadthUniverse?id(b.breadthUniverse.symbols):null,universe:b?.breadthUniverse??null,
      definition:'100*(POSITIVE_R1_MINUS_NEGATIVE_R1)/VALID_NON_BTC_COUNT; MOMENTUM_CURRENT_MINUS_PRIOR',snapshotId:b?.marketSnapshotId??null},
    observers:{Groq:{status:'UNAVAILABLE',availabilityAtDecision:false},Alibaba:{status:'UNAVAILABLE',availabilityAtDecision:false},
      MI:{status:'UNAVAILABLE_NO_LOCAL_CAUSAL_FEED',availabilityAtDecision:false}}};
}
function observer(r,provider,capturedAt,decisionAt=null) {
  const time=x=>{const v=typeof x==='number'?x:Date.parse(x);return Number.isFinite(v)?v:null;};
  const completedAt=time(r.completed_at_utc),receivedAt=time(r.available_to_system_at_utc),watermark=time(r.input_watermark_at_utc||r.requested_at_utc);
  const age=decisionAt!==null&&receivedAt!==null?decisionAt-receivedAt:null;
  const structured={};for(const k of ['continuation','exhaustion','confidence'])if(r.decision?.[k]!==undefined)structured[k]=r.decision[k];
  return {provider,candidateId:r.candidate_id??null,requestId:r.request_id??null,inputWatermark:watermark,
    inputWatermarkDefinition:r.input_watermark_at_utc?'PROVIDER_EXPLICIT':'REQUEST_TIME_UPPER_BOUND',inputHash:r.input_snapshot_hash??null,
    model:r.model??null,promptVersion:r.prompt_version??null,promptHash:r.prompt_hash??null,providerVersion:r.schema_version??null,
    completedAt,receivedAt,capturedAt,ttlMs:TTL,ageMs:age,status:r.status??'UNAVAILABLE',structured,
    availabilityAtDecision:age!==null&&age>=0&&age<=TTL&&watermark!==null&&completedAt!==null&&completedAt<=receivedAt&&capturedAt<=decisionAt&&watermark<=decisionAt,
    presentAtDecision:age!==null&&age>=0&&capturedAt<=decisionAt,
    usableAtDecision:r.status==='OK'&&age!==null&&age>=0&&age<=TTL&&watermark!==null&&completedAt!==null&&completedAt<=receivedAt&&capturedAt<=decisionAt&&watermark<=decisionAt,
    requestHash:r.request_hash??null,responseSchemaHash:r.response_schema_hash??null,
    providerFailureKind:r.api_error?.code==='json_validate_failed'?'GENERATED_OUTPUT_SCHEMA_VIOLATION':r.status==='API_400_SCHEMA'?'SCHEMA_ERROR_UNPROVEN_REQUEST_OR_GENERATION':null,
    schemaViolation:r.api_error?.code==='json_validate_failed'?{code:r.api_error.code,field:(r.api_error.message||'').match(/'\/(reason_notes|evidence_keys|missing_or_stale|reason_codes|rationale_short)(?:\/\d+)?'/)?.[1]??null,
      observedLength:Number((r.api_error.message||'').match(/got (\d+)/)?.[1])||null,allowedLength:Number((r.api_error.message||'').match(/want (\d+)/)?.[1])||null}:null,
    executionAuthority:false};
}
module.exports={VERSION,TTL,id,ratio,noise,quote,normalized,spatial,inventory,exactEvent,momentum,decision,observer};
