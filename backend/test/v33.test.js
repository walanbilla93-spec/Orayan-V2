'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const {build,economics,POLICY}=require('../lib/v3Geometry');
const {create,step,funding}=require('../lib/v3Trades');
const {ShadowJournal,VERSION}=require('../lib/v3Shadow');
const m=60000,at=200*m;
function args(side='BUY') {
  const buy=side==='BUY';
  const support={id:'defended',type:buy?'SWING_LOW':'SWING_HIGH',active:true,direction:side,knownAt:at-20*m,
    price:buy?95:105,zoneLow:buy?95:105,zoneHigh:buy?95:105,invalidationPrice:buy?95:105,distancePct:1,
    reaction:{reclaim:true,rejection:false}};
  const objective={id:'objective',type:buy?'SWING_HIGH':'SWING_LOW',active:true,direction:buy?'SELL':'BUY',knownAt:at-30*m,
    price:buy?115:85,zoneLow:buy?115:85,zoneHigh:buy?115:85,distancePct:15,reaction:{}};
  return {research:{selected:support,levels:[support,objective]},side,ticker:{observedAt:at,bid:99.99,ask:100.01},
    instrument:{tickSize:.01,qtyStep:.001,minOrderQty:.001,maxOrderQty:1000},settings:{timeframe:'15',takerFeePct:.055,
      slSlipBps:3,tpThroughBps:1,minRR:2,entryWindowMin:5,maxHoldMin:15,riskUsdtPerTrade:1,maxNotionalUsdt:1000},
    decisionAt:at,closedBarOpenAt:at-15*m};
}
function trade(side='BUY',capture=at+1) {const a=args(side),g=build(a);assert.equal(g.status,'ACCEPTED');
  return create({symbol:'TESTUSDT',side,geometry:g,version:VERSION,testnet:false,decisionAt:at,candidateId:'candidate',episodeId:'episode'},'trade',capture);}
const bar=(ts,open=100,high=101,low=99,close=100)=>({ts,open,high,low,close});
function tmp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orayan-v33-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}

test('independent objective and structural stop give actual RR after costs for both directions',()=>{
  for(const side of ['BUY','SELL']){const g=build(args(side));assert.equal(g.status,'ACCEPTED');
    assert.equal(g.objectiveLevel.id,'objective');assert.equal(g.stopLevel.id,'defended');
    assert.ok(g.rawRR>g.costAdjustedRR);assert.ok(g.costAdjustedRR>=2);assert.equal(g.costs.entryFeePct,.055);}
});
test('nearest barrier rejects low RR instead of inventing fixed 2R or skipping to distant target',()=>{
  const a=args();a.research.levels.push({...a.research.levels[1],id:'near',zoneLow:102,zoneHigh:102});
  const g=build(a);assert.equal(g.reason,'COST_ADJUSTED_RR_TOO_LOW');assert.equal(g.objectivePrice,102);
  assert.equal(g.invalidationPrice,94.99);
});
test('costs can invalidate gross acceptable geometry',()=>{
  const a=args();a.settings.minRR=2.9;const g=build(a);assert.ok(g.rawRR>2.9);assert.ok(g.costAdjustedRR<2.9);
  assert.equal(g.status,'REJECTED');
});
test('POC reaction requires independent structural invalidation and objective',()=>{
  const a=args();const poc={...a.research.selected,id:'poc',type:'POC',direction:null,invalidationPrice:null,price:97,zoneLow:96,zoneHigh:98,distancePct:0};
  a.research.levels.unshift(poc);a.research.selected=poc;assert.equal(build(a).stopLevel.id,'defended');
  a.research.levels=a.research.levels.filter(l=>l.id!=='defended');assert.equal(build(a).reason,'NO_STRUCTURAL_INVALIDATION');
});
test('geometry requires causal reaction, current quote and exchange tick/lot metadata',()=>{
  const a=args();a.research.selected.knownAt=at;assert.equal(build(a).reason,'NO_COMPLETED_STRUCTURAL_REACTION');
  const b=args();b.ticker.observedAt=at-121000;assert.equal(build(b).reason,'QUOTE_UNAVAILABLE_OR_STALE');
  const c=args();delete c.instrument;assert.equal(build(c).reason,'INSTRUMENT_UNAVAILABLE');
  const e=args();e.research.levels.pop();assert.equal(build(e).reason,'NO_INDEPENDENT_STRUCTURAL_OBJECTIVE');
});
test('no pre-capture or forming-bar fills; next full minute pays taker fees and entry slip',()=>{
  const t=trade(),eligible=at+m;assert.equal(t.eligibleFromAt,eligible);
  assert.equal(step(t,[bar(at)],at+2*m).trade.status,'PENDING');
  assert.equal(step(t,[bar(eligible)],eligible+59999).trade.status,'PENDING');
  const r=step(t,[bar(eligible)],eligible+m);assert.equal(r.trade.status,'OPEN');assert.equal(r.trade.filledAt,eligible);
  assert.ok(r.trade.entryPrice>100);assert.ok(r.trade.quantity*r.trade.fillEconomics.lossPerUnit<=1);
});
test('entry gap must revalidate cost-adjusted geometry before opening a shadow trade',()=>{
  const t=trade(),r=step(t,[bar(at+m,114,114.5,113,114)],at+2*m);
  assert.equal(r.trade.status,'CANCELLED');assert.equal(r.trade.outcome,'NEXT_OPEN_GEOMETRY_REJECTED');assert.equal(r.trade.filledAt,null);
});
test('tick and lot constraints cancel undersized fills without increasing risk',()=>{
  const t=trade();t.geometry.minOrderQty=10;const r=step(t,[bar(at+m)],at+2*m);
  assert.equal(r.trade.outcome,'BELOW_MIN_QTY');
});
test('target requires trade-through; exact wick touch stays open',()=>{
  const t=trade(),tp=t.geometry.objectivePrice;
  const r=step(t,[bar(at+m,100,tp,99,tp-1)],at+2*m);assert.equal(r.trade.status,'OPEN');
  const done=step(r.trade,[bar(at+2*m,tp-1,tp+.1,tp-2,tp)],at+3*m).trade;
  assert.equal(done.status,'CLOSED');assert.equal(done.outcome,'TARGET');assert.equal(done.exitPrice,tp);
});
test('stop/target collision is conservative and exposes optimistic alternative without inventing path',()=>{
  for(const side of ['BUY','SELL']){const t=trade(side),r=step(t,[bar(at+m,100,116,84,101)],at+2*m).trade;
    assert.equal(r.outcome,'STOP_AMBIGUOUS');assert.equal(r.ambiguous,true);assert.ok(r.netPnlBeforeFunding<0);
    assert.ok(r.alternativeTargetNetPnl>0);assert.equal(r.mfePerUnit,0);assert.equal(r.exitTimePrecision,'WITHIN_ONE_MINUTE');}
});
test('stop gaps exit at adverse opening price instead of the planned stop',()=>{
  const first=step(trade(),[bar(at+m)],at+2*m).trade;
  const r=step(first,[bar(at+2*m,90,91,89,90)],at+3*m).trade;
  assert.equal(r.outcome,'STOP_GAP');assert.ok(r.exitPrice<90);assert.ok(r.netPnlBeforeFunding<-1);
});
test('funding uses settled signed rates, conservative boundary cash flow, fees on exit notional',()=>{
  const t=step(trade(),[bar(at+m,100,116,99,115)],at+2*m).trade;
  const r=funding(t,[{fundingRateTimestamp:at+m,fundingRate:.001}],at+4*m);
  assert.equal(r.fundingEvents[0].ambiguous,true);assert.ok(r.fundingCost>0);assert.ok(r.netPnl<r.netPnlBeforeFunding);
  assert.equal(r.exitFee,r.exitPrice*r.quantity*.055/100);assert.equal(r.realizedR,r.netPnl/r.plannedRiskUsdt);
  const credit=funding({...t,side:'SELL'},[{fundingRateTimestamp:at+m,fundingRate:.001}],at+4*m);
  assert.equal(credit.fundingCost,0);assert.throws(()=>funding(t,[{fundingRateTimestamp:NaN,fundingRate:0}],at));
});
test('timeout closes after frozen max hold with market exit costs; expiry has no hypothetical fill',()=>{
  const t=trade();t.geometry.maxHoldMin=2;
  const r=step(t,[bar(at+m),bar(at+2*m)],at+3*m).trade;assert.equal(r.outcome,'TIMEOUT');assert.ok(r.fees>0);
  const expired=trade();expired.expiresAt=expired.eligibleFromAt;
  assert.equal(step(expired,[bar(at+m)],at+2*m).trade.status,'EXPIRED');
});
test('missing minutes are incomplete outcomes and repeated/overlapping batches are idempotent',()=>{
  const t=trade(),a=step(t,[bar(at+m)],at+2*m).trade;
  const repeat=step(a,[bar(at+m)],at+2*m);assert.deepEqual(repeat.trade,a);assert.equal(repeat.events.length,0);
  const gap=step(a,[bar(at+3*m)],at+4*m).trade;assert.equal(gap.status,'DATA_GAP');assert.equal(gap.gapExpectedAt,at+2*m);
});
function accepted(time=at+1,symbol='TESTUSDT') {return {version:VERSION,configHash:'config',symbol,side:'BUY',decisionAt:time,
  closedBarOpenAt:at-15*m,regime:'BULL_TREND',v3Decision:'ACCEPT_SHADOW',rejectReason:null,v2Decision:[],
  research:args().research,geometry:build(args()),testnet:false};}
test('admissions dedupe by structural setup, restart persists pending/open trades and bounds memory',t=>{
  const dir=tmp(t),j=new ShadowJournal(dir);j.record(accepted(),'scan',at,at+1);
  j.record(accepted(at+2),'scan2',at,at+2);assert.equal(j.tradeCounts.admitted,1);assert.equal(j.activeTrades.size,1);
  j.checkpointAndPrune(at);const restored=new ShadowJournal(dir);assert.equal(restored.activeTrades.size,1);
  for(let i=0;i<40;i++)restored.record(accepted(at+3,'S'+i),'scan3',at,at+3);
  assert.equal(restored.activeTrades.size,32);assert.equal(restored.recent.at(-1).rejectReason,'SHADOW_CAPACITY_LIMIT');
  restored.saveCheckpoint();assert.ok(fs.statSync(restored.checkpoint).size<1024*1024);
  assert.ok(restored.export('trades').files.length);assert.equal(restored.counts.trades,32);
});
test('low-priority worker closes and finalizes funding; restart never refills same trade',async t=>{
  const dir=tmp(t),j=new ShadowJournal(dir);j.record(accepted(),'scan',at,at+1);
  const requests=[];const get=async(endpoint,p)=>{requests.push({endpoint,p});return {list:endpoint.endsWith('kline')?
    [[at+m,'100','116','99','115']]:[]};};
  await j.advance(at+4*m,get);assert.equal(j.tradeCounts.filled,1);assert.equal(j.tradeCounts.closed,1);
  assert.equal(j.activeTrades.size,0);assert.equal(j.recentTrades[0].fundingStatus,'SETTLED_RATE_MODELLED');
  assert.equal(j.recentTrades[0].netPnl,j.recentTrades[0].netPnlBeforeFunding);
  assert.equal(requests[0].p.start,at+m);assert.equal(requests[1].endpoint,'/v5/market/funding/history');
  const restored=new ShadowJournal(dir);await restored.advance(at+5*m,get);assert.equal(requests.length,2);
  assert.equal(restored.tradeCounts.filled,1);assert.equal(restored.status().executionAllowed,false);
});
test('data request failures preserve cursor and closed funding retries without a second fill',async t=>{
  const j=new ShadowJournal(tmp(t));j.record(accepted(),'scan',at,at+1);
  await j.advance(at+4*m,async()=>{throw Error('rate limited');});assert.equal([...j.activeTrades.values()][0].lastBarAt,null);
  await j.advance(at+5*m,async endpoint=>{if(endpoint.endsWith('history'))throw Error('funding unavailable');
    return {list:[[at+m,'100','116','99','115']]};});
  assert.equal(j.tradeCounts.filled,1);assert.equal([...j.activeTrades.values()][0].status,'CLOSED');
  await j.advance(at+6*m,async()=>({list:[]}));assert.equal(j.tradeCounts.filled,1);assert.equal(j.activeTrades.size,0);
});
test('disk failure preserves cursor so a path transition remains retryable',async t=>{
  const j=new ShadowJournal(tmp(t));j.record(accepted(),'scan',at,at+1);j.tradeEvent=()=>{throw Error('disk full');};
  await j.advance(at+3*m,async()=>({list:[[at+m,'100','101','99','100']]}));
  assert.equal([...j.activeTrades.values()][0].status,'PENDING');assert.equal(j.tradeCounts.filled,0);
});
