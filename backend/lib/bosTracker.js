'use strict';

/**
 * BOS outcome tracker — forward validation for the fake-BOS filter.
 *
 * Why this exists: the trade log only ever contains breaks that were still holding at
 * signal time (signals_structure.js rejects already-failed breaks via hasAlreadyFailed
 * before a signal object is even built). So the trade log can never show you the FAKE
 * side of the distribution — you only ever see breaks that were traded, which is a
 * survivorship-filtered subset. To measure "breaks that hold 2+ candles vs breaks that
 * revert immediately" (the validated finding), every detected break has to be logged
 * the moment it's detected, independent of whether it becomes a signal or a trade —
 * then revisited a couple of candles later to see what actually happened.
 *
 * Definition matches the validated finding exactly: a break is FAKE if either of the
 * 2 closed candles after the break candle closes back through the broken level; HELD
 * if both of those candles close beyond it. Resolution can happen early (FAKE as soon
 * as it reverts) or take exactly 2 candles (HELD).
 *
 * This module holds no persistent state of its own — no separate store file. It's
 * pure in-memory detection/resolution logic. trackBreak/resolvePendingForSymbol return
 * the event whenever something changed (created or resolved); the caller is
 * responsible for recording that into the existing journal (see journal.recordBosEvent),
 * so BOS outcomes end up in the same signals journal export instead of a new file.
 *
 * PERSISTENCE — in-flight PENDING events are now written to disk.
 *
 * They used to live in memory only, on the reasoning that resolution takes just a couple of
 * candles. That reasoning was wrong in practice: the operator was redeploying to clear a stuck
 * kill switch, and every redeploy wiped every PENDING break before it could resolve. Those
 * breaks never reached the journal at all, so the exact dataset the fake-BOS finding depends on
 * was the dataset most exposed to being lost. Only unresolved events are kept — resolved ones
 * have already gone to the journal and are dropped on save.
 */

const store = require('./store');
const logger = require('./logger');
const { num } = require('./util');

const events = new Map(); // key -> event

// Restore unresolved breaks from the previous process.
try {
  const saved = store.read('bosPending', []);
  if (Array.isArray(saved)) {
    for (const ev of saved) {
      if (ev && ev.key && ev.outcome === 'PENDING') events.set(ev.key, ev);
    }
    if (events.size) logger.info('bosTracker', `Restored ${events.size} unresolved break(s) from disk`);
  }
} catch (e) {
  logger.warn('bosTracker', 'Could not restore pending breaks', { error: e.message });
}

let saveTimer = null;
/** Debounced — resolution churns during a scan and this file is small but written often. */
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const pending = [...events.values()].filter((e) => e.outcome === 'PENDING');
    store.write('bosPending', pending);

    // Resolved events stay in memory deliberately. trackBreak() treats "key not in map" as a new
    // detection, so dropping a resolved event would let the same break be re-detected and
    // re-journalled, double-counting it in the very statistic this module exists to measure.
    // They are only pruned once they are far older than any live break could be.
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [k, v] of events) {
      if (v.outcome !== 'PENDING' && num(v.resolvedAt) && v.resolvedAt < cutoff) events.delete(k);
    }
  }, 2000);
  if (saveTimer.unref) saveTimer.unref();
}

function makeKey(symbol, side, breakTs) {
  return `${symbol}:${side}:${breakTs}`;
}

function resolveOne(ev, closedCandles) {
  if (ev.outcome !== 'PENDING') return false;

  const idx = closedCandles.findIndex((c) => num(c.ts) === ev.breakTs);
  if (idx === -1) {
    // Break candle has scrolled out of the fetched window before resolving — rare with
    // a 200-bar lookback, but don't leave it dangling in memory forever.
    const age = Date.now() - ev.breakTs;
    if (age > 6 * 60 * 60 * 1000) {
      ev.outcome = 'UNRESOLVED_STALE';
      ev.resolvedAt = Date.now();
      return true;
    }
    return false;
  }

  const after = closedCandles.slice(idx + 1);
  for (let i = 0; i < after.length && i < 2; i++) {
    const c = after[i];
    const reverted = ev.side === 'BUY' ? num(c.close) < ev.level : num(c.close) > ev.level;
    ev.barsChecked = i + 1;
    if (reverted) {
      ev.outcome = 'FAKE';
      ev.resolvedAt = Date.now();
      return true;
    }
  }
  if (after.length >= 2) {
    ev.outcome = 'HELD';
    ev.barsChecked = 2;
    ev.resolvedAt = Date.now();
    return true;
  }
  return false;
}

/**
 * Call once per symbol per scan, right after struct.eventIndex/brokenLevel are known
 * in buildSignalStructure — before any WEAK_BREAK/FAILED_BREAK rejection. Returns the
 * event to record if this break is new or its outcome just resolved; null otherwise
 * (already-tracked break with no change this call — nothing new to journal).
 */
function trackBreak({ symbol, side, eventIndex, brokenLevel, closedCandles, timeframe }) {
  if (eventIndex == null || brokenLevel == null || !closedCandles || !closedCandles.length) return null;
  const breakCandle = closedCandles[eventIndex];
  if (!breakCandle) return null;
  const breakTs = num(breakCandle.ts);
  if (!breakTs) return null;

  const key = makeKey(symbol, side, breakTs);
  let ev = events.get(key);
  if (ev) {
    const resolved = resolveOne(ev, closedCandles);
    if (resolved) persist();
    return resolved ? { ...ev } : null;
  }

  ev = {
    key,
    symbol,
    side,
    level: brokenLevel,
    breakTs,
    breakIso: new Date(breakTs).toISOString(),
    timeframe,
    outcome: 'PENDING',
    barsChecked: 0,
    resolvedAt: null,
  };
  events.set(key, ev);
  resolveOne(ev, closedCandles); // may resolve immediately if candles already exist past the break
  persist();
  return { ...ev }; // always report the new detection, even if still PENDING
}

/**
 * Call for a symbol even when buildSignalStructure short-circuits before reaching
 * trackBreak (e.g. NO_STRUCTURE_EVENT) — still worth sweeping this symbol's pending
 * events against fresh candles so resolution isn't gated on a break happening again.
 * Returns an array of events that resolved this call (possibly empty).
 */
function resolvePendingForSymbol(symbol, closedCandles) {
  const resolved = [];
  if (!closedCandles || !closedCandles.length) return resolved;
  for (const ev of events.values()) {
    if (ev.symbol !== symbol || ev.outcome !== 'PENDING') continue;
    if (resolveOne(ev, closedCandles)) resolved.push({ ...ev });
  }
  if (resolved.length) persist();
  return resolved;
}

function clearTracked() {
  events.clear();
  store.write('bosPending', []);
}

module.exports = { trackBreak, resolvePendingForSymbol, clearTracked };
