'use strict';

const settingsMod = require('../lib/settings');
const engine = require('../lib/engine');
const logger = require('../lib/logger');
const bybit = require('../lib/bybit');
const marketData = require('../lib/marketData');
const journal = require('../lib/journal');
const researchCapture = require('../lib/researchCapture');
const executor = require('../lib/executor');
const { GATE_ORDER } = require('../lib/gates');
const { num } = require('../lib/util');
const runtime = require('../lib/runtimeIdentity');
const researchManifest = require('../lib/researchManifest');
const groqShadowExport = require('../lib/groqShadowExport');
const groqShadowProducer = require('../lib/groqShadowProducer');
const alibabaShadowExport = require('../lib/alibabaShadowExport');
const alibabaShadowProducer = require('../lib/alibabaShadowProducer');
const v3Shadow = require('../lib/v3Shadow');
const fs = require('fs');
const crypto = require('crypto');

function requireGroqExportAuth(req, env = process.env) {
  const expected=env.GROQ_SHADOW_EXPORT_TOKEN || '';
  if(!expected)return false;
  const bearer=String(req?.headers?.authorization || '').replace(/^Bearer\s+/i,'');
  const supplied=String(req?.headers?.['x-groq-shadow-export-token'] || bearer || '');
  const left=Buffer.from(supplied),right=Buffer.from(expected);
  if(left.length!==right.length || !crypto.timingSafeEqual(left,right)) {
    const error=new Error('Groq shadow export authorization is required.');
    error.statusCode=401;error.code='GROQ_SHADOW_EXPORT_UNAUTHORIZED';throw error;
  }
  return true;
}

function requireAlibabaExportAuth(req,env=process.env){
  const expected=env.ALIBABA_SHADOW_EXPORT_TOKEN||'';
  if(!expected)return false;
  const bearer=String(req?.headers?.authorization||'').replace(/^Bearer\s+/i,'');
  const supplied=String(req?.headers?.['x-alibaba-shadow-export-token']||bearer||'');
  const left=Buffer.from(supplied),right=Buffer.from(expected);
  if(left.length!==right.length||!crypto.timingSafeEqual(left,right)){
    const error=new Error('Alibaba shadow export authorization is required.');
    error.statusCode=401;error.code='ALIBABA_SHADOW_EXPORT_UNAUTHORIZED';throw error;
  }
  return true;
}

function researchExportPlan(files=[]) {
  const watermarkAt=Date.now();
  const plan=files.map(file=>({path:file,size:fs.existsSync(file)?fs.statSync(file).size:0}));
  const identity=runtime.exportIdentity(watermarkAt,plan.map(file=>[file.path,file.size]));
  return {files:plan,headers:{'X-Orayan-Research-Snapshot-Id':identity.snapshotId,
    'X-Orayan-Research-Watermark-At':String(identity.watermarkAt),
    'X-Orayan-Process-Boot-Id':identity.processBootId}};
}
function researchExportHeaders(){return researchExportPlan().headers;}

/**
 * Attach mark-to-market floating P&L on OPEN trades so the UI is not blind until close.
 * Uses a short ticker TTL so the number moves with the market on each poll.
 * Live trades may already carry exchange unrealisedPnl from syncLiveTrades; we only fill gaps.
 */
async function withFloatingPnl(trades) {
  const list = Array.isArray(trades) ? trades : [];
  const open = list.filter((t) => t.status === 'OPEN' && num(t.fillPrice) > 0 && num(t.qty) > 0);
  if (!open.length) return list;

  const settings = settingsMod.effective();
  let bySymbol = new Map();
  try {
    const tickers = await marketData.getTickers({ testnet: settings.testnet, ttlMs: 5000 });
    bySymbol = new Map(tickers.map((t) => [t.symbol, t]));
  } catch (e) {
    logger.warn('api', 'Could not refresh tickers for floating P&L', { error: e.message });
  }

  return list.map((t) => {
    if (t.status !== 'OPEN') return t;
    // Prefer a fresh ticker mark; fall back to whatever sync already stamped.
    const tick = bySymbol.get(t.symbol);
    const mark = num(tick?.markPrice) || num(tick?.lastPrice) || num(t.markPrice);
    if (!(mark > 0)) return t;
    const fp = executor.floatingPnl(t, mark, settings);
    if (!fp) return t;
    return {
      ...t,
      markPrice: fp.markPrice,
      unrealisedPnl: fp.unrealisedPnl,
      unrealisedRR: fp.unrealisedRR,
    };
  });
}

/** Route table: 'METHOD /path' -> async (ctx) => body */
const routes = {
  'GET /api/health': async () => ({
    ok: true,
    now: Date.now(),
    apiKeySet: bybit.keySet(),
    clockOffsetMs: bybit.getClockOffset(),
    running: engine.state.running,
    processBootId: runtime.processBootId,
    processStartedAt: runtime.processStartedAt,
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

  'GET /api/trades': async ({ query }) => {
    const trades = await withFloatingPnl(
      engine.getTrades({ status: query.status || null, limit: num(query.limit, 200) }),
    );
    const openFloat = trades
      .filter((t) => t.status === 'OPEN' && Number.isFinite(Number(t.unrealisedPnl)))
      .reduce((a, t) => a + Number(t.unrealisedPnl), 0);
    return {
      trades,
      summary: engine.summary(),
      openUnrealisedPnl: openFloat,
    };
  },


  'GET /api/shadow/trades': async ({ query }) => {
    const trades = await withFloatingPnl(
      engine.getShadowTrades({ status: query.status || null, limit: num(query.limit, 200) }),
    );
    const openFloat = trades
      .filter((t) => t.status === 'OPEN' && Number.isFinite(Number(t.unrealisedPnl)))
      .reduce((a, t) => a + Number(t.unrealisedPnl), 0);
    return {
      trades,
      summary: engine.shadowSummary(),
      openUnrealisedPnl: openFloat,
    };
  },

  'GET /api/logs': async ({ query }) => ({
    logs: logger.tail(num(query.after, 0), num(query.limit, 300)),
  }),

  'GET /api/journal/signals': async ({ query }) => ({
    signals: journal.getSignalHistory({ limit: num(query.limit, 5000) }),
  }),

  'GET /api/journal/trades/export': async ({ query }) => {
    const format = query.format === 'csv' ? 'csv' : 'json';
    const trades = engine.getTrades({ status: query.status || null, limit: num(query.limit, 100000) });
    const { body, contentType } = journal.exportTrades(trades, format);
    return { __file: true, body, contentType, filename: `orayan2_trades_${Date.now()}.${format}` };
  },


  'GET /api/journal/shadow/export': async ({ query }) => {
    const format = query.format === 'csv' ? 'csv' : 'json';
    const trades = engine.getShadowTrades({ status: query.status || null, limit: num(query.limit, 100000) });
    const { body, contentType } = journal.exportTrades(trades, format);
    return { __file: true, body, contentType, filename: `orayan2_marci_shadow_${Date.now()}.${format}` };
  },

  'GET /api/journal/signals/export': async ({ query }) => {
    const format = query.format === 'csv' ? 'csv' : 'json';
    const legacy = query.schema === 'legacy';
    if(!legacy){
      const {stream,contentType}=journal.exportSignalsStream(format,num(query.limit,50000));
      return {__stream:true,stream,contentType,
        filename:`orayan2_signal_events_compact_v2_${Date.now()}.${format}`};
    }
    const signals = journal.getSignalHistory({ limit: num(query.limit, 50000), legacy });
    const { body, contentType } = journal.exportSignals(signals, format, { legacy });
    return { __file: true, body, contentType, filename: `orayan2_${legacy ? 'signals_legacy' : 'signal_events_compact_v2'}_${Date.now()}.${format}` };
  },

  'GET /api/journal/research/prospective/export': async ({ query }) => {
    if(query.compressed==='1'||query.sinceAt!==undefined)return require('../lib/prospectiveCompactMaintenance').current()
      .download({sinceAt:Number(query.sinceAt||0),gzip:query.compressed==='1'});
    const date = query.date || 'all';
    const raw = query.raw === '1';
    const files = researchCapture.exportFiles(date,raw);
    const plan=researchExportPlan(files);
    return { __files:true, ...plan, contentType:'application/x-ndjson; charset=utf-8',
      filename:`orayan2_${raw ? 'legacy_research_diagnostics' : 'prospective_compact_v4'}_${date}.jsonl` };
  },

  'GET /api/journal/research/prospective/status':async()=>require('../lib/prospectiveCompactMaintenance').current().status(),
  'POST /api/journal/research/prospective/reset':async({body})=>require('../lib/prospectiveCompactMaintenance').current().reset(body),

  'GET /api/journal/research/supplement/export': async ({ query }) => {
    const supplement=require('../lib/researchSupplement');
    supplement.prune();
    const files = supplement.files(query.date || 'all');
    const plan=researchExportPlan(files);
    return { __files:true, ...plan, contentType:'application/x-ndjson; charset=utf-8',
      filename:`orayan2_structure_stop_research_v1_${query.date || 'all'}.jsonl` };
  },

  'GET /api/journal/research/early-entry/export': async ({ query }) => {
    const early=require('../lib/earlyEntryShadow');
    early.prune();
    const date=query.date||'all';
    const files=early.files(date);
    const plan=researchExportPlan(files);
    return {__files:true,...plan,contentType:'application/x-ndjson; charset=utf-8',
      filename:`orayan2_early_entry_shadow_v1_${date}.jsonl`};
  },


  'GET /api/journal/research/environment/export': async ({ query }) => {
    const format = query.format === 'json' ? 'json' : 'csv';
    const { stream, contentType } = journal.streamResearchEnvironment(format);
    return { __stream:true, stream, contentType,headers:researchExportHeaders(),
      filename:`orayan2_environment_${Date.now()}.${format}` };
  },

  'GET /api/journal/research/events/export': async ({ query }) => {
    const format = query.format === 'json' ? 'json' : 'csv';
    const { stream, contentType } = journal.streamResearchEvents(format);
    return { __stream:true, stream, contentType,headers:researchExportHeaders(),
      filename:`orayan2_research_events_${Date.now()}.${format}` };
  },

  'GET /api/journal/research/manifest': async () => researchManifest.buildManifest(),

  'GET /api/v3/status': async () => v3Shadow.status(),
  'GET /api/v3/summary': async () => ({__file:true,contentType:'application/json',
    filename:'orayan_v3_summary.json',body:JSON.stringify(v3Shadow.summary(),null,2)}),
  'GET /api/v3/export': async ({query}) => v3Shadow.download(query.channel||'v3'),

  'GET /api/journal/research/groq-shadow': async () => {
    const shadowStatus=await groqShadowProducer.status();
    return {...groqShadowExport.metadata(),...shadowStatus,
      exportProtected:!!process.env.GROQ_SHADOW_EXPORT_TOKEN};
  },

  'GET /api/journal/research/groq-shadow/export': async ({req}) => {
    requireGroqExportAuth(req);
    const result = groqShadowExport.download();
    return { __stream: true, ...result };
  },

  'GET /api/journal/research/alibaba-shadow': async () => {
    const shadowStatus=await alibabaShadowProducer.status();
    return {...alibabaShadowExport.metadata(),...shadowStatus,
      exportProtected:!!process.env.ALIBABA_SHADOW_EXPORT_TOKEN};
  },

  'GET /api/journal/research/alibaba-shadow/export': async ({req}) => {
    requireAlibabaExportAuth(req);
    const result=alibabaShadowExport.download();
    return {__stream:true,...result};
  },

  'GET /api/journal/research/alibaba-shadow/snapshots/export': async ({req}) => {
    requireAlibabaExportAuth(req);
    return {__stream:true,...alibabaShadowExport.download({kind:'snapshots'})};
  },

  'POST /api/journal/signals/clear': async () => { journal.clearSignalHistory(); engine.clearLastSignals(); return { ok: true }; },

  'POST /api/control/start': async () => engine.start(),
  'POST /api/control/stop': async () => engine.stop({ reason: 'OPERATOR_STOP', preserveDesired: false }),
  'POST /api/control/scan': async () => { await engine.scanOnce(); return { ok: true }; },
  'POST /api/control/panic': async () => engine.panicClose(),
  'POST /api/control/release-kill': async () => engine.releaseKillSwitch(),
  'POST /api/control/clear-halt': async () => engine.clearHalt(),
  'POST /api/control/reset-trades': async () => engine.resetTrades(),
  'POST /api/journal/trades/clear': async () => engine.resetTrades(),
  'POST /api/journal/shadow/clear': async () => engine.resetShadowTrades(),
  'POST /api/research/reset-all': async () => {
    journal.clearSignalHistory();
    journal.clearResearch();
    engine.clearLastSignals();
    engine.resetTrades();
    engine.resetShadowTrades();
    return { ok: true };
  },
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

module.exports = { routes, _test:{requireGroqExportAuth,requireAlibabaExportAuth} };
