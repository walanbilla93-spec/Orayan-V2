"use strict";
// Observe the existing simulator's exact candle iteration. No order, price or trade mutation.
function sample(trade, bar, previous = {}) {
  if (!trade.filledAt || bar.ts < trade.filledAt) return null;
  const entry = Number(trade.fillPrice ?? trade.entryPrice),
    stop = Number(previous.initialStop ?? trade.initialSl ?? trade.sl),
    risk = Math.abs(entry - stop),
    buy = trade.side === "BUY";
  if (
    !(
      entry > 0 &&
      risk > 0 &&
      Number.isFinite(bar.high) &&
      Number.isFinite(bar.low)
    )
  )
    return null;
  const favorable = buy ? (bar.high - entry) / risk : (entry - bar.low) / risk,
    adverse = buy ? (bar.low - entry) / risk : (entry - bar.high) / risk;
  return {
    mfeR: Math.max(previous.mfeR ?? 0, favorable),
    maeR: Math.min(previous.maeR ?? 0, adverse),
    initialStop: stop,
    initialEntry: entry,
    excursionPrecision: "EXISTING_SIMULATOR_1M_OHLC_BOUND",
    intrabarOrder: "UNKNOWN",
    includesPossiblePreFillExtremes:
      previous.includesPossiblePreFillExtremes || bar.ts === trade.filledAt,
    terminalMinuteMayIncludePostExitExtremes: true,
    lastObservedBarAt: bar.ts,
  };
}
function observeMinute(trade, bar) {
  const minimal = require("./minimalCapture");
  if (!minimal.researchEnabled()) return false;
  return minimal.safe((c) => {
    const previous = c.state.extremes?.[trade.id] || {},
      excursion = sample(trade, bar, previous);
    if (
      !excursion ||
      (excursion.mfeR === previous.mfeR && excursion.maeR === previous.maeR)
    )
      return false;
    return c.emit(
      "lifecycle",
      {
        event: "EXCURSION_BOUNDARY",
        at: Date.now(),
        sourceEpisodeId:
          trade.episodeId ||
          require("./researchCapture").candidateLink(trade.signalId)?.episodeId,
        tradeId: trade.id,
        symbol: trade.symbol,
        side: trade.side,
        mode: trade.engine === "MARCI_SHADOW" ? "SHADOW" : "PAPER",
        excursion,
        ...excursion,
      },
      {
        key: "extrema:" + trade.id,
        signature: JSON.stringify([excursion.maeR, excursion.mfeR]),
      },
    );
  });
}
module.exports = { sample, observeMinute };
