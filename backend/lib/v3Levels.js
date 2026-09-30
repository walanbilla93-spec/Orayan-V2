'use strict';
const {confirmedPivots} = require('./v3Contracts');

// OHLCV volume allocation is an approximation, never labelled actual taker delta.
function profile(candles, rows = 30) {
  if (!candles.length) return null;
  const low=Math.min(...candles.map(c=>c.low)), high=Math.max(...candles.map(c=>c.high));
  if (!(high>low) || !candles.some(c=>c.volume>0)) return null;
  const step=(high-low)/rows, bins=Array(rows).fill(0), touches=Array(rows).fill(0);
  for (const c of candles) {
    const first=Math.max(0,Math.min(rows-1,Math.floor((c.low-low)/step)));
    const last=Math.max(first,Math.min(rows-1,Math.floor((c.high-low)/step)));
    for(let j=first;j<=last;j++){bins[j]+=c.volume/(last-first+1);touches[j]++;}
  }
  const best=bins.indexOf(Math.max(...bins)), mostTouched=touches.indexOf(Math.max(...touches));
  return {price:low+(best+.5)*step,zoneLow:low+best*step,zoneHigh:low+(best+1)*step,
    binVolume:bins[best],totalVolume:bins.reduce((a,b)=>a+b,0),rows,
    mostTouchedPrice:low+(mostTouched+.5)*step,source:'OHLCV_UNIFORM_INTERSECTING_BINS_V1'};
}

function reaction(level, candle, previousClose, side, intervalMs) {
  if (candle.ts < level.knownAt || !level.active || !['BUY','SELL'].includes(side))
    return {state:'INELIGIBLE',type:null,touched:false,retested:false,reclaim:false,rejection:false,at:null};
  const touched=candle.low<=level.zoneHigh && candle.high>=level.zoneLow;
  const reclaim=touched && (side==='BUY' ? previousClose<=level.zoneHigh && candle.close>level.zoneHigh :
    previousClose>=level.zoneLow && candle.close<level.zoneLow);
  const rejection=touched && (side==='BUY' ? candle.open>level.zoneHigh && candle.close>level.zoneHigh :
    candle.open<level.zoneLow && candle.close<level.zoneLow);
  const type=reclaim?'RECLAIM':rejection?'REJECTION':touched?'TOUCH':null;
  return {state:type||'NO_REACTION',type,touched,retested:touched && level.touchCount>0,
    reclaim,rejection,at:type?candle.ts+intervalMs:null};
}

function premiumDiscount(range, price, side, decisionAt) {
  const empty={rangeHigh:null,rangeLow:null,equilibrium:null,pricePercentile:null,classification:'UNAVAILABLE',
    rangeKnownAt:null,rangeAgeMs:null,rangeSource:null,directionRelative:null,researchOnly:true};
  if (!range || !(range.high>range.low) || !(price>0) || range.knownAt>decisionAt) return empty;
  const p=(price-range.low)/(range.high-range.low);
  const classification=p>=.48 && p<=.52?'EQUILIBRIUM':p<.48?'DISCOUNT':'PREMIUM';
  return {...empty,rangeHigh:range.high,rangeLow:range.low,equilibrium:(range.high+range.low)/2,
    pricePercentile:100*p,classification,rangeKnownAt:range.knownAt,rangeAgeMs:decisionAt-range.knownAt,
    rangeSource:'LATEST_OPPOSITE_CONFIRMED_SWINGS_BEFORE_REACTION_V1',
    highAnchorAt:range.highAnchorAt,lowAnchorAt:range.lowAnchorAt,
    outsideRange:p<0||p>1,directionRelative:classification==='EQUILIBRIUM'?'NEUTRAL':
      side==='BUY'?(classification==='DISCOUNT'?'LONG_DISCOUNT':'LONG_PREMIUM'):
      side==='SELL'?(classification==='PREMIUM'?'SHORT_PREMIUM':'SHORT_DISCOUNT'):null};
}

function measure({candles,side,price,intervalMs,decisionAt}) {
  // Levels/range are built from the prefix BEFORE the reaction bar opens.
  const prior=candles.slice(0,-1), latest=candles.at(-1), pivots=confirmedPivots(prior,2,intervalMs);
  const levels=[];
  const seed=(type,p,zoneLow,zoneHigh,direction,extra={})=>({
    id:[type,p.anchorAt,p.knownAt,direction].join(':'),type,source:'ORAYAN_V3_LEVELS_RESEARCH_V1',
    anchorAt:p.anchorAt,knownAt:p.knownAt,price:(zoneLow+zoneHigh)/2,zoneLow,zoneHigh,direction,
    active:true,invalidatedAt:null,touchCount:0,lastTouchAt:null,...extra});
  for (const [list,direction,type] of [[pivots.highs,'SELL','SWING_HIGH'],[pivots.lows,'BUY','SWING_LOW']]) {
    for (const p of list.slice(-8)) levels.push(seed(type,p,p.price,p.price,direction,
      {structuralRole:p===list.at(-1)?'LATEST':'PRIOR',invalidationPrice:p.price}));
  }
  // BOS anchors an OB only when a previously confirmed swing is crossed on a CLOSED bar.
  // Borrow the supplied OB's POC-touch anchor and lifecycle, without porting its drawing code.
  const broken=new Set();
  for (let i=1;i<prior.length;i++) {
    for (const [list,sideAtBreak] of [[pivots.highs,'BUY'],[pivots.lows,'SELL']]) {
      const eligible=list.filter(p=>p.knownAt<=prior[i].ts), p=eligible.at(-1);
      if (!p) continue;
      const key=sideAtBreak+':'+p.anchorAt;
      const crossed=sideAtBreak==='BUY' ? prior[i-1].close<=p.price && prior[i].close>p.price :
        prior[i-1].close>=p.price && prior[i].close<p.price;
      if (!crossed || broken.has(key)) continue;
      broken.add(key);
      const leg=prior.slice(p.i,i+1), vp=profile(leg,40);
      if(!vp)continue;
      const anchors=leg.slice(0,-1).filter(c=>c.low<=vp.mostTouchedPrice && c.high>=vp.mostTouchedPrice);
      if(!anchors.length)continue;
      const anchor=anchors.reduce((a,c)=>sideAtBreak==='BUY'?(c.low<a.low?c:a):(c.high>a.high?c:a));
      const volume=leg.reduce((a,c)=>a+c.volume,0),bull=leg.filter(c=>c.close>c.open).reduce((a,c)=>a+c.volume,0);
      const bear=leg.filter(c=>c.close<c.open).reduce((a,c)=>a+c.volume,0);
      levels.push(seed('ORDER_BLOCK',{anchorAt:anchor.ts,knownAt:prior[i].ts+intervalMs},anchor.low,anchor.high,sideAtBreak,
        {bosAt:prior[i].ts+intervalMs,brokenSwingAt:p.anchorAt,invalidationPrice:sideAtBreak==='BUY'?anchor.low:anchor.high,
          volumeContext:{total:volume,bull,bear,deltaProxy:bull-bear,source:'CANDLE_DIRECTION_PROXY',actualTakerDelta:null}}));
    }
  }
  const vp=profile(prior.slice(-120));
  if(vp)levels.push(seed('POC',{anchorAt:prior.slice(-120)[0].ts,knownAt:prior.at(-1).ts+intervalMs},
    vp.zoneLow,vp.zoneHigh,null,{profile:vp,invalidationPrice:null}));
  for (const level of levels) {
    for (const c of prior) {
      if(c.ts<level.knownAt)continue;
      if(level.direction && (level.direction==='BUY'?c.close<level.zoneLow:c.close>level.zoneHigh)) {
        level.active=false;level.invalidatedAt=c.ts+intervalMs;break;
      }
      if(c.low<=level.zoneHigh && c.high>=level.zoneLow){level.touchCount++;level.lastTouchAt=c.ts+intervalMs;}
    }
    level.ageMs=decisionAt-level.knownAt;
    level.distancePct=100*(price-level.price)/level.price;
    level.reaction=reaction(level,latest,prior.at(-1).close,side,intervalMs);
    // Complete the current update's lifecycle AFTER evaluating the known level.
    if(level.active && level.direction && (level.direction==='BUY'?latest.close<level.zoneLow:latest.close>level.zoneHigh)) {
      level.active=false;level.invalidatedAt=latest.ts+intervalMs;
      level.reaction={...level.reaction,state:'INVALIDATED',type:null,reclaim:false,rejection:false};
    }
  }
  const selected=levels.filter(l=>l.active && (!l.direction||l.direction===side)).sort((a,b)=>
    Number(!!b.reaction.type)-Number(!!a.reaction.type) || Math.abs(a.distancePct)-Math.abs(b.distancePct) ||
    b.knownAt-a.knownAt || a.id.localeCompare(b.id))[0]||null;
  const h=pivots.highs.at(-1),l=pivots.lows.at(-1);
  const range=h&&l?{high:h.price,low:l.price,knownAt:Math.max(h.knownAt,l.knownAt),highAnchorAt:h.anchorAt,lowAnchorAt:l.anchorAt}:null;
  const tags=[];
  for (const [type,tag] of [['SWING_LOW','swing'],['SWING_HIGH','swing'],['ORDER_BLOCK','OB'],['POC','POC']])
    if(levels.some(l=>l.active && (!l.direction||l.direction===side) && l.type===type && l.reaction.reclaim))tags.push(tag+'+reclaim');
  const ob=levels.filter(l=>l.active && l.type==='ORDER_BLOCK' && l.direction===side),poc=levels.find(l=>l.type==='POC');
  if(poc && ob.some(l=>l.zoneLow<=poc.zoneHigh && l.zoneHigh>=poc.zoneLow))tags.push('OB+POC');
  return {selected,levels:levels.slice(-32),levelCount:levels.length,
    premiumDiscount:premiumDiscount(range,price,side,decisionAt),confluence:[...new Set(tags)],
    reaction: selected?.reaction || {state:'NO_LEVEL',type:null,touched:false,reclaim:false,rejection:false},
    volumeDelta:{actualTakerDelta:null,source:'UNAVAILABLE'},profile:vp};
}
module.exports={profile,reaction,premiumDiscount,measure};
