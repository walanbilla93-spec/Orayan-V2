'use strict';

const bybit = require('./bybit');
const logger = require('./logger');
const { num } = require('./util');

const klineCache = new Map();   // `${symbol}:${interval}` -> { at, expiresAt, candles }
const MAX_KLINE_CACHE_ENTRIES = 180; // 100-symbol universe + BTC + room for managed 1m trades
const instrumentCache = { at: 0, map: new Map() };
let tickerCache = { at: 0, list: [] };

/**
 * Fetch closed candles, oldest first.
 *
 * Bybit returns newest-first and INCLUDES the currently-forming candle. That forming candle is
 * the single most common source of look-ahead-flavoured bugs: its high/low/close keep changing,
 * so any indicator built on it silently repaints. It is dropped here, once, so nothing
 * downstream has to remember to.
 */
async function getCandles(symbol, interval, limit, { testnet, ttlMs } = {}) {
  const key = `${symbol}:${interval}`;
  const now = Date.now();
  const intervalMs = Math.max(60000, num(interval) * 60000);
  const hit = klineCache.get(key);

  // Closed candles cannot change until the next timeframe boundary. For ordinary strategy
  // scans, cache exactly to that boundary instead of refetching the same 200 candles every
  // 20 seconds. Callers that genuinely need fresher data (trade management) pass ttlMs.
  const explicitTtl = ttlMs !== undefined && ttlMs !== null;
  const valid = hit && hit.candles.length >= limit && (
    explicitTtl ? (now - hit.at < Math.max(0, ttlMs)) : (now < hit.expiresAt)
  );
  if (valid) {
    // Touch entry so Map insertion order acts as a tiny LRU.
    klineCache.delete(key);
    klineCache.set(key, hit);
    return hit.candles.slice(-limit);
  }

  const res = await bybit.publicGet('/v5/market/kline', {
    category: 'linear',
    symbol,
    interval,
    limit: Math.min(1000, limit + 2),
  }, testnet);

  const rows = res?.list || [];
  const candles = rows
    .map((r) => ({
      ts: num(r[0]),
      open: num(r[1]),
      high: num(r[2]),
      low: num(r[3]),
      close: num(r[4]),
      volume: num(r[5]),
      turnover: num(r[6]),
    }))
    .sort((a, b) => a.ts - b.ts);

  const fetchedAt = Date.now();
  const closed = candles.filter((c) => c.ts + intervalMs <= fetchedAt);
  // Add a small grace after the next boundary so Bybit has time to finalise the just-closed bar.
  const nextBoundary = (Math.floor(fetchedAt / intervalMs) + 1) * intervalMs;
  const expiresAt = explicitTtl
    ? fetchedAt + Math.max(0, ttlMs)
    : nextBoundary + 2000;

  klineCache.delete(key);
  klineCache.set(key, { at: fetchedAt, expiresAt, candles: closed });
  while (klineCache.size > MAX_KLINE_CACHE_ENTRIES) {
    const oldestKey = klineCache.keys().next().value;
    klineCache.delete(oldestKey);
  }
  return closed.slice(-limit);
}

/** All linear USDT perpetual tickers, with 24h turnover and spread. */
async function getTickers({ testnet, ttlMs = 60000 } = {}) {
  if (Date.now() - tickerCache.at < ttlMs && tickerCache.list.length) return tickerCache.list;

  const res = await bybit.publicGet('/v5/market/tickers', { category: 'linear' }, testnet);
  const list = (res?.list || [])
    .filter((t) => String(t.symbol).endsWith('USDT'))
    .map((t) => {
      const bid = num(t.bid1Price);
      const ask = num(t.ask1Price);
      const mid = bid && ask ? (bid + ask) / 2 : num(t.lastPrice);
      return {
        symbol: t.symbol,
        lastPrice: num(t.lastPrice),
        markPrice: num(t.markPrice) || num(t.lastPrice),
        bid,
        ask,
        spreadPct: mid ? ((ask - bid) / mid) * 100 : null,
        turnover24h: num(t.turnover24h),
        volume24h: num(t.volume24h),
        fundingRate: num(t.fundingRate),
        change24hPct: num(t.price24hPcnt) * 100,
      };
    });

  tickerCache = { at: Date.now(), list };
  return list;
}

/** Lot size, tick size and minimum order quantity — required to size an order correctly. */
async function getInstruments({ testnet, ttlMs = 6 * 3600 * 1000 } = {}) {
  if (Date.now() - instrumentCache.at < ttlMs && instrumentCache.map.size) return instrumentCache.map;

  const map = new Map();
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    const res = await bybit.publicGet('/v5/market/instruments-info', {
      category: 'linear', limit: 1000, cursor,
    }, testnet);
    for (const it of res?.list || []) {
      if (it.quoteCoin !== 'USDT' || it.status !== 'Trading') continue;
      map.set(it.symbol, {
        symbol: it.symbol,
        tickSize: num(it.priceFilter?.tickSize),
        qtyStep: num(it.lotSizeFilter?.qtyStep),
        minOrderQty: num(it.lotSizeFilter?.minOrderQty),
        maxOrderQty: num(it.lotSizeFilter?.maxOrderQty),
        maxLeverage: num(it.leverageFilter?.maxLeverage, 10),
        launchTime: num(it.launchTime),
      });
    }
    cursor = res?.nextPageCursor || '';
    if (!cursor) break;
  }

  instrumentCache.at = Date.now();
  instrumentCache.map = map;
  logger.info('market', `Loaded ${map.size} tradable USDT perpetual instruments`);
  return map;
}

function clearCaches() {
  klineCache.clear();
  tickerCache = { at: 0, list: [] };
  instrumentCache.at = 0;
  instrumentCache.map = new Map();
}

function cacheStats() {
  let candleCount = 0;
  for (const v of klineCache.values()) candleCount += Array.isArray(v.candles) ? v.candles.length : 0;
  return { klineEntries: klineCache.size, cachedCandles: candleCount };
}

module.exports = { getCandles, getTickers, getInstruments, clearCaches, cacheStats };
