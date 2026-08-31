'use strict';

const store = require('./store');
const logger = require('./logger');
const { num, clamp } = require('./util');

/*
 * SETTINGS DESIGN NOTE — read before changing.
 *
 * The persisted file stores ONLY the keys the operator has explicitly overridden, not a full
 * snapshot. Effective settings = DEFAULTS merged with those overrides.
 *
 * This is deliberate. A full-snapshot design means a value saved once is frozen forever: ship a
 * new, better default and every existing install silently keeps the stale number, with no
 * indication anything is wrong. Storing only real overrides means new defaults propagate to
 * everyone automatically, and the UI can show exactly which keys are pinned by hand.
 */

const SCHEMA = [
  // ── Engine ────────────────────────────────────────────────────────────────────────────────
  { key: 'tradingEnabled', group: 'Engine', type: 'bool', default: false,
    label: 'Trading enabled', help: 'Off = scan and record signals only, place nothing.' },
  { key: 'mode', group: 'Engine', type: 'enum', options: ['paper', 'live'], default: 'paper',
    label: 'Mode', help: 'Live sends real orders to Bybit. Paper simulates fills locally.' },
  { key: 'testnet', group: 'Engine', type: 'bool', default: true,
    label: 'Use Bybit testnet', help: 'Applies to live mode. Turn off only when going to real funds.' },
  { key: 'scanIntervalSec', group: 'Engine', type: 'int', default: 60, min: 15, max: 900,
    label: 'Scan interval (sec)', help: 'How often the engine re-evaluates the universe.' },
    { key: 'dualEngines', group: 'Engine', type: 'bool', default: false,
    label: 'Run both engines (paper A/B)', help: 'STRUCTURE and TREND side by side. Same symbol allowed on both engines. Use maxPerEngine for A/B sample size.' },
  { key: 'maxPerEngine', group: 'Risk', type: 'int', default: 7, min: 1, max: 25,
    label: 'Max positions per engine (dual)', help: 'When dual engines is on: each engine may hold up to this many pending+open trades (default 7).' },
  { key: 'activeEngine', group: 'Engine', type: 'enum', default: 'STRUCTURE',
    options: ['STRUCTURE', 'TREND'],
    label: 'Active engine (if dual off)', help: 'STRUCTURE = BOS/CHoCH retest. TREND = EMA pullback.' },
{ key: 'timeframe', group: 'Engine', type: 'enum', options: ['5', '15', '60'], default: '15',
    label: 'Signal timeframe (min)', help: '15m is the shortest timeframe where round-trip cost is realistically clearable.' },
  { key: 'logLevel', group: 'Engine', type: 'enum', options: ['debug', 'info', 'warn', 'error'], default: 'info',
    label: 'Log level' },

  // ── Universe ──────────────────────────────────────────────────────────────────────────────
  { key: 'universeSize', group: 'Universe', type: 'int', default: 60, min: 5, max: 300,
    label: 'Max symbols scanned', help: 'Top N by 24h turnover after filters.' },
  { key: 'symbolWhitelist', group: 'Universe', type: 'csv', default: '',
    label: 'Only trade these symbols', help: 'Comma separated. Empty = no whitelist.' },
  { key: 'symbolBlacklist', group: 'Universe', type: 'csv', default: '',
    label: 'Never trade these symbols', help: 'Comma separated. Applied after whitelist.' },
  { key: 'universeRefreshMin', group: 'Universe', type: 'int', default: 30, min: 5, max: 240,
    label: 'Universe refresh (min)' },

  // ── Gates ─────────────────────────────────────────────────────────────────────────────────
  { key: 'gateScoreBandEnabled', group: 'Gates', type: 'bool', default: true,
    label: 'SCORE_BAND', help: 'VALIDATED. Best single gate in backtest — trades below the floor are weak, at/above the ceiling are exhaustion.' },
  // SCORE_BAND — 40 ≤ score < 80. These are the ORIGINAL validated numbers, restored 2026-08-30.
  //
  // They were briefly rescaled to 47/94 when the score was an additive point-sum, because on that
  // scale 40/80 meant nothing. The score is now multiplicative on BASE 50 again — the same
  // architecture and the same scale the band was validated against — so the original numbers are
  // the correct ones. See docs/EVIDENCE.md for the bucket evidence and the transfer caveat.
  //
  // The ceiling is not decoration. 80+ measured 0 wins from 7 trades: on a multiplicative score,
  // reaching 80 requires every factor near maximum at once, which is an extended, euphoric setup
  // rather than a confident one. The floor and ceiling do different jobs.
  //
  // The plateau was flat across floors 35-45 and ceilings 75-85, so these are not a knife-edge —
  // but they are also not re-validated on THIS signal source yet. Test by BUCKET, never by mean
  // or linear correlation: a U-shape reads as r≈0 under both.
  { key: 'scoreBandLo', group: 'Gates', type: 'int', default: 40, min: 0, max: 100, label: 'Score floor (inclusive)' },
  { key: 'scoreBandHi', group: 'Gates', type: 'int', default: 80, min: 0, max: 101, label: 'Score ceiling (exclusive)' },

  { key: 'gateTurnoverEnabled', group: 'Gates', type: 'bool', default: true,
    label: 'TURNOVER_GATE', help: 'VALIDATED. Thin books were the clearest driver of live win-rate decay.' },
  { key: 'minTurnover24h', group: 'Gates', type: 'float', default: 3000000, min: 0, max: 1e10,
    label: 'Min 24h turnover (USDT)' },

  /*
   * TURNOVER_CEILING — VALIDATED out-of-sample (2026-08-30). Fitted on the first 60% of the
   * TREND_PULLBACK ledger by time, then checked on the held-out 40%: TRAIN 46.2% WR / +11.01,
   * TEST 51.4% WR / +9.13, against a 40.9% baseline. It was the ONLY single-condition filter of
   * ~60 tested that survived the holdout — BUY-only, score>=70, turnover<3M and every
   * hour-of-day cut all collapsed or inverted.
   *
   * 3.5M and 4.0M both read >50% out-of-sample; 3.0M dipped to 41.7%. The real region is
   * roughly 3.5-5M. Do not fine-tune this against the data that produced it.
   */
  { key: 'gateTurnoverCeilingEnabled', group: 'Gates', type: 'bool', default: true,
    label: 'TURNOVER_CEILING', help: 'VALIDATED out-of-sample. Crowded, high-turnover books were where the edge died.' },
  { key: 'maxTurnover24h', group: 'Gates', type: 'float', default: 4000000, min: 100000, max: 1e10,
    label: 'Max 24h turnover (USDT)' },

  /*
   * SYMBOL_EXPECTANCY — VALIDATED out-of-sample (2026-08-30), and independent of the ceiling
   * above (blocked names: median turnover 3.71M vs 3.66M for the rest). Symbols net-negative in
   * the first 60% went on to 31.9% WR / -3.84 in the held-out 40%; blocking them lifted the
   * remainder to 46.2% WR / +7.61. Permutation over 2,000 random blacklists of equal size beat
   * the real one 49 times (p = 0.0245). Stacked with the ceiling: 61.2% WR / +11.12 (n=67),
   * still 61.5% after trimming top-3 winners AND top-3 losers.
   *
   * Implemented as suspension-with-parole, never a permanent ban — see lib/symbolStats.js.
   */
  { key: 'gateSymbolExpectancyEnabled', group: 'Gates', type: 'bool', default: true,
    label: 'SYMBOL_EXPECTANCY', help: 'VALIDATED out-of-sample. Suspends symbols whose recent record is net-negative, with parole.' },
  { key: 'symbolStatsWindow', group: 'Gates', type: 'int', default: 6, min: 2, max: 50,
    label: 'Symbol record window', help: 'Judge a symbol on its last N closed trades only. Older results age out.' },
  { key: 'symbolStatsMinTrades', group: 'Gates', type: 'int', default: 3, min: 2, max: 20,
    label: 'Min trades before judging', help: 'Never suspend a symbol on fewer than this many results.' },
  { key: 'symbolBlockMin', group: 'Gates', type: 'int', default: 720, min: 10, max: 20160,
    label: 'Suspension length (min)', help: 'First suspension. Doubles on each repeat failure.' },
  { key: 'symbolMaxBlockMin', group: 'Gates', type: 'int', default: 4320, min: 60, max: 40320,
    label: 'Max suspension (min)', help: 'Backoff ceiling, so a symbol is always retried eventually.' },
  { key: 'symbolParoleTrades', group: 'Gates', type: 'int', default: 2, min: 1, max: 10,
    label: 'Parole trades', help: 'Trades a released symbol gets to prove itself, judged on fresh results only.' },

  { key: 'gateRREnabled', group: 'Gates', type: 'bool', default: true,
    label: 'RR floor', help: 'Reject plans whose planned reward:risk is below the floor.' },
  { key: 'minRR', group: 'Gates', type: 'float', default: 2.0, min: 0.5, max: 10, label: 'Min planned RR' },
  { key: 'maxRR', group: 'Gates', type: 'float', default: 6.0, min: 1, max: 50,
    label: 'Max planned RR', help: 'A very high RR usually means the target is unreachable, not that the trade is good.' },

  { key: 'gateCostFloorEnabled', group: 'Gates', type: 'bool', default: true,
    label: 'Cost floor', help: 'Reject trades whose net take-profit does not clear round-trip fees by the multiple below.' },
  { key: 'costFloorMultiple', group: 'Gates', type: 'float', default: 2.5, min: 1, max: 20,
    label: 'Net TP must exceed cost x' },

  { key: 'gateSlDistEnabled', group: 'Gates', type: 'bool', default: true,
    label: 'Stop distance bounds', help: 'Stops too tight get noise-hunted; too wide break the cost maths.' },
  // VALIDATED (Phase 3b). Stop distance is the most robust cross-engine predictor found so far:
  // Spearman rho +0.28 to +0.39, replicated independently on both STRUCTURE and TREND. Tight
  // stops get noise-hunted and round-trip fees eat most of the gross edge at sub-1% distances.
  // 3.0% is the validated floor. The previous default of 0.80 meant a fresh deploy or a settings
  // reset silently discarded the one fix that had actually been proven.
  { key: 'minSlDistPct', group: 'Gates', type: 'float', default: 3.00, min: 0.05, max: 10, label: 'Min stop distance (%)' },
  // NOT validated — the ceiling has never been tested. It exists only to keep the cost maths
  // sane and to stay above the floor. Treat as a placeholder, not a finding.
  { key: 'maxSlDistPct', group: 'Gates', type: 'float', default: 5.00, min: 0.1, max: 25, label: 'Max stop distance (%)' },

  { key: 'gateBtcRegimeEnabled', group: 'Gates', type: 'bool', default: true,
    label: 'BTC regime alignment', help: 'Only take longs in bullish BTC regimes and shorts in bearish ones.' },

  { key: 'gateVolumeEnabled', group: 'Gates', type: 'bool', default: false,
    label: 'VOLUME_GATE', help: 'OFF by default. Failed four independent tests (backtest, paper ledger, live ledger, fresh replay) — it cuts volume hard without improving results. Left available only to re-test.' },
  { key: 'minVolRatio', group: 'Gates', type: 'float', default: 1.25, min: 0.1, max: 10, label: 'Min volume ratio' },

  { key: 'gateFundingEnabled', group: 'Gates', type: 'bool', default: false,
    label: 'FUNDING_GATE', help: 'OFF by default. Strongest gate on the real execution ledger but a no-op in fresh backtest — unresolved contradiction, so it is opt-in.' },
  { key: 'fundingBuyMax', group: 'Gates', type: 'float', default: 0.00005, min: -1, max: 1,
    label: 'Block longs above funding' },
  { key: 'fundingSellMin', group: 'Gates', type: 'float', default: -0.00002, min: -1, max: 1,
    label: 'Block shorts below funding' },

  { key: 'gateSpreadEnabled', group: 'Gates', type: 'bool', default: true,
    label: 'Spread ceiling', help: 'A wide book quietly eats the edge before the trade starts.' },
  { key: 'maxSpreadPct', group: 'Gates', type: 'float', default: 0.06, min: 0.001, max: 5, label: 'Max spread (%)' },

  // ── Structure quality ───────────────────────────────────────────────────────
  { key: 'minLevelTouches', group: 'Gates', type: 'int', default: 2, min: 1, max: 10,
    label: 'Min level touches', help: 'Require the structural support/resistance to have been touched at least this many times. 1 = weak, 2 = minimum recommended, 3+ = strong.' },
  { key: 'requireStrongBreak', group: 'Gates', type: 'bool', default: true,
    label: 'Require strong break', help: 'Only accept BOS/CHoCH that showed real displacement (strong body + range). Causal — uses only past candles.' },
  { key: 'rejectFailedBreak', group: 'Gates', type: 'bool', default: true,
    label: 'Reject failed breaks', help: 'Reject if price has already closed back through the broken level by the time the signal is born. Causal — no future data.' },
  // NOTE: 'entryMode' used to live here as a single-option dropdown. It was never read by
  // engine.js, signals.js, or either builder — pure dead code left over from before the
  // dual-engine split, and it misled the operator into thinking it selected the engine.
  // The real controls are 'activeEngine' and 'dualEngines', both in the Engine group above.

  // ── Entry ─────────────────────────────────────────────────────────────────────────────────
    { key: 'minTrendStrength', group: 'Gates', type: 'float', default: 12, min: 0, max: 100,
    label: 'Min trend strength', help: 'Reject flat EMA regimes. Higher = fewer but cleaner trends.' },
  { key: 'minAtrPct', group: 'Gates', type: 'float', default: 0.25, min: 0.05, max: 5,
    label: 'Min ATR (%)', help: 'Skip dead markets where stop is pure noise.' },
  { key: 'trendTargetR', group: 'Entry', type: 'float', default: 2.0, min: 1.0, max: 5,
    label: 'Trend target R', help: 'Take-profit as multiple of stop distance.' },
    { key: 'structureTargetR', group: 'Entry', type: 'float', default: 2.0, min: 1.0, max: 5,
    label: 'Structure target R', help: 'Fallback TP as multiple of stop when opposing level is missing or extreme.' },
  { key: 'bosOnly', group: 'Gates', type: 'bool', default: false,
    label: 'BOS only (skip CHoCH)', help: 'If on, only continuation breaks — no change-of-character reversals.' },
  { key: 'pivotWidth', group: 'Engine', type: 'int', default: 2, min: 1, max: 5,
    label: 'Pivot width', help: 'Bars each side to confirm a swing. 2 = standard non-repainting fractal.' },
{ key: 'entryWindowMin', group: 'Entry', type: 'int', default: 45, min: 5, max: 480,
    label: 'Entry window (min)', help: 'Cancel the resting order if price never returns to the level in this time.' },
  { key: 'chaseMissedMove', group: 'Entry', type: 'bool', default: false,
    label: 'Chase a missed move', help: 'OFF by default and it should stay off. When the chase path dominated, realised RR collapsed from 2.46 to 0.73 at fill.' },
  { key: 'maxHoldMin', group: 'Entry', type: 'int', default: 480, min: 15, max: 4320,
    label: 'Max hold (min)', help: 'Force-close a position that has gone nowhere.' },
  { key: 'entryBufferBps', group: 'Entry', type: 'float', default: 1.0, min: 0, max: 50,
    label: 'Fill buffer (bps)', help: 'Price must clear the level by this much before a paper fill counts.' },
  { key: 'tpThroughBps', group: 'Entry', type: 'float', default: 1.0, min: 0, max: 50,
    label: 'TP trade-through (bps)', help: 'A take-profit must genuinely trade through, not just wick to the level.' },
  { key: 'slSlipBps', group: 'Entry', type: 'float', default: 3.0, min: 0, max: 100,
    label: 'Assumed stop slippage (bps)' },

  // ── Risk ──────────────────────────────────────────────────────────────────────────────────
  { key: 'riskUsdtPerTrade', group: 'Risk', type: 'float', default: 0.25, min: 0.01, max: 10000,
    label: 'Risk per trade (USDT)', help: 'Loss taken if the stop is hit. Position size is derived from this and the stop distance.' },
  { key: 'leverage', group: 'Risk', type: 'int', default: 5, min: 1, max: 50, label: 'Leverage' },
  { key: 'maxOpenPositions', group: 'Risk', type: 'int', default: 14, min: 1, max: 50, label: 'Max open positions (total)' },
  { key: 'maxPerDirection', group: 'Risk', type: 'int', default: 4, min: 1, max: 50,
    label: 'Max positions per direction', help: 'Crude correlation control — everything moves together in a crypto selloff.' },
  { key: 'maxNotionalUsdt', group: 'Risk', type: 'float', default: 500, min: 1, max: 1e7,
    label: 'Max notional per trade (USDT)' },
  { key: 'takerFeePct', group: 'Risk', type: 'float', default: 0.055, min: 0, max: 1, label: 'Taker fee (%)' },
  { key: 'makerFeePct', group: 'Risk', type: 'float', default: 0.02, min: 0, max: 1, label: 'Maker fee (%)' },

  // ── Circuit breakers ──────────────────────────────────────────────────────────────────────
  { key: 'cbEnabled', group: 'Circuit breakers', type: 'bool', default: true, label: 'Circuit breakers enabled' },
  { key: 'cbMaxConsecLosses', group: 'Circuit breakers', type: 'int', default: 5, min: 1, max: 100,
    label: 'Halt after consecutive losses' },
  { key: 'cbDailyLossUsdt', group: 'Circuit breakers', type: 'float', default: 5.0, min: 0.1, max: 1e6,
    label: 'Halt after daily loss (USDT)' },
  { key: 'cbCooldownMin', group: 'Circuit breakers', type: 'int', default: 120, min: 1, max: 1440,
    label: 'Cooldown after halt (min)' },
  { key: 'cbSymbolLossLockoutMin', group: 'Circuit breakers', type: 'int', default: 180, min: 0, max: 1440,
    label: 'Lock out a symbol after a loss (min)' },
];

const DEFAULTS = Object.fromEntries(SCHEMA.map((s) => [s.key, s.default]));
const BY_KEY = Object.fromEntries(SCHEMA.map((s) => [s.key, s]));

let overrides = store.read('settings', {});
if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) overrides = {};

function coerce(spec, raw) {
  switch (spec.type) {
    case 'bool':
      return raw === true || raw === 'true' || raw === 1 || raw === '1';
    case 'int':
      return Math.round(clamp(num(raw, spec.default), spec.min ?? -1e12, spec.max ?? 1e12));
    case 'string':
      return raw == null ? spec.default : String(raw);
    case 'float':
      return clamp(num(raw, spec.default), spec.min ?? -1e12, spec.max ?? 1e12);
    case 'enum':
      return spec.options.includes(String(raw)) ? String(raw) : spec.default;
    case 'csv':
      if (Array.isArray(raw)) return raw.map((s) => String(s).trim().toUpperCase()).filter(Boolean).join(',');
      return String(raw || '')
        .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).join(',');
    default:
      return raw;
  }
}

/** Cross-field rules that a per-field clamp cannot express. Returns a list of human-readable fixes. */
function reconcile(s) {
  const fixes = [];
  if (s.scoreBandHi <= s.scoreBandLo) {
    s.scoreBandHi = Math.min(101, s.scoreBandLo + 1);
    fixes.push(`Score ceiling must sit above the floor — raised it to ${s.scoreBandHi}.`);
  }
  if (s.maxSlDistPct <= s.minSlDistPct) {
    s.maxSlDistPct = Number((s.minSlDistPct + 0.1).toFixed(3));
    fixes.push(`Max stop distance must exceed the minimum — raised it to ${s.maxSlDistPct}%.`);
  }
  if (s.maxRR <= s.minRR) {
    s.maxRR = Number((s.minRR + 0.5).toFixed(2));
    fixes.push(`Max RR must exceed min RR — raised it to ${s.maxRR}.`);
  }
  // Dual engines is a paper-only A/B tool and must never run against real orders.
  //
  // Dual mode deliberately allows the same symbol on both engines, but Bybit one-way mode holds
  // exactly one net position per symbol. executor.syncLiveTrades() maps exchange positions by
  // symbol alone, so two local trades on one symbol both match the same exchange position: fills,
  // exits and P&L get attributed to whichever local record is found first. The books silently
  // diverge from the exchange, which is the one failure mode that costs real money quietly.
  /*
   * The turnover floor and ceiling must leave a usable window. The floor default (3M) predates
   * the ceiling and, paired with a 4M ceiling, would admit only a 3-4M sliver and starve the
   * engine. The validated finding is a CEILING near 4M; the floor exists only to skip books too
   * thin to fill. Widen the window rather than silently trading almost nothing.
   */
  if (s.gateTurnoverCeilingEnabled && s.maxTurnover24h <= s.minTurnover24h * 1.5) {
    const wanted = Math.min(s.minTurnover24h, 1000000);
    if (wanted < s.minTurnover24h) {
      s.minTurnover24h = wanted;
      fixes.push(`Turnover floor was too close to the ${Math.round(s.maxTurnover24h).toLocaleString()} ceiling — lowered the floor to ${wanted.toLocaleString()} so the window is usable.`);
    }
  }

  if (s.dualEngines && s.mode === 'live') {
    s.dualEngines = false;
    fixes.push('Dual engines cannot run in live mode — position reconciliation is per-symbol and would mis-attribute fills. Switched dual engines off.');
  }
  if (s.maxPerDirection > s.maxOpenPositions) {
    s.maxPerDirection = s.maxOpenPositions;
    fixes.push(`Positions per direction cannot exceed total open positions — set it to ${s.maxPerDirection}.`);
  }
  return fixes;
}

/** Effective settings plus the list of cross-field corrections that had to be applied. */
function effectiveWithFixes() {
  const s = { ...DEFAULTS };
  for (const [k, v] of Object.entries(overrides)) {
    if (BY_KEY[k]) s[k] = v;
  }
  const fixes = reconcile(s);
  return { settings: s, fixes };
}

function effective() {
  return effectiveWithFixes().settings;
}

function update(patch) {
  const applied = {};
  const rejected = [];
  for (const [k, v] of Object.entries(patch || {})) {
    const spec = BY_KEY[k];
    if (!spec) { rejected.push(k); continue; }
    const coerced = coerce(spec, v);
    if (JSON.stringify(coerced) === JSON.stringify(DEFAULTS[k])) {
      delete overrides[k]; // back to default — stop pinning it
    } else {
      overrides[k] = coerced;
    }
    applied[k] = coerced;
  }
  // reconcile() runs inside effectiveWithFixes(), so the notes must be captured from that call.
  // Calling reconcile() again afterwards would always return an empty list — the conflict is
  // already resolved by then — and the operator would silently never learn what was changed.
  const { settings: s, fixes } = effectiveWithFixes();
  // Persist any reconciliation that changed a key the operator actually pinned.
  for (const k of Object.keys(overrides)) {
    if (s[k] !== overrides[k]) overrides[k] = s[k];
  }
  store.write('settings', overrides);
  logger.info('settings', `Updated ${Object.keys(applied).length} setting(s)`, { applied, fixes });
  if (rejected.length) logger.warn('settings', 'Ignored unknown settings', { rejected });
  logger.setLevel(s.logLevel);
  return { settings: s, applied, rejected, fixes, overridden: Object.keys(overrides) };
}

function resetAll() {
  overrides = {};
  store.write('settings', overrides);
  logger.warn('settings', 'All settings reset to defaults');
  return effective();
}

function resetKey(key) {
  if (BY_KEY[key]) {
    delete overrides[key];
    store.write('settings', overrides);
    logger.info('settings', `Reset ${key} to default`);
  }
  return effective();
}

logger.setLevel(effective().logLevel);

module.exports = {
  SCHEMA,
  DEFAULTS,
  effective,
  update,
  resetAll,
  resetKey,
  overriddenKeys: () => Object.keys(overrides),
};
