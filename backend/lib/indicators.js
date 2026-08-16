'use strict';

const { num } = require('./util');

function sma(values, period) {
  if (!values || values.length < period || period <= 0) return null;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += num(values[i]);
  return s / period;
}

/** Full EMA series so callers can inspect slope, not just the latest value. */
function emaSeries(values, period) {
  if (!values || values.length < period || period <= 0) return [];
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += num(values[i]);
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = num(values[i]) * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function ema(values, period) {
  const s = emaSeries(values, period);
  return s.length ? s[s.length - 1] : null;
}

/** Wilder-smoothed RSI — the standard definition, not the naive rolling-average variant. */
function rsi(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = num(closes[i]) - num(closes[i - 1]);
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = num(closes[i]) - num(closes[i - 1]);
    gain = (gain * (period - 1) + Math.max(0, d)) / period;
    loss = (loss * (period - 1) + Math.max(0, -d)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

/** Wilder-smoothed ATR over candle objects {high, low, close}. */
function atr(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = num(candles[i].high);
    const l = num(candles[i].low);
    const pc = num(candles[i - 1].close);
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trs.length < period) return null;
  let a = 0;
  for (let i = 0; i < period; i++) a += trs[i];
  a /= period;
  for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]) / period;
  return a;
}

/** Ratio of the last closed candle's volume to the average of the N before it. */
function volumeRatio(candles, lookback = 20) {
  if (!candles || candles.length < lookback + 1) return null;
  const recent = candles.slice(-(lookback + 1));
  const last = num(recent[recent.length - 1].volume);
  const prior = recent.slice(0, -1).map((c) => num(c.volume));
  const avg = prior.reduce((a, b) => a + b, 0) / prior.length;
  if (!avg) return null;
  return last / avg;
}

module.exports = { sma, ema, emaSeries, rsi, atr, volumeRatio };
