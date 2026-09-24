'use strict';

const crypto = require('crypto');
const logger = require('./logger');
const { sleep } = require('./util');

const MAINNET = 'https://api.bybit.com';
const TESTNET = 'https://api-testnet.bybit.com';
const RECV_WINDOW = '10000';

// The ONLY environment variables this project reads. Everything else is set from the UI.
const API_KEY = process.env.BYBIT_API_KEY || '';
const API_SECRET = process.env.BYBIT_API_SECRET || '';

let clockOffsetMs = 0;

/*
 * Bybit rate limits are per-endpoint and bursty. A single in-process queue with a minimum gap
 * between calls is blunt but predictable — far better than discovering the real limit through
 * 403s while positions are open.
 */
const MIN_GAP_MS = 100;
const RESEARCH_GAP_MS = 350;
const MAX_RESEARCH_QUEUE = 16;
const MAX_CRITICAL_QUEUE = 128;
const criticalQueue = [], researchQueue = [];
let pumping = false, researchCooldownUntil = 0;
let lastCallAt = 0;

async function pump() {
  if (pumping) return;
  pumping=true;
  try {
    while (criticalQueue.length || researchQueue.length) {
      const job=criticalQueue.shift() || researchQueue.shift();
      if (job.research && Date.now()<researchCooldownUntil) {
        job.reject(new Error('Bybit research cooling down after rate limit'));
        continue;
      }
      const wait=Math.max(0,(job.research?RESEARCH_GAP_MS:MIN_GAP_MS)-(Date.now()-lastCallAt));
      if (wait) await sleep(wait);
      // A trading request may arrive while a research request waits for its
      // longer gap. Give that newly arrived request the next transport slot.
      if(job.research && criticalQueue.length){researchQueue.unshift(job);continue;}
      lastCallAt=Date.now();
      try {job.resolve(await job.fn());}
      catch(e) {
        if (job.research && (e.status===429 || e.retCode===10006 || /rate.limit/i.test(e.message||'')))
          researchCooldownUntil=Date.now()+60000;
        job.reject(e);
      }
    }
  } finally {pumping=false; if (criticalQueue.length||researchQueue.length) pump();}
}
function schedule(fn,{research=false}={}) {
  if (research && (researchQueue.length>=MAX_RESEARCH_QUEUE || Date.now()<researchCooldownUntil))
    return Promise.reject(new Error('Bybit research capacity/cooldown unavailable'));
  if (!research && criticalQueue.length>=MAX_CRITICAL_QUEUE)
    return Promise.reject(new Error('Bybit critical request queue capacity exceeded'));
  return new Promise((resolve,reject)=>{
    (research?researchQueue:criticalQueue).push({fn,resolve,reject,research});
    pump();
  });
}

function keySet() {
  return Boolean(API_KEY && API_SECRET);
}

function base(testnet) {
  return testnet ? TESTNET : MAINNET;
}

function serverTs() {
  return String(Date.now() + clockOffsetMs);
}

function sign(timestamp, payload) {
  return crypto
    .createHmac('sha256', API_SECRET)
    .update(timestamp + API_KEY + RECV_WINDOW + payload)
    .digest('hex');
}

async function request(method, path, params, { testnet = true, auth = false, timeoutMs = 15000 } = {}) {
  const url = new URL(path, base(testnet));
  let body;
  let payload = '';

  if (method === 'GET') {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null && v !== '') qs.append(k, String(v));
    }
    payload = qs.toString();
    url.search = payload;
  } else {
    body = JSON.stringify(params || {});
    payload = body;
  }

  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    if (!keySet()) throw new Error('Bybit API key and secret are not set on the server.');
    const ts = serverTs();
    headers['X-BAPI-API-KEY'] = API_KEY;
    headers['X-BAPI-TIMESTAMP'] = ts;
    headers['X-BAPI-RECV-WINDOW'] = RECV_WINDOW;
    headers['X-BAPI-SIGN'] = sign(ts, payload);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), { method, headers, body, signal: ctrl.signal });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (_e) {
      throw new Error(`Bybit returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      const err=new Error(`Bybit ${path} HTTP ${res.status}: ${json.retMsg||'request failed'}`);
      err.status=res.status;
      err.retCode=json.retCode;
      throw err;
    }
    if (json.retCode !== 0) {
      const err = new Error(`Bybit ${path} failed: ${json.retMsg || 'unknown'} (retCode ${json.retCode})`);
      err.retCode = json.retCode;
      err.retMsg = json.retMsg;
      throw err;
    }
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

/** Retry only on transport/rate errors — never blindly on a rejected order. */
async function withRetry(fn, { attempts = 3, label = 'bybit' } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (e.status===429 || e.retCode===10006) researchCooldownUntil=Date.now()+60000;
      const retriable = e.name === 'AbortError'
        || /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(e.message || '')
        || e.status === 429 || e.retCode === 10006 || e.retCode === 10016;
      if (!retriable || i === attempts) break;
      const backoff = 400 * 2 ** (i - 1);
      logger.warn('bybit', `${label} attempt ${i} failed, retrying in ${backoff}ms`, { error: e.message });
      await sleep(backoff);
    }
  }
  throw lastErr;
}

const publicGet = (path, params, testnet) =>
  schedule(() => withRetry(() => request('GET', path, params, { testnet, auth: false }), { label: path }));

// Best effort only. Research has a bounded, lower-priority queue and no retry burst.
const researchGet = (path, params, testnet) =>
  schedule(() => request('GET',path,params,{testnet,auth:false,timeoutMs:7000}),{research:true});

const privateGet = (path, params, testnet) =>
  schedule(() => withRetry(() => request('GET', path, params, { testnet, auth: true }), { label: path }));

const privatePost = (path, params, testnet) =>
  schedule(() => withRetry(() => request('POST', path, params, { testnet, auth: true }), { attempts: 2, label: path }));

/** Align local clock with Bybit's so signed requests are not rejected for timestamp drift. */
async function syncClock(testnet) {
  try {
    const r = await publicGet('/v5/market/time', {}, testnet);
    const server = Number(r.timeNano) / 1e6;
    if (Number.isFinite(server)) {
      clockOffsetMs = Math.round(server - Date.now());
      logger.info('bybit', `Clock synced with Bybit (offset ${clockOffsetMs}ms)`);
    }
  } catch (e) {
    logger.warn('bybit', 'Could not sync clock with Bybit', { error: e.message });
  }
}

module.exports = {
  keySet,
  syncClock,
  publicGet,
  researchGet,
  privateGet,
  privatePost,
  getClockOffset: () => clockOffsetMs,
};
