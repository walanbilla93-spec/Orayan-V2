'use strict';

// Fixed, prospective research rubric. It does not enter any gate or execution path.
const finite = x => x == null || !Number.isFinite(Number(x)) ? null : Number(x);
function classify(row) {
  const m=row.trendMomentum||{}, q=row.market||{}, l=row.liquidations||{};
  const side=row.side==='SELL'?-1:1;
  const atr=finite(m.atr14), mark=finite(q.markPrice), entry=finite(row.plannedEntry);
  const inputs={
    momentum3Vol:finite(m.directionalReturn3Vol),momentum12Vol:finite(m.directionalReturn12Vol),
    acceleration:finite(m.acceleration3VsPrevious3),relativeReturn12VsBtc:finite(m.relativeReturn12VsBtc),
    relativeReturn12VsUniverse:finite(m.relativeReturn12VsUniverse),
    oiChangePct:finite(q.openInterestChangePct),breadth:finite(row.breadth),
    breadthMomentum:finite(row.breadthMomentum),structureEvent:row.structureEvent||null,
    liquidationCoverage:l.coverage||null,liquidationImbalance5m:finite(l.imbalance5m),
    bookImbalance:finite(q.topOfBookImbalance),takerImbalance1m:null,
    entryDistanceAtr:atr>0&&mark>0&&entry>0?side*(mark-entry)/atr:null,
    trendLegNumber:finite(row.trendLegNumber),spreadPct:finite(q.spreadPct),
    turnoverShock:finite(m.turnoverLast3VsPrior17),
  };
  let score=0, observed=0;
  const vote=(v,weight)=>{if(v!==null){observed++;score+=weight*Math.sign(v);}};
  vote(inputs.momentum3Vol!==null?inputs.momentum3Vol-0.25:null,2);
  vote(inputs.momentum12Vol!==null?inputs.momentum12Vol-0.5:null,2);
  vote(inputs.acceleration,1);
  vote(inputs.relativeReturn12VsUniverse,1);
  // Rising OI measures participation; the ticker alone does not reveal whether longs or
  // shorts opened, so do not sign it by trade direction.
  vote(inputs.oiChangePct,1);
  vote(inputs.breadthMomentum!==null?inputs.breadthMomentum*side:null,1);
  vote(inputs.bookImbalance!==null?inputs.bookImbalance*side:null,1);
  if (inputs.liquidationCoverage==='FULL_15M') vote(inputs.liquidationImbalance5m!==null?inputs.liquidationImbalance5m*side:null,1);
  if (inputs.turnoverShock!==null) vote(inputs.turnoverShock-1,1);
  const state=observed<4?'INSUFFICIENT_DATA':score>=4?'STRONG_CONTINUATION':score<=-3?'DETERIORATING':'HEALTHY_PULLBACK';
  return {version:'RETRACE_STATE_SHADOW_V1',state,score,observedInputs:observed,
    confidence:'UNVALIDATED_RESEARCH_ONLY',inputs};
}
module.exports={classify};
