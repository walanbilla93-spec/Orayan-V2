'use strict';

// Pure contracts: the provider owns forming-candle removal. V3 fails closed on bad input.
function validateClosedCandles(candles, intervalMs, decisionAt) {
  if (!Number.isFinite(intervalMs) || intervalMs < 60000 || !Number.isFinite(decisionAt)) return 'INVALID_CLOCK';
  if (!Array.isArray(candles) || candles.length < 5 || candles.length > 1000) return 'INVALID_HISTORY';
  let previous = -Infinity;
  for (const c of candles) {
    if (![c.ts,c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) ||
        c.ts <= previous || c.ts + intervalMs > decisionAt || c.low <= 0 ||
        c.high < Math.max(c.open,c.close,c.low) || c.low > Math.min(c.open,c.close) || c.volume < 0)
      return 'INVALID_CLOSED_CANDLE';
    if (previous !== -Infinity && c.ts - previous !== intervalMs) return 'CANDLE_GAP';
    previous = c.ts;
  }
  return null;
}

function confirmedPivots(candles, width = 2, intervalMs = 900000) {
  const highs = [], lows = [];
  for (let i = width; i < candles.length - width; i++) {
    const c = candles[i], neighbors = candles.slice(i-width,i+width+1).filter((_,j)=>j!==width);
    const p = {i, anchorAt:c.ts, knownAt:candles[i+width].ts+intervalMs};
    if (neighbors.every(x=>x.high<c.high)) highs.push({...p,price:c.high});
    if (neighbors.every(x=>x.low>c.low)) lows.push({...p,price:c.low});
  }
  return {highs,lows};
}

function trendPermission(regime, side) {
  return (side === 'BUY' && regime === 'BULL_TREND') || (side === 'SELL' && regime === 'BEAR_TREND');
}

// Bybit allLiquidation S is POSITION side, not the forced closing-order side.
function positionSideTotals(rows, from, to, asOf) {
  const selected = rows.filter(x=>x.timestamp>=from && x.timestamp<to && x.timestamp<=asOf && x.receivedAt<=asOf);
  const sum = side=>selected.filter(x=>x.side===side).reduce((a,x)=>a+x.notional,0);
  const longNotional=sum('Buy'), shortNotional=sum('Sell');
  return {longNotional,shortNotional,totalNotional:longNotional+shortNotional,
    sideMeaning:'Buy=long liquidation; Sell=short liquidation',interpretationVersion:'BYBIT_POSITION_SIDE_V1'};
}

module.exports = {validateClosedCandles,confirmedPivots,trendPermission,positionSideTotals};
