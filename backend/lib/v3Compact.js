'use strict';
const crypto=require('crypto');
const SCHEMA='V3_COMPACT_V1';
const pick=(o,keys)=>Object.fromEntries(keys.filter(k=>o?.[k]!==undefined).map(k=>[k,o[k]]));
const id=o=>crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0,24);
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
    for(const key of ['reactionLevel','stopLevel','objectiveLevel'])remember(t.geometry?.[key]);
    if(r.transitions?.length===1 && r.transitions[0]==='MARK') {
      r.trade=pick(t,['tradeId','candidateId','episodeId','symbol','side','configHash','policy','originCaptureCohort',
        'status','lastBarAt','lastMark','lastMarkAt','entryPrice','filledAt','quantity','unrealizedNetBeforeFunding',
        'mfePerUnit','maePerUnit','excursionPrecision','executionAllowed']);
    }else r.trade={...t,geometry:geometry(t.geometry)};
  }
  return {row:r,definitions:[...new Map(definitions.map(d=>[d.definitionId,d])).values()]};
}
module.exports={SCHEMA,compact,definition,state};
