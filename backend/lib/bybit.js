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
let pumping = false, globalResearchCooldownUntil = 0;
const researchCooldownByEndpoint = new Map();
let lastCallAt = 0;
let operationalSink = null;

function cooldownUntil(endpoint) {
  const now=Date.now();
  for (const [key,until] of researchCooldownByEndpoint) if (until<=now) researchCooldownByEndpoint.delete(key);
  return Math.max(globalResearchCooldownUntil, researchCooldownByEndpoint.get(endpoint)||0);
}
function maxCooldownUntil() {
  let out=globalResearchCooldownUntil;
  for (const until of researchCooldownByEndpoint.values()) out=Math.max(out,until);
  return out;
}
function applyRateLimitCooldown(e,endpoint) {
  const until=Date.now()+60000;
  const endpointScoped=e.retCode===10006&&Boolean(endpoint);
  if (e.status===429) globalResearchCooldownUntil=until;
  else if (endpointScoped) researchCooldownByEndpoint.set(endpoint,until);
  else globalResearchCooldownUntil=until;
  operationalEvent('BYBIT_RATE_LIMIT',{reasonCode:e.retCode===10006?'RATE_LIMIT_10006':'HTTP_ERROR',
    endpoint,httpStatus:e.status||null,retCode:e.retCode||null,
    cooldownScope:endpointScoped?'ENDPOINT':'GLOBAL',endpointCooldownUntil:cooldownUntil(endpoint)});
}
function operationalEvent(type, detail = {}) {
  const event = { type, at:Date.now(), researchCooldownUntil:maxCooldownUntil(),
    criticalQueueDepth:criticalQueue.length, researchQueueDepth:researchQueue.length, ...detail };
  try { operationalSink?.(event); } catch (_) { /* telemetry must never affect transport */ }
}
function taggedError(message,reasonCode) {const error=new Error(message);error.reasonCode=reasonCode;return error;}

async function pump() {
  if (pumping) return;
  pumping=true;
  try {
    while (criticalQueue.length || researchQueue.length) {
      const job=criticalQueue.shift() || researchQueue.shift();
      const jobCooldownUntil=cooldownUntil(job.endpoint);
      if (job.research && Date.now()<jobCooldownUntil) {
        operationalEvent('RESEARCH_COOLDOWN_REJECTED',{reasonCode:'COOLDOWN_ACTIVE',endpoint:job.endpoint,
          cooldownScope:globalResearchCooldownUntil>Date.now()?'GLOBAL':'ENDPOINT',endpointCooldownUntil:jobCooldownUntil});
        job.reject(taggedError('Bybit research cooling down after rate limit','COOLDOWN_ACTIVE'));
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
          applyRateLimitCooldown(e,job.endpoint);
        job.reject(e);
      }
    }
  } finally {pumping=false; if (criticalQueue.length||researchQueue.length) pump();}
}
function schedule(fn,{research=false,endpoint=null}={}) {
  if (research && researchQueue.length>=MAX_RESEARCH_QUEUE) {
    operationalEvent('RESEARCH_QUEUE_CAPACITY',{reasonCode:'RESEARCH_QUEUE_CAPACITY',endpoint});
    return Promise.reject(taggedError('Bybit research queue capacity unavailable','RESEARCH_QUEUE_CAPACITY'));
  }
  const endpointCooldownUntil=cooldownUntil(endpoint);
  if (research && Date.now()<endpointCooldownUntil) {
    operationalEvent('RESEARCH_COOLDOWN_REJECTED',{reasonCode:'COOLDOWN_ACTIVE',endpoint,
      cooldownScope:globalResearchCooldownUntil>Date.now()?'GLOBAL':'ENDPOINT',endpointCooldownUntil});
    return Promise.reject(taggedError('Bybit research cooldown active','COOLDOWN_ACTIVE'));
  }
  if (!research && criticalQueue.length>=MAX_CRITICAL_QUEUE) {
    operationalEvent('CRITICAL_QUEUE_CAPACITY',{reasonCode:'CRITICAL_QUEUE_CAPACITY',endpoint});
    return Promise.reject(new Error('Bybit critical request queue capacity exceeded'));
  }
  return new Promise((resolve,reject)=>{
    (research?researchQueue:criticalQueue).push({fn,resolve,reject,research,endpoint});
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
      const err=new Error(`Bybit returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
      err.status=res.status;err.reasonCode='PARSE_ERROR';throw err;
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
      if (e.status===429 || e.retCode===10006) applyRateLimitCooldown(e,label);
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
  schedule(() => withRetry(() => request('GET', path, params, { testnet, auth: false }), { label: path }),{endpoint:path});

// Best effort only. Research has a bounded, lower-priority queue and no retry burst.
const researchGet = (path, params, testnet) =>
  schedule(() => request('GET',path,params,{testnet,auth:false,timeoutMs:7000}),{research:true,endpoint:path});

const privateGet = (path, params, testnet) =>
  schedule(() => withRetry(() => request('GET', path, params, { testnet, auth: true }), { label: path }),{endpoint:path});

const privatePost = (path, params, testnet) =>
  schedule(() => withRetry(() => request('POST', path, params, { testnet, auth: true }), { attempts: 2, label: path }),{endpoint:path});

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
  setOperationalSink: sink => { operationalSink = typeof sink === 'function' ? sink : null; },
  getOperationalState: () => ({researchCooldownUntil:maxCooldownUntil(),
    globalResearchCooldownUntil,researchCooldownByEndpoint:Object.fromEntries(researchCooldownByEndpoint),
    criticalQueueDepth:criticalQueue.length,researchQueueDepth:researchQueue.length}),
  getClockOffset: () => clockOffsetMs,
  _test:{schedule,cooldownUntil,applyRateLimitCooldown,
    reset:()=>{criticalQueue.length=0;researchQueue.length=0;pumping=false;lastCallAt=0;
      globalResearchCooldownUntil=0;researchCooldownByEndpoint.clear();operationalSink=null;}},
};
