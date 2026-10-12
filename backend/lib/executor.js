'use strict';

const bybit = require('./bybit');
const marketData = require('./marketData');
const logger = require('./logger');
const { num, uid, roundToTick } = require('./util');
const { estimateFees } = require('./risk');

/*
 * PAPER FILL HONESTY
 *
 * Three rules, each of which existed because its absence produced fake profit:
 *
 *  1. Book P&L on the ACTUAL fill price, never the planned price.
 *  2. A take-profit must trade THROUGH the level, not merely wick to it. A high that exactly
 *     touches the target is not a fill.
 *  3. If a single candle contains both the stop and the target, the outcome is genuinely unknown
 *     at 1-minute resolution — resolve it as a LOSS. Assuming the good side is how a backtest
 *     invents a win rate it cannot reproduce live.
 */

function createPendingOrder({ signal, sizing, settings }) {
  return {
    id: uid('trd'),
    signalId: signal.id,
    symbol: signal.symbol,
    side: signal.side,
    status: 'PENDING',
    mode: settings.mode,
    createdAt: Date.now(),
    expiresAt: Date.now() + settings.entryWindowMin * 60000,
    plannedEntry: sizing.entry,
    sl: sizing.sl,
    tp: signal.tp,
    qty: sizing.qty,
    notional: sizing.notional,
    margin: sizing.margin,
    plannedRisk: sizing.actualRisk,
    leverage: settings.leverage,
    score: signal.score,
    plannedRR: signal.rr,
    timeframe: signal.timeframe,
    btcRegime: signal.btcRegime,
    turnover24h: signal.market.turnover24h,
    engine: signal.engine || 'STRUCTURE',
    entryPath: signal.entryPath || null,
    structureEvent: signal.structureEvent || null,
    // Freeze the signal-time research snapshot into the trade. Do not recompute at fill/close:
    // resolved-trade analysis must use only information that existed when the setup was born.
    locationResearch: signal.locationResearch ? { ...signal.locationResearch } : null,
    createdAtIso: new Date().toISOString(),
    // filled in later
    fillPrice: null,
    filledAt: null,
    lastCheckedTs: null,
    exitPrice: null,
    closedAt: null,
    closeReason: null,
    grossPnl: null,
    fees: null,
    netPnl: null,
    realisedRR: null,
    exchangeOrderId: null,
  };
}

/** Advance one paper trade against 1-minute candles. Returns true if the trade changed. */
async function stepPaperTrade(trade, settings, observeMinute) {
  const testnet = settings.testnet;

  // Only fetch back to where we last looked, not to the fill. Bybit caps a kline page at 1000
  // bars; on 1-minute candles that is under 17 hours, while maxHoldMin allows up to 72. Anchoring
  // the window to filledAt meant that once a trade aged past the cap, the earliest minutes fell
  // outside the fetch and any stop or target hit in them was never seen — the trade would drift
  // to its time stop and book a price that never happened.
  const anchor = num(trade.lastCheckedTs) || trade.filledAt || trade.createdAt;
  const sinceMin = Math.ceil((Date.now() - anchor) / 60000) + 5;
  const limit = Math.min(1000, Math.max(10, sinceMin));

  let candles;
  try {
    candles = await marketData.getCandles(trade.symbol, '1', limit, { testnet, ttlMs: 10000 });
  } catch (e) {
    logger.warn('executor', `Could not refresh candles for ${trade.symbol}`, { error: e.message });
    return false;
  }
  if (!candles.length) return false;

  const isBuy = trade.side === 'BUY';
  const buffer = trade.plannedEntry * (num(settings.entryBufferBps) / 1e4);
  let changed = false;

  // ── Waiting for the entry level ─────────────────────────────────────────────────────────
  if (trade.status === 'PENDING') {
    const after = candles.filter((c) => c.ts >= trade.createdAt);
    for (const c of after) {
      const touched = isBuy
        ? c.low <= trade.plannedEntry - buffer
        : c.high >= trade.plannedEntry + buffer;
      if (touched) {
        trade.status = 'OPEN';
        trade.fillPrice = trade.plannedEntry; // resting limit — fills at the level or better
        trade.filledAt = c.ts;
        changed = true;
        logger.info('executor', `Paper fill ${trade.symbol} ${trade.side} @ ${trade.fillPrice}`);
        break;
      }
    }
    if (trade.status === 'PENDING') {
      if (Date.now() > trade.expiresAt) {
        trade.status = 'EXPIRED';
        trade.closedAt = Date.now();
        trade.closeReason = 'Entry window passed without price returning to the level';
        trade.netPnl = 0;
        trade.grossPnl = 0;
        trade.fees = 0;
        changed = true;
        logger.info('executor', `Entry expired for ${trade.symbol} — never reached the level`);
      }
      return changed;
    }
  }

  if (trade.status !== 'OPEN') return changed;

  // ── Managing an open position ───────────────────────────────────────────────────────────
  const tpBuf = trade.tp * (num(settings.tpThroughBps) / 1e4);
  const slSlip = num(settings.slSlipBps) / 1e4;
  // Resume from the last bar we already examined, never earlier than the fill.
  const from = Math.max(num(trade.filledAt), num(trade.lastCheckedTs));
  const after = candles.filter((c) => c.ts >= from);

  for (const c of after) {
    try { if(observeMinute)observeMinute(trade,c); } catch (_) { /* Observation cannot alter execution. */ }
    const hitTp = isBuy ? c.high >= trade.tp + tpBuf : c.low <= trade.tp - tpBuf;
    const hitSl = isBuy ? c.low <= trade.sl : c.high >= trade.sl;

    if (hitTp && hitSl) {
      closeTrade(trade, isBuy ? trade.sl * (1 - slSlip) : trade.sl * (1 + slSlip), c.ts,
        'Stop and target both inside one candle — resolved as a loss, order unknowable at this resolution', settings);
      return true;
    }
    if (hitSl) {
      closeTrade(trade, isBuy ? trade.sl * (1 - slSlip) : trade.sl * (1 + slSlip), c.ts, 'Stop loss', settings);
      return true;
    }
    if (hitTp) {
      closeTrade(trade, trade.tp, c.ts, 'Take profit', settings);
      return true;
    }
  }

  // Nothing triggered: remember how far we got so the next pass need not refetch from the fill.
  if (after.length) {
    const newest = after[after.length - 1].ts;
    // Deliberately does NOT set `changed`. This is a recomputable optimisation, not state worth
    // a disk write every scan — if it is lost on restart the anchor falls back to filledAt,
    // which is simply the old behaviour.
    if (newest > num(trade.lastCheckedTs)) trade.lastCheckedTs = newest;
  }

  // ── Time stop ───────────────────────────────────────────────────────────────────────────
  if (Date.now() - trade.filledAt > settings.maxHoldMin * 60000) {
    const last = candles[candles.length - 1];
    closeTrade(trade, last.close, Date.now(), 'Max hold time reached', settings);
    return true;
  }

  return changed;
}

function closeTrade(trade, exitPrice, closedAt, reason, settings) {
  const isBuy = trade.side === 'BUY';
  trade.status = 'CLOSED';
  trade.exitPrice = exitPrice;
  trade.closedAt = closedAt;
  trade.closeReason = reason;

  // Always off the real fill price, never the planned entry.
  const gross = isBuy
    ? (exitPrice - trade.fillPrice) * trade.qty
    : (trade.fillPrice - exitPrice) * trade.qty;

  const fees = estimateFees({
    notional: trade.fillPrice * trade.qty,
    exitNotional: exitPrice * trade.qty,
    settings,
  });
  trade.grossPnl = gross;
  trade.fees = fees;
  trade.netPnl = gross - fees;
  // Clear mark-to-market fields so closed rows never show a stale floating figure.
  trade.markPrice = null;
  trade.unrealisedPnl = null;
  trade.unrealisedRR = null;

  const risk = Math.abs(trade.fillPrice - trade.sl) * trade.qty;
  trade.realisedRR = risk > 0 ? trade.netPnl / risk : null;

  logger.info('executor',
    `Closed ${trade.symbol} ${trade.side} — ${reason} — net ${trade.netPnl.toFixed(4)} USDT`);
}

/**
 * Mark-to-market P&L for an OPEN trade, using the same fee model as closeTrade so the floating
 * number is what you would book if you closed at this mark right now.
 * Returns null when the trade is not open or inputs are incomplete.
 */
function floatingPnl(trade, markPrice, settings) {
  if (!trade || trade.status !== 'OPEN') return null;
  const fill = num(trade.fillPrice);
  const qty = num(trade.qty);
  const mark = num(markPrice);
  if (!(fill > 0) || !(qty > 0) || !(mark > 0)) return null;

  const isBuy = trade.side === 'BUY';
  const gross = isBuy ? (mark - fill) * qty : (fill - mark) * qty;
  const fees = estimateFees({
    notional: fill * qty,
    exitNotional: mark * qty,
    settings,
  });
  const net = gross - fees;
  const risk = Math.abs(fill - num(trade.sl)) * qty;
  return {
    markPrice: mark,
    unrealisedPnl: net,
    unrealisedRR: risk > 0 ? net / risk : null,
  };
}

// ── Live execution ────────────────────────────────────────────────────────────────────────

let entryInFlight=false;
function hasUnresolvedLiveOutcome(trades) {
  return trades.some(t=>t.mode==='live'&&t.privateOutcome);
}
function unknownError(trade) {
  const e=new Error('Live mutation requires reconciliation before further admission');
  e.reasonCode='UNKNOWN_PRIVATE_OUTCOME';e.context={...trade.privateOutcome};return e;
}
async function submitLiveMutation({trade,settings,persist,endpoint,params,purpose}) {
  if (trade.privateOutcome) throw unknownError(trade);
  const obligation={reasonCode:'UNKNOWN_PRIVATE_OUTCOME',purpose,endpoint,
    orderLinkId:params.orderLinkId||null,orderId:params.orderId||null,
    symbol:trade.symbol,testnet:settings.testnet!==false,startedAt:Date.now()};
  trade.privateOutcome=obligation;
  // Write intent before any possible send. On restart it is conservatively unknown.
  if (typeof persist!=='function'||persist()!==true) {
    delete trade.privateOutcome;
    const e=new Error('Live mutation intent could not be persisted; request not sent');
    e.reasonCode='PRIVATE_REQUEST_NOT_SENT';throw e;
  }
  try {
    const res=await bybit.privatePost(endpoint,params,obligation.testnet);
    if (purpose==='entry') {
      if (!res?.orderId) throw unknownError(trade);
      trade.exchangeOrderId=res.orderId;
    }
    delete trade.privateOutcome;
    if (persist()!==true) {trade.privateOutcome=obligation;throw unknownError(trade);}
    return res;
  } catch (e) {
    if (!['PROVEN_PRIVATE_REJECTION','PRIVATE_REQUEST_NOT_SENT','QUEUE_WAIT_EXPIRED','CRITICAL_QUEUE_CAPACITY'].includes(e.reasonCode)) {
      trade.privateOutcome=obligation;
      e=unknownError(trade);
    } else {
      delete trade.privateOutcome;
    }
    if (persist()!==true) {trade.privateOutcome=obligation;throw unknownError(trade);}
    throw e;
  }
}

async function placeLiveOrder({ trade, settings, instrument, trades, persist }) {
  if (!Array.isArray(trades)||entryInFlight||hasUnresolvedLiveOutcome(trades)) {
    const e=new Error('Live entry admission fenced by an unresolved mutation');
    e.reasonCode='LIVE_ADMISSION_FENCED';throw e;
  }
  entryInFlight=true;
  try {return await placeLiveOrderImpl({trade,settings,instrument,persist});}
  finally {entryInFlight=false;}
}
async function placeLiveOrderImpl({ trade, settings, instrument, persist }) {
  if (!bybit.keySet()) {
    const e=new Error('Cannot place a live order: Bybit API credentials are not set.');
    e.reasonCode='PRIVATE_REQUEST_NOT_SENT';throw e;
  }

  // Leverage is per-symbol on Bybit and silently persists between sessions.
  try {
    await submitLiveMutation({trade,settings,persist,purpose:'leverage',endpoint:'/v5/position/set-leverage',params:{
      category: 'linear',
      symbol: trade.symbol,
      buyLeverage: String(settings.leverage),
      sellLeverage: String(settings.leverage),
    }});
  } catch (e) {
    if (trade.privateOutcome||e.reasonCode==='PRIVATE_REQUEST_NOT_SENT') throw e;
    // retCode 110043 = leverage already at this value; not an error.
    if (e.retCode !== 110043) {
      logger.warn('executor', `Could not set leverage on ${trade.symbol}`, { error: e.message });
    }
  }

  const params = {
    category: 'linear',
    symbol: trade.symbol,
    side: trade.side === 'BUY' ? 'Buy' : 'Sell',
    orderType: 'Limit',
    qty: String(trade.qty),
    price: String(roundToTick(trade.plannedEntry, instrument?.tickSize)),
    timeInForce: 'GTC',
    // Attach protection to the order itself, so a crashed process cannot leave a naked position.
    stopLoss: String(roundToTick(trade.sl, instrument?.tickSize)),
    takeProfit: String(roundToTick(trade.tp, instrument?.tickSize)),
    tpslMode: 'Full',
    slTriggerBy: 'MarkPrice',
    tpTriggerBy: 'MarkPrice',
    orderLinkId: trade.id,
    reduceOnly: false,
  };

  await submitLiveMutation({trade,settings,persist,purpose:'entry',endpoint:'/v5/order/create',params});
  logger.info('executor', `Live order placed on ${trade.symbol} ${trade.side}`, { orderId: trade.exchangeOrderId });
  return trade;
}

async function cancelLiveOrder({ trade, settings, persist }) {
  if (trade.privateOutcome) throw unknownError(trade);
  if (!trade.exchangeOrderId) return;
  try {
    await submitLiveMutation({trade,settings,persist,purpose:'cancel',endpoint:'/v5/order/cancel',params:{
      category: 'linear',
      symbol: trade.symbol,
      orderId: trade.exchangeOrderId,
      orderLinkId:trade.id,
    }});
    logger.info('executor', `Cancelled resting order on ${trade.symbol}`);
  } catch (e) {
    logger.warn('executor', `Could not cancel order on ${trade.symbol}`, { error: e.message });
    throw e;
  }
}

async function closeLivePosition({ trade, settings, persist }) {
  if (trade.privateOutcome) throw unknownError(trade);
  trade.closeAttempt=(trade.closeAttempt||0)+1;
  try {
    await submitLiveMutation({trade,settings,persist,purpose:'close',endpoint:'/v5/order/create',params:{
      category: 'linear',
      symbol: trade.symbol,
      side: trade.side === 'BUY' ? 'Sell' : 'Buy',
      orderType: 'Market',
      qty: String(trade.qty),
      reduceOnly: true,
      timeInForce: 'IOC',
      orderLinkId:`${trade.id}-c${trade.closeAttempt}`,
    }});
    logger.warn('executor', `Sent market close for ${trade.symbol}`);
  } catch (e) {
    logger.error('executor', `Could not close position on ${trade.symbol}`, { error: e.message });
    throw e;
  }
}

/**
 * Reconcile local live trades against the exchange. The exchange is always the source of truth —
 * local state is a cache and is assumed wrong whenever the two disagree.
 */
async function reconcilePrivateOutcome(trade) {
  const o=trade.privateOutcome;
  if (!o) return false;
  // Leverage ambiguity precedes entry submission: verifying the setting proves no entry
  // was submitted by this intent. Never submit the abandoned entry during reconciliation.
  if (o.purpose==='leverage') {
    const r=await bybit.privateGet('/v5/position/list',{category:'linear',symbol:o.symbol},o.testnet);
    if (!r?.list?.length||!r.list.every(p=>p.symbol===o.symbol&&Number(p.leverage)===Number(trade.leverage))) return false;
    trade.status='CANCELLED';trade.closedAt=Date.now();trade.closeReason='Leverage reconciled; entry was not submitted';
    trade.netPnl=0;trade.grossPnl=0;trade.fees=0;delete trade.privateOutcome;return true;
  }
  const params={category:'linear',symbol:o.symbol,orderLinkId:o.orderLinkId||undefined,orderId:o.orderId||undefined};
  let order;
  for (const endpoint of ['/v5/order/realtime','/v5/order/history']) {
    const r=await bybit.privateGet(endpoint,params,o.testnet);
    order=r?.list?.find(x=>x.symbol===o.symbol&&x.orderId&&
      (!o.orderLinkId||x.orderLinkId===o.orderLinkId)&&(!o.orderId||x.orderId===o.orderId));
    if (order) break;
  }
  // An empty eventually-consistent query is not proof of absence or rejection.
  if (!order) return false;
  const qty=order.cumExecQty!==''&&order.cumExecQty!=null?Number(order.cumExecQty):NaN;
  const terminal=['Rejected','Cancelled','Deactivated'].includes(order.orderStatus);
  if (o.purpose==='close') {
    if (terminal&&qty===0) {delete trade.privateOutcome;return true;}
    // Partial close P&L is not proof that the whole position is gone.
    if (order.orderStatus==='Filled'&&qty>=num(trade.qty)&&qty>0) {
      trade.closeExchangeOrderId=order.orderId;return true;
    }
    return false;
  }
  trade.exchangeOrderId=order.orderId;
  trade.reconciledEntryOrderId=order.orderId;
  if (terminal&&qty===0) {
    trade.status=order.orderStatus==='Rejected'?'REJECTED':'CANCELLED';
    trade.closedAt=Number(order.updatedTime)||Date.now();trade.closeReason=`Exchange order ${order.orderStatus}`;
    trade.netPnl=0;trade.grossPnl=0;trade.fees=0;
  } else if ((order.orderStatus==='Filled'||terminal)&&qty>0&&Number(order.avgPrice)>0) {
    trade.status='OPEN';trade.fillPrice=Number(order.avgPrice);
    trade.filledAt=Number(order.createdTime)||Date.now();
  } else if (o.purpose==='entry'&&order.orderStatus==='New'&&qty===0) {
    trade.status='PENDING';
  } else return true; // Partial fills/unrecognised states retain the fence.
  delete trade.privateOutcome;return true;
}

async function syncLiveTrades(trades, settings, persist) {
  if (!bybit.keySet()) return { changed: 0 };
  const testnet = settings.testnet;
  let changed = 0;
  for (const t of trades.filter(t=>t.mode==='live'&&t.privateOutcome)) {
    try {
      const obligation=t.privateOutcome;
      if (await reconcilePrivateOutcome(t)) {
        changed++;
        if (typeof persist!=='function'||persist()!==true) t.privateOutcome=obligation;
      }
    } catch (e) {logger.warn('executor',`Private outcome still unresolved on ${t.symbol}`,{error:e.message});}
  }

  const live = trades.filter((t) => t.mode === 'live' && ['PENDING', 'OPEN'].includes(t.status));
  if (!live.length) return { changed };

  let positions = [];
  let closedPnls = [];
  try {
    const posRes = await bybit.privateGet('/v5/position/list', { category: 'linear', settleCoin: 'USDT', limit: 200 }, testnet);
    positions = posRes?.list || [];
    const pnlRes = await bybit.privateGet('/v5/position/closed-pnl', { category: 'linear', limit: 100 }, testnet);
    closedPnls = pnlRes?.list || [];
  } catch (e) {
    logger.warn('executor', 'Could not sync live state from Bybit', { error: e.message });
    return { changed };
  }

  const posBySymbol = new Map(positions.filter((p) => num(p.size) > 0).map((p) => [p.symbol, p]));

  for (const t of live) {
    // Never expire an uncertain entry/cancel, or infer a fill from another same-symbol order.
    if (t.privateOutcome && !(t.privateOutcome.purpose==='close'&&t.closeExchangeOrderId)) continue;
    const pos = posBySymbol.get(t.symbol);

    if (t.status === 'PENDING' && pos) {
      t.status = 'OPEN';
      t.fillPrice = num(pos.avgPrice);
      t.filledAt = num(pos.createdTime) || Date.now();
      changed++;
      logger.info('executor', `Live fill confirmed on ${t.symbol} @ ${t.fillPrice}`);
      continue;
    }

    if (t.status === 'OPEN' && pos) {
      // Stamp exchange mark-to-market so the UI can show floating P&L between API polls
      // without waiting for a close. Prefer Bybit's own unrealisedPnl when present.
      const mark = num(pos.markPrice) || num(pos.avgPrice);
      if (mark > 0) t.markPrice = mark;
      if (pos.unrealisedPnl != null && pos.unrealisedPnl !== '') {
        t.unrealisedPnl = num(pos.unrealisedPnl);
        const risk = Math.abs(num(t.fillPrice) - num(t.sl)) * num(t.qty);
        t.unrealisedRR = risk > 0 ? t.unrealisedPnl / risk : null;
      } else if (mark > 0) {
        const fp = floatingPnl(t, mark, settings);
        if (fp) {
          t.unrealisedPnl = fp.unrealisedPnl;
          t.unrealisedRR = fp.unrealisedRR;
        }
      }
      continue;
    }

    if (t.status === 'OPEN' && !pos) {
      // Position is gone from the exchange — find the settled P&L record for it.
      const rec = closedPnls
        .filter((c) => c.symbol === t.symbol && (t.privateOutcome
          ? c.orderId===t.closeExchangeOrderId
          : !t.reconciledEntryOrderId||c.orderId===t.reconciledEntryOrderId))
        .sort((a, b) => num(b.updatedTime) - num(a.updatedTime))[0];
      if (rec) {
        t.status = 'CLOSED';
        t.exitPrice = num(rec.avgExitPrice);
        t.closedAt = num(rec.updatedTime) || Date.now();
        // Bybit's closedPnl is already net of fees. Previously `fees` was reconstructed from the
        // configured fee rates while `grossPnl` was set equal to `netPnl` — so gross === net,
        // and `fees` reconciled with neither. Any fee-drag analysis on live rows was meaningless,
        // which matters because fee drag is one of the main things this project is measuring.
        // Prefer the exchange's own fee figures; fall back to configured rates only if absent.
        const exchangeFees = num(rec.cumEntryValue) > 0 || num(rec.cumExitValue) > 0
          ? num(rec.cumEntryValue) * (num(settings.makerFeePct) / 100)
            + num(rec.cumExitValue) * (num(settings.takerFeePct) / 100)
          : 0;
        t.netPnl = num(rec.closedPnl);
        t.fees = exchangeFees;
        t.grossPnl = t.netPnl + exchangeFees; // gross = net + costs, so the three reconcile
        t.closeReason = 'Closed on exchange';
        t.markPrice = null;
        t.unrealisedPnl = null;
        t.unrealisedRR = null;
        const risk = Math.abs(num(t.fillPrice) - num(t.sl)) * num(t.qty);
        t.realisedRR = risk > 0 ? t.netPnl / risk : null;
        if (t.privateOutcome?.purpose==='close') {
          const obligation=t.privateOutcome;delete t.privateOutcome;
          if (typeof persist!=='function'||persist()!==true) {t.privateOutcome=obligation;t.status='OPEN';}
        }
        changed++;
        logger.info('executor', `Live close reconciled for ${t.symbol}: net ${t.netPnl}`);
      }
      continue;
    }

    if (t.status === 'PENDING' && Date.now() > t.expiresAt) {
      try {await cancelLiveOrder({ trade: t, settings, persist });}
      catch (_) {changed++;continue;} // Failed/unknown cancellation cannot prove expiry.
      t.status = 'EXPIRED';
      t.closedAt = Date.now();
      t.closeReason = 'Entry window passed without a fill';
      t.netPnl = 0;
      t.grossPnl = 0;
      t.fees = 0;
      changed++;
    }
  }

  return { changed };
}

module.exports = {
  createPendingOrder,
  stepPaperTrade,
  closeTrade,
  floatingPnl,
  placeLiveOrder,
  cancelLiveOrder,
  closeLivePosition,
  syncLiveTrades,
  hasUnresolvedLiveOutcome,
};
