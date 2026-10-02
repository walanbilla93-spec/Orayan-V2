'use strict';
// Composition around byte-frozen V3.3 simulator; measurements never influence control.
const control=require('./v3Trades'),m=require('./v34Measurements'),{economics,round}=require('./v3Geometry');
const thresholds=[.5,1,1.5,2,3,4,5];
function init(t,measurement) {
  const nearest=measurement?.nearestObjective;
  const g=t.geometry;
  const target=nearest?.price,e=target?economics(g.entryPrice,g.invalidationPrice,target,t.side,g.costs):null;
  return {version:m.VERSION,decision:measurement??null,fill:null,mfeAt:null,maeAt:null,
    rawTouches:{},costRiskTouches:{},terminalTouches:{},breakEven:null,structuralProgress:null,
    managementPolicy:'CLOSED_1M_CLOSE_CROSSES_FROZEN_REACTION_ZONE_COST_BE_V1',
    nearestArm:nearest&&e?.rewardPerUnit>0&&e.costAdjustedRR>=g.minCostAdjustedRR?
      {policy:nearest.policy,researchOnly:true,identicalToControl:nearest.identicalToControl,status:'PENDING',
        trade:{...JSON.parse(JSON.stringify(t)),geometry:{...JSON.parse(JSON.stringify(g)),objectivePrice:target},executionAllowed:false}}:
      {researchOnly:true,status:'INVALID_GEOMETRY',reason:'NEAREST_OBJECTIVE_UNAVAILABLE_OR_INADMISSIBLE'}};
}
function timestamp(b,receivedAt,kind='WITHIN_MINUTE') {return {barOpenAt:b.ts,earliestAt:b.ts,latestAt:b.ts+60000,
  knownAt:b.ts+60000,receivedAt,precision:kind};}
function fill(t,b,receivedAt,context) {
  const g=t.geometry,d=t.side==='BUY'?1:-1,slipped=b.open*(1+d*g.costs.entrySlippageBps/10000);
  const modeled=round(slipped,g.tickSize,d===1),q=m.quote(context?.quoteAt?context.quoteAt(b.ts):context?.quote,b.ts,receivedAt);
  q.semantic=q.status!=='AVAILABLE'?'MISSING_FILL_QUOTE':'CACHED_PRE_FILL_QUOTE';
  // A historical OHLC modeled fill has no synchronized exchange fill quote.
  q.isExactFillBidAsk=false;
  q.missingReason=q.status==='AVAILABLE'?null:!q.receivedAt?'NO_CAUSAL_QUOTE_RECEIPT':q.ageMs>120000?'CACHED_QUOTE_TOO_OLD':'INVALID_OR_FUTURE_QUOTE';
  const n=m.noise({minuteBars:context?.priorBars||[],bars15:context?.bars15||[],cutoff:Math.min(b.ts,t.decisionAt-(t.decisionAt%60000)),
    sourceAt:context?.priorSourceAt??null,receivedAt:context?.priorReceivedAt??receivedAt,capturedAt:receivedAt});
  // Noise for fill uses completed pre-fill bars, but cannot include the original reaction candle.
  const validNoise=t.research34?.decision?.noise?.cutoff;
  if(validNoise!==undefined&&validNoise!==null)Object.assign(n,m.noise({minuteBars:context?.priorBars||[],
    bars15:context?.bars15||[],cutoff:Math.min(b.ts,validNoise),sourceAt:context?.priorSourceAt??null,
    receivedAt:context?.priorReceivedAt??receivedAt,capturedAt:receivedAt}));
  n.atr15m=t.research34?.decision?.noise?.atr15m??n.atr15m;
  n.atr15mDefinition='FROZEN_PRE_REACTION_DECISION_BASELINE';
  return {intendedEntry:g.entryPrice,nextCompleteMinuteOpen:b.open,modeledFill:modeled,
    slippageBps:g.costs.entrySlippageBps,slippagePrice:slipped-b.open,tickRoundingPrice:modeled-slipped,
    marketMoveBps:d*(b.open-g.entryPrice)/g.entryPrice*10000,adverseFillMoveBps:d*(modeled-g.entryPrice)/g.entryPrice*10000,
    favorableFillMoveBps:-d*(modeled-g.entryPrice)/g.entryPrice*10000,
    gapThroughStop:d*(b.open-g.invalidationPrice)<=0,gapThroughTarget:d*(b.open-g.objectivePrice)>=0,
    geometryRecheck:true,geometryValid:t.status!=='CANCELLED',fillBidAskAvailable:q.isExactFillBidAsk,cachedPreFillQuoteAvailable:q.status==='AVAILABLE',quote:q,
    noise:n,stop:m.normalized(Math.abs(modeled-g.invalidationPrice),modeled,n,q),rawRR:t.fillEconomics?.rawRR??null,
    costRR:t.fillEconomics?.costAdjustedRR??null,fillAt:b.ts,receivedAt,capturedAt:receivedAt,
    historicalBarReconstruction:true};
}
function step(input,bars,now,context={}) {
  if(!input.research34)return control.step(input,bars,now);
  const frozen=control.step(input,bars,now);
  const receivedAt=context.receivedAt??now;
  let t=JSON.parse(JSON.stringify(input));const events=[],path=[];
  const priorBars=(context.priorBars||[]).slice(-80);
  for(const b of bars) {
    if(b.ts<(t.lastBarAt===null?t.eligibleFromAt:t.lastBarAt+60000)||b.ts+60000>now)continue;
    if(control.terminal(t)&&!t.research34.nearestArm?.trade)break;
    const before=JSON.parse(JSON.stringify(t)),r=control.step(t,[b],now);t=r.trade;
    events.push(...r.events.filter(e=>e!=='MARK'));
    const a=t.research34;
    if(before.status==='PENDING'&&['OPEN','CLOSED','CANCELLED'].includes(t.status))a.fill=fill(t,b,receivedAt,{...context,priorBars});
    if(t.filledAt!==null&&b.ts>=t.filledAt&&t.lastBarAt===b.ts) {
      const d=t.side==='BUY'?1:-1,favorable=Math.max(0,d===1?b.high-t.entryPrice:t.entryPrice-b.low),
        adverse=Math.max(0,d===1?t.entryPrice-b.low:b.high-t.entryPrice),raw=Math.abs(t.entryPrice-t.geometry.invalidationPrice),cost=t.fillEconomics.lossPerUnit;
      const term=t.status!=='OPEN',stamp=timestamp(b,receivedAt);
      if(!term) {
        if(t.mfePerUnit>before.mfePerUnit)a.mfeAt=stamp;if(t.maePerUnit>before.maePerUnit)a.maeAt=stamp;
      }
      for(const [name,den] of [['rawTouches',raw],['costRiskTouches',cost]])for(const k of thresholds) {
        if(favorable<k*den||a[name][k])continue;
        if(!term)a[name][k]=stamp;
        else if(t.outcome?.startsWith('TARGET')&&d*(t.geometry.objectivePrice-t.entryPrice)>=k*den)
          a[name][k]={...stamp,precision:'PROVEN_BY_TARGET_ENDPOINT_ORDER_WITHIN_MINUTE_UNKNOWN'};
        else a.terminalTouches[name+':'+k]={...stamp,ambiguous:true,reason:'TERMINAL_EXTREME_SEQUENCE_UNKNOWN'};
      }
      // Prespecified hypothetical market-stop BE: fees + adverse stop slip, zero funding baseline.
      const c=t.geometry.costs,entry=t.entryPrice;
      const requiredExit=entry*(d+c.entryFeePct/100)/(d-c.exitFeePct/100);
      const beBoundary=requiredExit/(1-d*c.stopSlippageBps/10000);
      const be=round(beBoundary,t.geometry.tickSize,d===1),reached=d*(b.close-be)>=0;
      if(!a.breakEven)a.breakEven={price:be,definition:'COST_INCLUSIVE_STOP_EXIT_FEES_SLIPPAGE_TICK_ZERO_FUNDING',
        fundingExcluded:true,firstClosedBarReach:null,terminalReachAmbiguous:null};
      if(reached&&!term&&!a.breakEven.firstClosedBarReach)a.breakEven.firstClosedBarReach=timestamp(b,receivedAt,'BAR_CLOSE');
      if(reached&&term)a.breakEven.terminalReachAmbiguous=stamp;
      const zone=t.geometry.reactionLevel,boundary=d===1?zone?.zoneHigh:zone?.zoneLow;
      if(!term&&Number.isFinite(boundary)&&d*(b.close-boundary)>0&&!a.structuralProgress)
        a.structuralProgress={...timestamp(b,receivedAt,'BAR_CLOSE'),levelId:zone.id,price:boundary,
          definition:'FIRST_POST_FILL_CLOSED_1M_BEYOND_FROZEN_REACTION_ZONE'};
      path.push({ts:b.ts,open:b.open,high:b.high,low:b.low,close:b.close,terminal:term,sourceAt:context.sourceAt??null,receivedAt});
    }
    const arm=a.nearestArm;
    if(arm?.trade&&!control.terminal(arm.trade)) {
      // Original fill and size must be identical. A bad alternate fill geometry censors only the arm.
      const ar=control.step(arm.trade,[b],now).trade;
      if(ar.filledAt!==null&&t.filledAt!==null) {
        ar.entryPrice=t.entryPrice;ar.quantity=t.quantity;ar.plannedRiskUsdt=t.plannedRiskUsdt;
      }
      arm.trade=ar;arm.status=ar.status;arm.outcome=ar.outcome;arm.rawRR=ar.fillEconomics?.rawRR??null;
      arm.costRR=ar.fillEconomics?.costAdjustedRR??null;
    }
    priorBars.push(b);if(priorBars.length>80)priorBars.shift();
    if(control.terminal(t))break;
  }
  // Preserve expiry behavior for empty batches exactly.
  if(!bars.length){const r=control.step(t,bars,now);t=r.trade;events.push(...r.events);}
  if(t.lastBarAt!==input.lastBarAt&&!events.length)events.push('MARK');
  return {trade:{...frozen.trade,research34:t.research34},events:frozen.events,path};
}
function funding(input,rows,at) {
  const t=control.funding(input,rows,at),arm=t.research34?.nearestArm;
  if(arm?.trade?.status==='CLOSED'&&arm.trade.closedAt<=t.closedAt) {
    arm.trade=control.funding(arm.trade,rows,at);arm.netR=arm.trade.realizedR;arm.netPnl=arm.trade.netPnl;
  }
  return t;
}
module.exports={init,step,funding,thresholds};
