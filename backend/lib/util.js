'use strict';

function num(v, dflt = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, num(v, lo)));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Round a quantity DOWN to the instrument's step size. Rounding up can exceed risk. */
function floorToStep(value, step) {
  const v = num(value, 0);
  const s = num(step, 0);
  if (s <= 0) return v;
  const decimals = decimalsOf(s);
  const n = Math.floor(v / s) * s;
  return Number(n.toFixed(decimals));
}

/** Round a price to the instrument's tick size (nearest — prices aren't risk-directional). */
function roundToTick(value, tick) {
  const v = num(value, 0);
  const t = num(tick, 0);
  if (t <= 0) return v;
  const decimals = decimalsOf(t);
  return Number((Math.round(v / t) * t).toFixed(decimals));
}

function decimalsOf(step) {
  const s = String(step);
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function pct(a, b) {
  if (!b) return 0;
  return ((a - b) / b) * 100;
}

function mean(arr) {
  if (!arr || !arr.length) return 0;
  let s = 0;
  for (const v of arr) s += num(v, 0);
  return s / arr.length;
}

function median(arr) {
  if (!arr || !arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function stdev(arr) {
  if (!arr || arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((acc, v) => acc + (v - m) ** 2, 0) / (arr.length - 1));
}

function safeJson(v, dflt = null) {
  try {
    return JSON.parse(v);
  } catch (_e) {
    return dflt;
  }
}

module.exports = {
  num, clamp, sleep, floorToStep, roundToTick, decimalsOf,
  uid, pct, mean, median, stdev, safeJson,
};
