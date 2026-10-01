'use strict';
const crypto=require('crypto');
const SCHEMA='V3_COMPACT_V1';
const pick=(o,keys)=>Object.fromEntries(keys.filter(k=>o?.[k]!==undefined).map(k=>[k,o[k]]));
const id=o=>crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0,24);
// Derived research ratios use eight significant digits; prices, clocks and control geometry stay exact.
const derived=x=>Array.isArray(x)?x.map(derived):x&&typeof x==='object'?
  Object.fromEntries(Object.entries(x).map(([k,v])=>[k,derived(v)])):
  typeof x==='number'&&!Number.isInteger(x)?Number(x.toPrecision(8)):x;
function definition(level) {
  if(!level)return null;
  return pick(level,['id','type','source','direction','anchorAt','knownAt','price','zoneLow','zoneHigh',
    'invalidationPrice','bosAt','brokenSwingAt','volumeContext','profile']);
}
function state(level) {
  if(!level)return null;
  return {...pick(level,['active','invalidatedAt','structuralRole','ageMs','distancePct','touchCount','lastTouchAt','reaction']),
    definitionId:id(definition(level))};
}
function geometry(g) {
  if(!g)return g;
  const compact={...g};
  for(const key of ['reactionLevel','stopLevel','objectiveLevel'])if(compact[key])compact[key]=state(compact[key]);
  return compact;
}
function compact(row) {
  const r={...row,captureSchema:SCHEMA},definitions=[];
  const remember=l=>{if(l){const d=definition(l);definitions.push({definitionId:id(d),definition:d});}};
  const measurement=x=>{
    if(!x)return x;
    let noise=x.noise;
    if(noise){
      const definition=derived(pick(noise,['definition','cutoff','firstReturnAt','lastReturnAt','compactStats','atr1m','atr15m',
        'realizedVolatility','realizedNoisePrice','trueRangeNoise','sampleCount','status']));
      const definitionId=id(definition);
      definitions.push({outputType:'V3_MEASUREMENT_DEFINITION',definitionId,definition});
      noise={...pick(noise,['sourceAt','receivedAt','capturedAt','physicallyAvailableAtCutoff','status','atr15mSource','atr15mDefinition']),definitionId};
    }
    const feature={momentum:derived(x.momentum),spatial:derived(x.spatial),structuralEvent:x.structuralEvent,premiumDiscount:x.premiumDiscount,
      breadthUniverse:x.breadth?.universe};
    if(feature.momentum){const {capturedAt:unused,...rest}=feature.momentum;feature.momentum=rest;}
    if(feature.premiumDiscount){const {rangeAgeMs:unused,...rest}=feature.premiumDiscount;feature.premiumDiscount=rest;}
    if(feature.structuralEvent){const {joinAgeMs:unused,...rest}=feature.structuralEvent;feature.structuralEvent=rest;}
    if(feature.spatial)for(const k of ['selected','ob','poc'])if(feature.spatial[k]){
      const {ageMs:unused,...rest}=feature.spatial[k];feature.spatial[k]=rest;
    }
    const featureDefinitionId=Object.values(feature).some(v=>v!==undefined)?id(feature):undefined;
    if(featureDefinitionId)definitions.push({outputType:'V3_MEASUREMENT_DEFINITION',definitionId:featureDefinitionId,definition:feature});
    const {momentum:unusedMomentum,spatial:unusedSpatial,structuralEvent:unusedEvent,premiumDiscount:unusedPd,...base}=x;
    const inventory=(x.objectiveInventory||[]).map(l=>{
      remember(l.definition);const {definition:unused,...rest}=l;return {...rest,distance:derived(rest.distance),definitionId:id(definition(l.definition))};
    });
    const inventoryDefinitionId=inventory.length?id(inventory):undefined;
    if(inventoryDefinitionId)definitions.push({outputType:'V3_OBJECTIVE_INVENTORY_DEFINITION',definitionId:inventoryDefinitionId,definition:inventory});
    const {objectiveInventory:unusedInventory,...rest}=base;
    if(rest.breadth){const {universe:unusedUniverse,...breadth}=rest.breadth;rest.breadth=breadth;}
    return {...rest,featureDefinitionId,inventoryDefinitionId,noise,stop:derived(x.stop)};
  };
  if(r.measurement34)r.measurement34=measurement(r.measurement34);
  if(r.research) {
    const research=r.research;
    remember(research.selected);
    r.research=pick(research,['premiumDiscount','referencePremiumDiscount','confluence','reaction','volumeDelta',
      'levelCount','candidatePrice','distanceReferencePrice']);
    r.research.selected=state(research.selected);
    // Retain the contemporaneous POC summary even when the chosen level is a swing.
    r.research.profile=research.profile?pick(research.profile,['price','zoneLow','zoneHigh','binVolume','totalVolume','mostTouchedPrice','source','knownAt','anchorAt','method','rows','lookbackBars']):null;
    r.research.levelInventory={};
    for(const l of research.levels||[]) {
      const counts=r.research.levelInventory[l.type]||(r.research.levelInventory[l.type]={active:0,invalidated:0});
      counts[l.active?'active':'invalidated']++;
    }
    // Profile and OB volume context live in the chosen level's immutable definition.
  }
  for(const key of ['reactionLevel','stopLevel','objectiveLevel'])remember(r.geometry?.[key]);
  r.geometry=geometry(r.geometry);
  if(r.trade) {
    const t=r.trade;
    const research34=t.research34?{...t.research34,decision:measurement(t.research34.decision)}:undefined;
    if(research34?.nearestArm?.trade){
      const arm=research34.nearestArm.trade;
      for(const key of ['reactionLevel','stopLevel','objectiveLevel'])remember(arm.geometry?.[key]);
      research34.nearestArm={...research34.nearestArm,trade:{...arm,geometry:geometry(arm.geometry)}};
    }
    for(const key of ['reactionLevel','stopLevel','objectiveLevel'])remember(t.geometry?.[key]);
    if(r.transitions?.length===1 && r.transitions[0]==='MARK') {
      r.trade=pick(t,['tradeId','candidateId','episodeId','symbol','side','configHash','policy','originCaptureCohort',
        'status','lastBarAt','lastMark','lastMarkAt','entryPrice','filledAt','quantity','unrealizedNetBeforeFunding',
        'mfePerUnit','maePerUnit','excursionPrecision','executionAllowed']);
    }else r.trade={...t,geometry:geometry(t.geometry)};
    if(research34){
      if(research34.fill)research34.fill=measurement({...research34.fill,objectiveInventory:[]});
      if(r.transitions?.length===1&&r.transitions[0]==='MARK') {
        r.trade.research34=pick(research34,['version','mfeAt','maeAt','rawTouches','costRiskTouches','terminalTouches',
          'breakEven','structuralProgress','defendedCursorAt']);
        const arm=research34.nearestArm;
        if(arm)r.trade.research34.nearestArm={...pick(arm,['policy','researchOnly','identicalToControl','status','outcome','rawRR','costRR','netR']),
          trade:pick(arm.trade,['tradeId','status','entryPrice','quantity','filledAt','closedAt','exitPrice','lastBarAt','netPnlBeforeFunding','realizedRBeforeFunding','fundingStatus'])};
      }else r.trade.research34=research34;
    }
  }
  return {row:r,definitions:[...new Map(definitions.map(d=>[d.definitionId,d])).values()]};
}
module.exports={SCHEMA,compact,definition,state};
