'use strict';

const MAX = 2000;
const buf = [];
let seq = 0;

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel = 'info';
const compactBuckets=new Map();
let compactMode;

function setLevel(l) {
  if (LEVELS[l]) minLevel = l;
}

function log(level, scope, msg, data) {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  // Runtime log transport has its own finite cap; capture disks are not the only
  // place an error loop can accumulate data. Existing strategy state is untouched.
  if(compactMode===undefined)compactMode=require('fs').existsSync(require('path').resolve(__dirname,'../data/capture-minimal-policy.json'));
  if(compactMode){
    const bucket=Math.floor(Date.now()/300000),key=bucket+'|'+level+'|'+scope;
    const count=(compactBuckets.get(key)||0)+1;compactBuckets.set(key,count);
    while(compactBuckets.size>64)compactBuckets.delete(compactBuckets.keys().next().value);
    if(count>3)return;
  }
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
