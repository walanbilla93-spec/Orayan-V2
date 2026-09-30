'use strict';
const {round,economics}=require('./v3Geometry');
const MINUTE=60000,MAX_ACTIVE=32,MAX_RECENT=32;
const terminal=t=>!['PENDING','OPEN'].includes(t.status);
function create(row,id,capturedAt) {
  const g=row.geometry,origin=Math.max(capturedAt,row.decisionAt);
  return {tradeId:id,candidateId:row.candidateId,episodeId:row.episodeId,symbol:row.symbol,side:row.side,
    configHash:row.configHash,version:row.version,policy:g.policy,testnet:row.testnet,decisionAt:row.decisionAt,
    capturedAt,eligibleFromAt:Math.ceil(origin/MINUTE)*MINUTE,expiresAt:origin+g.entryWindowMin*MINUTE,
    geometry:g,status:'PENDING',lastBarAt:null,filledAt:null,entryPrice:null,quantity:null,
    closedAt:null,exitPrice:null,outcome:null,ambiguous:false,ambiguityCount:0,mfePerUnit:0,maePerUnit:0,
    fundingStatus:'PENDING',fundingModel:g.costs.funding,executionAllowed:false,
    excursionPrecision:'COMPLETED_NON_TERMINAL_BAR_LOWER_BOUND'};
}
function close(t,price,bar,reason,atOpen=false) {
  const d=t.side==='BUY'?1:-1,c=t.geometry.costs;
  t.status='CLOSED';t.exitPrice=price;t.exitBarOpenAt=bar.ts;t.closedAt=atOpen?bar.ts:bar.ts+MINUTE;
  t.exitTimePrecision=atOpen?'BAR_OPEN':'WITHIN_ONE_MINUTE';t.outcome=reason;
  t.grossPnl=d*(price-t.entryPrice)*t.quantity;
  t.entryFee=t.quantity*t.entryPrice*c.entryFeePct/100;t.exitFee=t.quantity*price*c.exitFeePct/100;
  t.fees=t.entryFee+t.exitFee;t.netPnlBeforeFunding=t.grossPnl-t.fees;
  t.netPnl=null;t.realizedRBeforeFunding=t.netPnlBeforeFunding/t.plannedRiskUsdt;
  t.holdMs=t.closedAt-t.filledAt;
}
function step(input,bars,now) {
  const t=JSON.parse(JSON.stringify(input)),events=[];
  if(terminal(t))return {trade:t,events};
  const g=t.geometry,d=t.side==='BUY'?1:-1;
  let expected=t.lastBarAt===null?t.eligibleFromAt:t.lastBarAt+MINUTE;
  for(const b of bars) {
    if(b.ts<expected || b.ts+MINUTE>now)continue;
    if(b.ts!==expected || ![b.ts,b.open,b.high,b.low,b.close].every(Number.isFinite) || b.low<=0 ||
      b.high<Math.max(b.open,b.close,b.low)||b.low>Math.min(b.open,b.close)) {
      t.status='DATA_GAP';t.outcome='INCOMPLETE_PATH';t.gapExpectedAt=expected;t.gapObservedAt=b.ts;
      events.push('DATA_GAP');break;
    }
    if(t.status==='PENDING') {
      if(b.ts>=t.expiresAt){t.status='EXPIRED';t.outcome='NO_FILL_BEFORE_EXPIRY';events.push('EXPIRED');break;}
      const fill=round(b.open*(1+d*g.costs.entrySlippageBps/10000),g.tickSize,t.side==='BUY');
      // Market-next-minute gap guard: don't open beyond an invalidation/target or below minimum RR.
      const e=economics(fill,g.invalidationPrice,g.objectivePrice,t.side,g.costs);
      if(!(d*(fill-g.invalidationPrice)>0 && d*(g.objectivePrice-fill)>0 && e.costAdjustedRR>=g.minCostAdjustedRR)) {
        t.status='CANCELLED';t.outcome='NEXT_OPEN_GEOMETRY_REJECTED';t.observedNextOpen=b.open;events.push('CANCELLED');break;
      }
      let qty=Math.min(g.sizing.riskUsdt/e.lossPerUnit,g.sizing.maxNotionalUsdt/fill,g.maxOrderQty||Infinity);
      qty=round(qty,g.qtyStep,false);
      if(!(qty>0) || qty<(g.minOrderQty||0)){t.status='CANCELLED';t.outcome='BELOW_MIN_QTY';events.push('CANCELLED');break;}
      t.entryPrice=fill;t.quantity=qty;t.filledAt=b.ts;t.status='OPEN';t.fillEconomics=e;
      t.plannedRiskUsdt=e.lossPerUnit*qty;t.holdDeadlineAt=b.ts+g.maxHoldMin*MINUTE;
      events.push('FILLED');
    }
    const sl=g.invalidationPrice,tp=g.objectivePrice;
    // Gap exits use the first available opening price, never an unreachable stop price.
    const gapStop=d*(b.open-sl)<=0,gapTarget=d*(b.open-tp*(1+d*g.costs.targetThroughBps/10000))>=0;
    const stop=d===1?b.low<=sl:b.high>=sl;
    const target=d===1?b.high>=tp*(1+g.costs.targetThroughBps/10000):b.low<=tp*(1-g.costs.targetThroughBps/10000);
    if(gapStop)close(t,round(b.open*(1-d*g.costs.stopSlippageBps/10000),g.tickSize,d!==1),b,'STOP_GAP',true);
    else if(gapTarget)close(t,tp,b,'TARGET_GAP',true); // Conservative limit-price execution, no favorable gap windfall.
    else if(stop) {
      if(target){t.ambiguous=true;t.ambiguityCount++;t.alternativeTargetNetPnl=
        t.quantity*(d*(tp-t.entryPrice)-(t.entryPrice+tp)*g.costs.exitFeePct/100);}
      close(t,round(sl*(1-d*g.costs.stopSlippageBps/10000),g.tickSize,d!==1),b,target?'STOP_AMBIGUOUS':'STOP');
    }else if(target)close(t,tp,b,'TARGET');
    else if(b.ts+MINUTE>=t.holdDeadlineAt)close(t,round(b.close*(1-d*g.costs.entrySlippageBps/10000),g.tickSize,d!==1),b,'TIMEOUT');
    // Terminal-bar extremes after a possible exit are unknowable; exclude them from excursion metrics.
    if(t.status==='OPEN') {
      t.mfePerUnit=Math.max(t.mfePerUnit,d===1?b.high-t.entryPrice:t.entryPrice-b.low);
      t.maePerUnit=Math.max(t.maePerUnit,d===1?t.entryPrice-b.low:b.high-t.entryPrice);
      t.lastMark=b.close;t.lastMarkAt=b.ts+MINUTE;
      t.unrealizedNetBeforeFunding=t.quantity*(d*(b.close-t.entryPrice)-(t.entryPrice+b.close)*g.costs.exitFeePct/100);
    }
    t.lastBarAt=b.ts;expected=b.ts+MINUTE;
    if(t.status==='CLOSED'){events.push('CLOSED');break;}
  }
  if(t.status==='PENDING' && now>=t.expiresAt && expected>=t.expiresAt) {
    t.status='EXPIRED';t.outcome='NO_FILL_BEFORE_EXPIRY';events.push('EXPIRED');
  }
  if(t.lastBarAt!==input.lastBarAt && !events.length)events.push('MARK');
  return {trade:t,events};
}
function funding(input,rows,availableAt) {
  const t=JSON.parse(JSON.stringify(input));let cost=0;const events=[];
  const seen=new Set();
  for(const r of rows) {
    const at=Number(r.fundingRateTimestamp),rate=Number(r.fundingRate);
    if(!Number.isFinite(at)||!Number.isFinite(rate))throw Error('INVALID_FUNDING_RESPONSE');
    if(seen.has(at))throw Error('DUPLICATE_FUNDING_RESPONSE');seen.add(at);
    if(at<t.filledAt || at>t.closedAt)continue;
    const charge=(t.side==='BUY'?1:-1)*t.quantity*t.entryPrice*rate;
    const ambiguous=at===t.filledAt || at>=t.exitBarOpenAt;
    // Exact ordering at entry/exit funding boundaries is unknowable from OHLC; worst cash flow.
    cost+=ambiguous?Math.max(0,charge):charge;
    events.push({at,rate,charge,ambiguous,applied:ambiguous?Math.max(0,charge):charge});
  }
  t.fundingStatus='SETTLED_RATE_MODELLED';t.fundingEvents=events;t.fundingCost=cost;t.fundingAvailableAt=availableAt;
  t.netPnl=t.netPnlBeforeFunding-cost;t.realizedR=t.netPnl/t.plannedRiskUsdt;
  t.mfeR=t.mfePerUnit*t.quantity/t.plannedRiskUsdt;t.maeR=t.maePerUnit*t.quantity/t.plannedRiskUsdt;
  return t;
}
module.exports={MINUTE,MAX_ACTIVE,MAX_RECENT,terminal,create,step,funding};
