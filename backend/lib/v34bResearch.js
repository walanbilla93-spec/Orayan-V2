'use strict';
// One-way paired simulations: these functions do not import execution, settings,
// gates, signals or providers and never write to the control geometry.
const control=require('./v3Trades'),{round,economics}=require('./v3Geometry');
const clone=x=>JSON.parse(JSON.stringify(x));
const armTrade=t=>{const {research34,research35,...rest}=clone(t);return rest;};
const VERSION='V3.4B_PREREGISTERED_PAIRED_HOLDOUT_V1';
const POLICIES=['FIRST_ADMISSION_ONLY','FIRST_FILLED_ONLY','ATR1M_BUFFER','RECEIPT_DEFENDED_TRAILING','ATR1M_1P5_REPLACEMENT'];
const DEFINITIONS={version:VERSION,researchOnly:true,executionAllowed:false,
  episodeReset:'Frozen journal episode ID: config + symbol + side; reset after >30 minutes without an observed surface. Cancellation never resets an arm.',
  FIRST_ADMISSION_ONLY:'Consume the first control-eligible admission even if it cancels or never fills. No replacement within that episode.',
  FIRST_FILLED_ONLY:'Allow control-eligible admissions until the first physically processed actual control fill; suppress all later admissions in the episode.',
  ATR1M_BUFFER:'Exact causal decision ATR SMA TR14, control stop <1 ATR; adverse stop at max(structural distance, 1 ATR); same target; same cost RR threshold at decision and next open. Lot-rounded risk may be lower, never higher.',
  ATR1M_1P5_REPLACEMENT:'PROSPECTIVE SHADOW RESEARCH. Freeze exact causal decision SMA of 14 completed 1m true ranges. Replace structural stop with adverse 1.5 ATR from intended entry at decision and modeled actual entry at fill, adverse tick rounding; may tighten or widen. Original frozen structural objective, no 2R cap. Equal cost-inclusive planned control cash risk with downward lot, notional and quantity caps. Same decision/fill cost-RR, costs, funding, hold, gaps, stop-first ambiguity. Independent path/funding horizon after control terminal; missing path is censored. Matched-fill and full-geometry populations reported separately.',
  RECEIPT_DEFENDED_TRAILING:'Only admissions after first 30 consecutive complete clean UTC hours. New active same-side defended boundary confirmed AND received after fill. One adverse tick safety offset; act at first complete minute open at/after receipt; favorable only. Existing fills remain dormant.',
  intrabar:'Stop first on stop/target ambiguity. Receipt inside a minute acts next minute. Gap stop exits at adverse slipped opening price.',
  economics:'Frozen simulator fees/slippage/funding boundary model, tick/quantity limits. Funding entry-notional approximation; missing path/funding is censored, never zero.',
  primaryEndpoint:'Cost and funding adjusted net cash per control-eligible admission at equal planned cash risk; rejected/suppressed/no-fill = zero opportunity return.',
  review:{uniqueFilledEpisodes:100,calendarDaysPreferred:10,symbols:30,maxSymbolShare:.20,shortIfAvailable:20,nonBullTrendIfAvailable:20,
    repeatEpisodes:30,atrBufferEpisodes:20,trailingEpisodes:30,trailingControlWinners:10,highRREpisodes:30,allAdmissionsResolvedOrCensored:true}};
function base(policy,t,status,reason=null){return {policy,version:VERSION,researchOnly:true,executionAllowed:false,
  controlTradeId:t.tradeId,episodeId:t.episodeId,candidateId:t.candidateId,eligible:status!=='INELIGIBLE',status,reason,
  opportunityNetCash:['SUPPRESSED','REJECTED_BY_BUFFER_GEOMETRY'].includes(status)?0:null};}
function admit(t,measurement,episode={},trailingActive=false) {
  const arms={},ordinal=(episode.admissions||0)+1;
  for(const policy of POLICIES.slice(0,2)){
    const suppressed=policy==='FIRST_ADMISSION_ONLY'?ordinal>1:Boolean(episode.firstFillAt);
    arms[policy]=base(policy,t,suppressed?'SUPPRESSED':'PAIRED_CONTROL',suppressed?(policy==='FIRST_ADMISSION_ONLY'?'FIRST_ELIGIBLE_ADMISSION_CONSUMED':'FIRST_ACTUAL_FILL_ALREADY_RECEIVED'):null);
    arms[policy].admissionOrdinal=ordinal;arms[policy].repeatEligible=ordinal>1;
  }
  const n=measurement?.noise,g=t.geometry,d=t.side==='BUY'?1:-1;
  const causal=n?.status==='AVAILABLE'&&Number.isFinite(n.atr1m)&&n.atr1m>0&&
    Number.isFinite(n.receivedAt)&&n.receivedAt<=t.decisionAt&&Number.isFinite(n.cutoff)&&n.cutoff<=t.decisionAt;
  const eligible=causal&&Math.abs(g.entryPrice-g.invalidationPrice)<n.atr1m;
  let a=arms.ATR1M_BUFFER=base('ATR1M_BUFFER',t,eligible?'PENDING':'INELIGIBLE',!causal?'EXACT_CAUSAL_ATR_UNAVAILABLE':!eligible?'CONTROL_STOP_NOT_LT_1ATR':null);
  if(eligible){
    const stop=round(g.entryPrice-d*n.atr1m,g.tickSize,d!==1),e=economics(g.entryPrice,stop,g.objectivePrice,t.side,g.costs);
    a.atr1m=n.atr1m;a.atrReceivedAt=n.receivedAt;a.STRUCTURE_RELAXED=d*(g.invalidationPrice-stop)>0;
    if(!(stop>0&&e.lossPerUnit>0&&e.rewardPerUnit>0&&e.costAdjustedRR>=g.minCostAdjustedRR))Object.assign(a,{status:'REJECTED_BY_BUFFER_GEOMETRY',reason:'DECISION_RR_RECHECK',opportunityNetCash:0});
    else a.trade={...armTrade(t),geometry:{...clone(g),invalidationPrice:stop},executionAllowed:false};
  }
  a=arms.RECEIPT_DEFENDED_TRAILING=base('RECEIPT_DEFENDED_TRAILING',t,trailingActive?'PENDING':'DORMANT',trailingActive?null:'REQUIRES_30_COMPLETE_CLEAN_HOURS');
  a.eligible=trailingActive;
  if(trailingActive){a.trade=armTrade(t);a.receipts=[];a.moves=[];a.safetyOffsetTicks=1;}
  const replacementCausal=causal&&n.definition==='ATR_SMA_TR14_RV_RMS_LOG_RETURN20_TR_MEAN20_V1';
  const replacement=arms.ATR1M_1P5_REPLACEMENT=base('ATR1M_1P5_REPLACEMENT',t,replacementCausal?'PENDING':'INELIGIBLE',replacementCausal?null:'POSITIVE_CAUSAL_DECISION_ATR_REQUIRED');
  replacement.matchedFillSubset=false;replacement.fullGeometrySubset=true;replacement.newlyAdmittedOpportunity=Boolean(t.controlGeometryRejected);
  replacement.definitionVersion='ATR1M_1P5_REPLACEMENT_V1';replacement.label='Prospective shadow research · no promotion';
  replacement.admissionOrdinal=ordinal;replacement.firstAdmissionSensitivity=ordinal===1;
  if(replacementCausal){
    const stop=round(g.entryPrice-d*1.5*n.atr1m,g.tickSize,d!==1),e=economics(g.entryPrice,stop,g.objectivePrice,t.side,g.costs);
    Object.assign(replacement,{atr1m:n.atr1m,atrDefinition:n.definition??null,atrCutoff:n.cutoff,atrReceivedAt:n.receivedAt,
      decisionProvisionalStop:stop,structuralControlStop:g.invalidationPrice,structuralObjective:g.objectivePrice,decisionEconomics:e,
      canTightenOrWiden:true,objectiveCap:null});
    if(!(stop>0&&d*(g.entryPrice-stop)>0&&e.lossPerUnit>0&&e.rewardPerUnit>0&&e.costAdjustedRR>=g.minCostAdjustedRR))
      Object.assign(replacement,{status:'REJECTED_BY_REPLACEMENT_GEOMETRY',reason:'DECISION_COST_ADJUSTED_RR_OR_GEOMETRY',decisionGeometryRejected:true,opportunityNetCash:0});
    else {replacement.trade={...armTrade(t),status:'PENDING',outcome:null,filledAt:null,lastBarAt:null,netPnl:null,
      geometry:{...clone(g),invalidationPrice:stop},executionAllowed:false};}
  }
  return {version:VERSION,executionAllowed:false,arms};
}
function resize(t,risk,strict=false) {
  if(!t.quantity||!risk)return t;
  let desired=round(Math.min(risk/t.fillEconomics.lossPerUnit,t.geometry.sizing.maxNotionalUsdt/t.entryPrice,t.geometry.maxOrderQty||Infinity),t.geometry.qtyStep,false);
  if(strict)while(desired>0&&(desired*t.fillEconomics.lossPerUnit>risk||desired*t.entryPrice>t.geometry.sizing.maxNotionalUsdt||desired>(t.geometry.maxOrderQty||Infinity)))desired=round(desired-t.geometry.qtyStep,t.geometry.qtyStep,false);
  if(desired<(t.geometry.minOrderQty||0)||desired<=0)return {...t,status:'CANCELLED',outcome:'BELOW_EQUAL_RISK_MIN_QTY',filledAt:null,
    quantity:null,netPnl:0,netPnlBeforeFunding:0,fundingStatus:'NOT_APPLICABLE',outcomeComplete:true};
  const factor=desired/t.quantity;
  for(const key of ['grossPnl','entryFee','exitFee','fees','netPnlBeforeFunding','unrealizedNetBeforeFunding','alternativeTargetNetPnl'])
    if(Number.isFinite(t[key]))t[key]*=factor;
  t.quantity=desired;t.plannedRiskUsdt=t.fillEconomics.lossPerUnit*desired;
  t.equalRiskBudgetUsdt=risk;t.riskRoundingShortfallUsdt=risk-t.plannedRiskUsdt;
  if(Number.isFinite(t.netPnlBeforeFunding))t.realizedRBeforeFunding=t.netPnlBeforeFunding/t.plannedRiskUsdt;
  return t;
}
function receive(research,levels,filledAt){
  const a=research?.arms?.RECEIPT_DEFENDED_TRAILING;if(!a?.trade)return;
  const ids=new Set((a.receipts||[]).map(l=>l.id));
  for(const l of levels)if(!ids.has(l.id)&&Number.isFinite(l.invalidationPrice)&&l.knownAt>filledAt&&l.receivedAt>filledAt&&l.knownAt<=l.receivedAt){
    a.receipts.push(clone(l));ids.add(l.id);a.receiptCount=(a.receiptCount||0)+1;
  }
  // Consumed receipts have immutable arm-trigger exports; keep pending queue bounded.
  a.receipts=a.receipts.filter(l=>!l.appliedAt).slice(-64);
}
function advance(research,controlTrade,bars,now){
  if(!research)return research;const r=clone(research);
  for(const a of Object.values(r.arms)) {
    if(a.status==='PAIRED_CONTROL'){
      a.fillStatus=controlTrade.filledAt?'FILLED':controlTrade.status;a.controlOutcome=controlTrade.outcome;
      a.outcome=controlTrade.outcome;a.holdMs=controlTrade.holdMs??null;
      a.opportunityNetCash=controlTrade.netPnl??null;a.netR=controlTrade.realizedR??null;a.complete=controlTrade.outcomeComplete;
      continue;
    }
    if(!a.trade||control.terminal(a.trade))continue;
    for(const b of bars){
      if(b.ts<(a.trade.lastBarAt===null?a.trade.eligibleFromAt:a.trade.lastBarAt+60000)||b.ts+60000>now)continue;
      if(a.policy==='RECEIPT_DEFENDED_TRAILING'&&a.trade.status==='OPEN'){
        const d=a.trade.side==='BUY'?1:-1;
        for(const l of a.receipts||[])if(!l.appliedAt&&l.receivedAt<=b.ts){
          const old=a.trade.geometry.invalidationPrice,candidate=round(l.invalidationPrice-d*a.trade.geometry.tickSize,a.trade.geometry.tickSize,d!==1);
          l.appliedAt=b.ts;
          if(d*(candidate-old)>0&&d*(a.trade.geometry.objectivePrice-candidate)>0){
            a.trade.geometry.invalidationPrice=candidate;
            a.moves.push({levelId:l.id,knownAt:l.knownAt,receivedAt:l.receivedAt,appliedAt:b.ts,oldStop:old,newStop:candidate});
          }
        }
      }
      const pending=a.trade.status==='PENDING';
      if(pending&&a.policy==='ATR1M_BUFFER'){
        const d=a.trade.side==='BUY'?1:-1,g=a.trade.geometry;
        const modeled=round(b.open*(1+d*g.costs.entrySlippageBps/10000),g.tickSize,d===1);
        // Reapply the same causal ATR at the executable open; a favorable gap
        // must not accidentally shrink this buffer below one ATR.
        const structural=controlTrade.geometry.invalidationPrice;
        const stop=d===1?Math.min(structural,modeled-a.atr1m):Math.max(structural,modeled+a.atr1m);
        g.invalidationPrice=round(stop,g.tickSize,d!==1);a.STRUCTURE_RELAXED=d*(structural-g.invalidationPrice)>0;
      }
      if(pending&&a.policy==='ATR1M_1P5_REPLACEMENT'){
        const d=a.trade.side==='BUY'?1:-1,g=a.trade.geometry,modeled=round(b.open*(1+d*g.costs.entrySlippageBps/10000),g.tickSize,d===1);
        g.invalidationPrice=round(modeled-d*1.5*a.atr1m,g.tickSize,d!==1);a.fillAdjustedActualStop=g.invalidationPrice;
        const cg=controlTrade.geometry,ce=economics(modeled,cg.invalidationPrice,cg.objectivePrice,controlTrade.side,cg.costs);
        const de=economics(cg.entryPrice,cg.invalidationPrice,cg.objectivePrice,controlTrade.side,cg.costs);
        const loss=ce.lossPerUnit>0?ce.lossPerUnit:de.lossPerUnit,price=ce.lossPerUnit>0?modeled:cg.entryPrice;
        const qty=round(Math.min(cg.sizing.riskUsdt/loss,cg.sizing.maxNotionalUsdt/price,cg.maxOrderQty||Infinity),cg.qtyStep,false);
        a.equalRiskBudgetUsdt=controlTrade.plannedRiskUsdt||Math.max(0,loss*qty);g.sizing.riskUsdt=Math.min(cg.sizing.riskUsdt,a.equalRiskBudgetUsdt);
      }
      a.trade=control.step(a.trade,[b],now).trade;
      if(pending&&a.trade.filledAt){
        // The control's next-open risk is known from the paired path, including
        // cancellations. If control never fills, use the decision planned risk.
        const cg=controlTrade.geometry,fill=a.trade.entryPrice,ce=economics(fill,cg.invalidationPrice,cg.objectivePrice,controlTrade.side,cg.costs);
        const de=economics(cg.entryPrice,cg.invalidationPrice,cg.objectivePrice,controlTrade.side,cg.costs);
        const loss=ce.lossPerUnit>0?ce.lossPerUnit:de.lossPerUnit,price=ce.lossPerUnit>0?fill:cg.entryPrice;
        const cq=round(Math.min(cg.sizing.riskUsdt/loss,cg.sizing.maxNotionalUsdt/price,cg.maxOrderQty||Infinity),cg.qtyStep,false);
        a.trade=resize(a.trade,controlTrade.plannedRiskUsdt||Math.max(0,loss*cq),a.policy==='ATR1M_1P5_REPLACEMENT');
        if(a.policy==='ATR1M_1P5_REPLACEMENT')a.matchedFillSubset=Boolean(controlTrade.filledAt&&a.trade.filledAt===controlTrade.filledAt&&a.trade.entryPrice===controlTrade.entryPrice);
      }
      if(control.terminal(a.trade))break;
    }
    a.status=a.trade.status;a.fillStatus=a.trade.filledAt?'FILLED':a.trade.status;a.outcome=a.trade.outcome;
    a.holdMs=a.trade.holdMs??null;
    if(a.policy==='ATR1M_BUFFER'&&a.trade.status==='CANCELLED'&&a.trade.outcome==='NEXT_OPEN_GEOMETRY_REJECTED'){
      a.status='REJECTED_BY_BUFFER_GEOMETRY';a.reason='NEXT_OPEN_RR_OR_GAP_RECHECK';
    }
    if(a.policy==='ATR1M_1P5_REPLACEMENT'&&a.trade.status==='CANCELLED'&&['NEXT_OPEN_GEOMETRY_REJECTED','BELOW_EQUAL_RISK_MIN_QTY'].includes(a.trade.outcome)){
      a.status='REJECTED_BY_REPLACEMENT_GEOMETRY';a.reason=a.trade.outcome;a.fillGeometryRejected=true;
    }
    a.opportunityNetCash=a.trade.netPnl??null;a.netR=a.trade.realizedR??null;a.complete=a.trade.outcomeComplete;
  }
  return r;
}
function funding(research,rows,at,coveredThrough=Infinity){
  if(!research)return research;const r=clone(research);
  for(const a of Object.values(r.arms))if(a.trade?.status==='CLOSED'&&a.trade.fundingStatus==='PENDING'&&a.trade.closedAt<=coveredThrough){
    a.trade=control.funding(a.trade,rows,at);a.opportunityNetCash=a.trade.netPnl;a.netR=a.trade.realizedR;a.complete=true;
  }
  return r;
}
const active=r=>Object.values(r?.arms||{}).some(a=>a.trade&&!control.terminal(a.trade));
module.exports={VERSION,DEFINITIONS,POLICIES,admit,advance,receive,resize,funding,active};
