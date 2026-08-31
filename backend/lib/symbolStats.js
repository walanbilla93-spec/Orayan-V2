/*
 * symbolStats.js — rolling per-symbol expectancy, with a way back in.
 *
 * WHY THIS EXISTS
 * ---------------
 * Symbol identity persisted out-of-sample in the 2026-08 ledger. Symbols that were net-negative
 * over the first 60% of TREND_PULLBACK trades went on to score 31.9% WR / -3.84 over the
 * remaining 40%, while blocking them lifted the rest from 40.9% WR / +3.76 to 46.2% / +7.61.
 * A permutation test over 2,000 random blacklists of the same size beat the real one 49 times
 * (p = 0.0245).
 *
 * The effect is INDEPENDENT of the turnover ceiling: median turnover of the blocked names was
 * 3.71M vs 3.66M for the rest — statistically identical. Two separate effects, so both gates
 * are worth having. Stacked out-of-sample they gave 61.2% WR / +11.12 over n=67, and survived a
 * symmetric top-3-winner AND top-3-loser trim at 61.5%.
 *
 * THE TRAP THIS MODULE IS DESIGNED AROUND
 * ---------------------------------------
 * A naive blacklist is a one-way door. Block a symbol -> it takes no trades -> it generates no
 * new evidence -> it stays blocked forever, on evidence that gets staler every day. Markets
 * rotate; a name that bled in August may be the best thing on the book in October. So a block
 * here is always a SUSPENSION WITH PAROLE, never a life sentence:
 *
 *   1. ROLLING WINDOW. Judgement uses only the last `window` closed trades for the symbol. Old
 *      losses age out on their own as new results arrive. Nothing is remembered forever.
 *
 *   2. TIMED SUSPENSION. A block expires after `blockMin`. It is a cooldown, not a verdict.
 *
 *   3. PAROLE. When the suspension expires the symbol returns on probation and is allowed
 *      exactly `paroleTrades` attempts, regardless of its past record. This is what generates
 *      the fresh evidence a pure blacklist can never get. Parole trades are real trades with
 *      real risk — that is the price of finding out.
 *
 *   4. EXPONENTIAL BACKOFF, CAPPED. Fail parole and the next suspension doubles (12h -> 24h ->
 *      48h, capped at `maxBlockMin`). A persistently bad symbol is tried ever more rarely
 *      instead of being tried forever or banned forever. Pass parole and the backoff resets to
 *      base, so one bad streak does not permanently mark a symbol.
 *
 * Net effect: a symbol can always earn its way back, but the cost of re-testing a bad one falls
 * geometrically. That is the exploration/exploitation trade made explicit.
 *
 * State is persisted so a redeploy does not wipe it — the same mistake that lost the BOS data.
 */

const store = require('./store');
const logger = require('./logger');
const { num } = require('./util');

// symbol -> { results: [{ts, pnl}], blockedUntil, strikes, paroleLeft }
let stats = {};

try {
  const saved = store.read('symbolStats', {});
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) stats = saved;
} catch (e) {
  logger.warn('symbolStats', 'Could not restore symbol stats', { error: e.message });
}

let saveTimer = null;
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    store.write('symbolStats', stats);
  }, 2000);
  if (saveTimer.unref) saveTimer.unref();
}

function entry(symbol) {
  if (!stats[symbol]) {
    stats[symbol] = { results: [], blockedUntil: 0, strikes: 0, paroleLeft: 0 };
  }
  return stats[symbol];
}

/**
 * Record a closed trade. Called from the same place as recordLockout so every close is seen
 * exactly once.
 */
function recordClose(trade, settings) {
  if (!trade || !trade.symbol) return;
  const e = entry(trade.symbol);
  const pnl = num(trade.netPnl);
  e.results.push({ ts: num(trade.closedAt) || Date.now(), pnl });

  const window = Math.max(2, num(settings.symbolStatsWindow, 6));
  if (e.results.length > window) e.results.splice(0, e.results.length - window);

  // A trade taken while on parole consumes one parole slot.
  if (e.paroleLeft > 0) {
    e.paroleLeft -= 1;
    if (e.paroleLeft === 0) {
      // Parole is over — judge on the refreshed window below. Passing resets the backoff so a
      // symbol that recovers is treated as innocent again rather than carrying old strikes.
      const sum = e.results.reduce((a, r) => a + r.pnl, 0);
      if (sum >= 0) {
        e.strikes = 0;
        logger.info('symbolStats', `${trade.symbol} passed parole — backoff reset`);
      }
    }
  }

  evaluate(trade.symbol, settings);
  persist();
}

/** Re-judge one symbol and suspend it if its rolling window is net-negative. */
function evaluate(symbol, settings) {
  const e = entry(symbol);
  if (!settings.gateSymbolExpectancyEnabled) return;
  if (e.paroleLeft > 0) return;            // mid-parole: let it finish before judging
  if (Date.now() < e.blockedUntil) return; // already suspended

  const minTrades = Math.max(2, num(settings.symbolStatsMinTrades, 3));
  if (e.results.length < minTrades) return; // not enough evidence to condemn anything

  const sum = e.results.reduce((a, r) => a + r.pnl, 0);
  if (sum >= 0) return;

  const base = Math.max(1, num(settings.symbolBlockMin, 720));
  const cap = Math.max(base, num(settings.symbolMaxBlockMin, 4320));
  const mins = Math.min(cap, base * Math.pow(2, e.strikes));
  e.blockedUntil = Date.now() + mins * 60000;
  e.strikes += 1;
  logger.info('symbolStats',
    `${symbol} suspended ${Math.round(mins / 60)}h (strike ${e.strikes}) — last ${e.results.length} trades net ${sum.toFixed(4)}`);
}

/**
 * Gate check. Returns { blocked, reason }.
 * Releasing a suspension grants parole slots — this is the only place a symbol comes back.
 */
function check(symbol, settings) {
  const e = stats[symbol];
  if (!e) return { blocked: false };
  if (!settings.gateSymbolExpectancyEnabled) return { blocked: false };

  if (e.blockedUntil && Date.now() >= e.blockedUntil) {
    e.blockedUntil = 0;
    e.paroleLeft = Math.max(1, num(settings.symbolParoleTrades, 2));
    // Clear the window so parole is judged on fresh evidence rather than re-condemned instantly
    // by the same old losses that caused the suspension.
    e.results = [];
    logger.info('symbolStats', `${symbol} released on parole — ${e.paroleLeft} trade(s) to prove itself`);
    persist();
    return { blocked: false, parole: true };
  }

  if (e.blockedUntil && Date.now() < e.blockedUntil) {
    const mins = Math.ceil((e.blockedUntil - Date.now()) / 60000);
    return { blocked: true, reason: `suspended ${mins}m (strike ${e.strikes})` };
  }
  return { blocked: false, parole: e.paroleLeft > 0 };
}

function snapshot() {
  const out = [];
  for (const [sym, e] of Object.entries(stats)) {
    const sum = e.results.reduce((a, r) => a + r.pnl, 0);
    out.push({
      symbol: sym,
      trades: e.results.length,
      netPnl: Number(sum.toFixed(4)),
      strikes: e.strikes,
      paroleLeft: e.paroleLeft,
      blockedUntil: e.blockedUntil || null,
      blocked: !!(e.blockedUntil && Date.now() < e.blockedUntil),
    });
  }
  return out.sort((a, b) => a.netPnl - b.netPnl);
}

function reset() {
  stats = {};
  store.write('symbolStats', stats);
}

module.exports = { recordClose, check, snapshot, reset, evaluate };
