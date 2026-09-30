'use strict';
// Versioned research policy, never an execution signal or an adjustment to V2 settings.
const POLICY='V3.3_STRUCTURAL_MARKET_NEXT_MINUTE_V1';
const round=(price,tick,up)=>Number(((up?Math.ceil:Math.floor)(price/tick+ (up?-1e-9:1e-9))*tick).toPrecision(14));
function economics(entry,stop,target,side,costs) {
  const d=side==='BUY'?1:-1;
  const slippedStop=stop*(1-d*costs.stopSlippageBps/10000);
  const stopExit=costs.tickSize?round(slippedStop,costs.tickSize,d!==1):slippedStop;
  const targetExit=target; // Resting target at its price, only after trade-through.
  const rawRisk=d*(entry-stop),rawReward=d*(target-entry);
  const loss=d*(entry-stopExit)+entry*costs.entryFeePct/100+stopExit*costs.exitFeePct/100;
  const reward=d*(targetExit-entry)-entry*costs.entryFeePct/100-targetExit*costs.exitFeePct/100;
  return {rawRR:rawRisk>0?rawReward/rawRisk:null,costAdjustedRR:loss>0?reward/loss:null,
    rawRiskPerUnit:rawRisk,rawRewardPerUnit:rawReward,lossPerUnit:loss,rewardPerUnit:reward,stopExit,targetExit};
}
function build({research,side,ticker,instrument,settings,decisionAt,closedBarOpenAt,reactionLow,reactionHigh}) {
  const fail=(reason,extra={})=>({status:'REJECTED',policy:POLICY,reason,invalidationPrice:null,objectivePrice:null,
    rawRR:null,costAdjustedRR:null,...extra});
  if(decisionAt-closedBarOpenAt>Number(settings.timeframe)*60000+120000)return fail('STALE_REACTION_BAR');
  if(!['BUY','SELL'].includes(side))return fail('NO_TREND');
  if(!instrument || !(instrument.tickSize>0) || !(instrument.qtyStep>0))return fail('INSTRUMENT_UNAVAILABLE');
  if(!ticker || !Number.isFinite(ticker.observedAt) || ticker.observedAt>decisionAt || decisionAt-ticker.observedAt>120000 ||
    !(ticker.ask>=ticker.bid && ticker.bid>0))return fail('QUOTE_UNAVAILABLE_OR_STALE');
  const all=[...(research?.levels||[])];
  if(research?.selected && !all.some(l=>l.id===research.selected.id))all.push(research.selected);
  const reactions=all.filter(l=>l.active && (!l.direction||l.direction===side) && l.knownAt<=closedBarOpenAt &&
    (l.reaction?.reclaim||l.reaction?.rejection));
  reactions.sort((a,b)=>Math.abs(a.distancePct)-Math.abs(b.distancePct)||b.knownAt-a.knownAt||a.id.localeCompare(b.id));
  const level=reactions[0];
  if(!level)return fail('NO_COMPLETED_STRUCTURAL_REACTION');
  const d=side==='BUY'?1:-1,tick=instrument.tickSize;
  const costs={entryFeePct:Number(settings.takerFeePct),exitFeePct:Number(settings.takerFeePct),tickSize:tick,
    entrySlippageBps:3,stopSlippageBps:Number(settings.slSlipBps),targetThroughBps:Number(settings.tpThroughBps),
    funding:'SETTLED_RATE_ENTRY_NOTIONAL_APPROXIMATION',entryType:'MARKET_NEXT_FULL_MINUTE'};
  if(![costs.entryFeePct,costs.exitFeePct,costs.stopSlippageBps,costs.targetThroughBps].every(x=>Number.isFinite(x)&&x>=0))
    return fail('INVALID_COST_ASSUMPTIONS');
  const quote=side==='BUY'?ticker.ask:ticker.bid;
  const entry=round(quote*(1+d*costs.entrySlippageBps/10000),tick,side==='BUY');
  // POC is a location, not a stop. Require a separately known defended boundary behind it.
  const defended=Number.isFinite(level.invalidationPrice)?level:all.filter(l=>l.active && l.direction===side &&
    l.knownAt<=closedBarOpenAt && Number.isFinite(l.invalidationPrice) && d*(level.price-l.invalidationPrice)>=0)
    .sort((a,b)=>Math.abs(level.price-a.invalidationPrice)-Math.abs(level.price-b.invalidationPrice)||a.id.localeCompare(b.id))[0];
  if(!defended)return fail('NO_STRUCTURAL_INVALIDATION',{reactionLevel:level});
  const boundary=side==='BUY'?Math.min(defended.invalidationPrice,reactionLow??defended.invalidationPrice):
    Math.max(defended.invalidationPrice,reactionHigh??defended.invalidationPrice);
  const stop=round(boundary-d*tick,tick,side==='SELL');
  // Select nearest opposing structure BEFORE checking RR; never skip a barrier to manufacture reward.
  const objectives=all.filter(l=>l.active && l.id!==level.id && l.knownAt<=closedBarOpenAt &&
    (l.type==='POC'||l.direction===(side==='BUY'?'SELL':'BUY')))
    .map(l=>({level:l,price:round(side==='BUY'?l.zoneLow:l.zoneHigh,tick,side==='SELL')}))
    .filter(x=>d*(x.price-entry)>0).sort((a,b)=>Math.abs(a.price-entry)-Math.abs(b.price-entry)||a.level.id.localeCompare(b.level.id));
  const objective=objectives[0];
  const partial={entryPrice:entry,invalidationPrice:stop,reactionLevel:level,stopLevel:defended,costs,
    invalidationSource:'DEFENDED_BOUNDARY_AND_REACTION_EXTREME_ONE_TICK',reactionLow:reactionLow??null,reactionHigh:reactionHigh??null,
    tickSize:tick,qtyStep:instrument.qtyStep,minOrderQty:instrument.minOrderQty,maxOrderQty:instrument.maxOrderQty,
    minCostAdjustedRR:Number(settings.minRR),entryWindowMin:Number(settings.entryWindowMin),maxHoldMin:Number(settings.maxHoldMin),
    sizing:{riskUsdt:Number(settings.riskUsdtPerTrade),maxNotionalUsdt:Number(settings.maxNotionalUsdt)}};
  if(!objective)return fail('NO_INDEPENDENT_STRUCTURAL_OBJECTIVE',partial);
  const target=objective.price,stats=economics(entry,stop,target,side,costs);
  const result={...partial,...stats,objectivePrice:target,objectiveLevel:objective.level};
  if(!(d*(entry-stop)>0 && d*(target-entry)>0 && stop>0))return fail('INVALID_STRUCTURAL_GEOMETRY',result);
  if(![partial.minCostAdjustedRR,partial.entryWindowMin,partial.maxHoldMin,partial.sizing.riskUsdt,
    partial.sizing.maxNotionalUsdt].every(x=>Number.isFinite(x)&&x>0))return fail('INVALID_SHADOW_POLICY_INPUT',result);
  if(!(stats.rewardPerUnit>0 && stats.costAdjustedRR>=partial.minCostAdjustedRR))return fail('COST_ADJUSTED_RR_TOO_LOW',result);
  return {status:'ACCEPTED',policy:POLICY,reason:null,...result};
}
module.exports={POLICY,round,economics,build};
