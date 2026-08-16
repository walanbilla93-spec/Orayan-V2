'use strict';

const MAX = 2000;
const buf = [];
let seq = 0;

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel = 'info';

function setLevel(l) {
  if (LEVELS[l]) minLevel = l;
}

function log(level, scope, msg, data) {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  const entry = {
    seq: ++seq,
    ts: Date.now(),
    level,
    scope,
    msg: String(msg),
    data: data === undefined ? null : data,
  };
  buf.push(entry);
  if (buf.length > MAX) buf.splice(0, buf.length - MAX);
  const line = `[${new Date(entry.ts).toISOString()}] ${level.toUpperCase().padEnd(5)} ${scope} — ${entry.msg}`;
  if (level === 'error') console.error(line, data ?? '');
  else if (level === 'warn') console.warn(line, data ?? '');
  else console.log(line, data ?? '');
}

const logger = {
  setLevel,
  debug: (s, m, d) => log('debug', s, m, d),
  info: (s, m, d) => log('info', s, m, d),
  warn: (s, m, d) => log('warn', s, m, d),
  error: (s, m, d) => log('error', s, m, d),
  /** Return entries newer than `afterSeq`, newest last. */
  tail: (afterSeq = 0, limit = 300) => buf.filter((e) => e.seq > afterSeq).slice(-limit),
  clear: () => { buf.length = 0; },
};

module.exports = logger;
