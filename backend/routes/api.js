'use strict';

const settingsMod = require('../lib/settings');
const engine = require('../lib/engine');
const logger = require('../lib/logger');
const bybit = require('../lib/bybit');
const marketData = require('../lib/marketData');
const { GATE_ORDER } = require('../lib/gates');
const { num } = require('../lib/util');

/** Route table: 'METHOD /path' -> async (ctx) => body */
const routes = {
  'GET /api/health': async () => ({
    ok: true,
    now: Date.now(),
    apiKeySet: bybit.keySet(),
    clockOffsetMs: bybit.getClockOffset(),
    running: engine.state.running,
  }),

  'GET /api/status': async () => engine.getState(),

  'GET /api/settings': async () => ({
    schema: settingsMod.SCHEMA,
    settings: settingsMod.effective(),
    defaults: settingsMod.DEFAULTS,
    overridden: settingsMod.overriddenKeys(),
  }),

  'POST /api/settings': async ({ body }) => {
    const result = settingsMod.update(body || {});
    return { ok: true, ...result };
  },

  'POST /api/settings/reset': async ({ body }) => {
    if (body && body.key) return { ok: true, settings: settingsMod.resetKey(body.key) };
    return { ok: true, settings: settingsMod.resetAll() };
  },

  'GET /api/signals': async () => ({
    gateOrder: GATE_ORDER,
    btcRegime: engine.state.btcRegime,
    funnel: engine.state.funnel,
    signals: engine.state.lastSignals,
    lastScanAt: engine.state.lastScanAt,
  }),

  'GET /api/trades': async ({ query }) => ({
    trades: engine.getTrades({ status: query.status || null, limit: num(query.limit, 200) }),
    summary: engine.summary(),
  }),

  'GET /api/logs': async ({ query }) => ({
    logs: logger.tail(num(query.after, 0), num(query.limit, 300)),
  }),

  'POST /api/control/start': async () => engine.start(),
  'POST /api/control/stop': async () => engine.stop(),
  'POST /api/control/scan': async () => { await engine.scanOnce(); return { ok: true }; },
  'POST /api/control/panic': async () => engine.panicClose(),
  'POST /api/control/release-kill': async () => engine.releaseKillSwitch(),
  'POST /api/control/clear-halt': async () => engine.clearHalt(),
  'POST /api/control/reset-trades': async () => engine.resetTrades(),
  'POST /api/control/clear-cache': async () => { marketData.clearCaches(); return { ok: true }; },

  'GET /api/account': async () => {
    const s = settingsMod.effective();
    if (!bybit.keySet()) return { ok: false, reason: 'Bybit API credentials are not set on the server.' };
    try {
      const res = await bybit.privateGet('/v5/account/wallet-balance', { accountType: 'UNIFIED' }, s.testnet);
      const acct = res?.list?.[0];
      const usdt = acct?.coin?.find((c) => c.coin === 'USDT');
      return {
        ok: true,
        testnet: s.testnet,
        totalEquity: num(acct?.totalEquity),
        availableBalance: num(usdt?.availableToWithdraw ?? usdt?.walletBalance),
        walletBalance: num(usdt?.walletBalance),
        unrealisedPnl: num(acct?.totalPerpUPL),
      };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  },
};

module.exports = { routes };
