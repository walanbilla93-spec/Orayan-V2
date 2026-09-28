'use strict';

const {ENDPOINT} = require('./constants');

async function postGroq(requestBody, {apiKey, timeoutMs, fetchImpl = globalThis.fetch}) {
  if (!apiKey) return {ok:false,status:'API_KEY_ABSENT',httpStatus:null,body:null,headers:{}};
  if (typeof fetchImpl !== 'function') return {ok:false,status:'FETCH_UNAVAILABLE',httpStatus:null,body:null,headers:{}};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetchImpl(ENDPOINT, {
      method:'POST', signal:controller.signal,
      headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json'},
      body:JSON.stringify(requestBody),
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = {unparsed:true}; }
    const headers = {
      retry_after:response.headers?.get?.('retry-after') || null,
      remaining_requests:response.headers?.get?.('x-ratelimit-remaining-requests') || null,
      remaining_tokens:response.headers?.get?.('x-ratelimit-remaining-tokens') || null,
    };
    if (response.ok) return {ok:true,status:'OK',httpStatus:response.status,body,headers,latencyMs:Date.now()-started};
    const status = response.status === 429 ? 'RATE_LIMITED'
      : response.status >= 500 ? 'UPSTREAM_5XX' : 'API_ERROR';
    return {ok:false,status,httpStatus:response.status,body,headers,latencyMs:Date.now()-started};
  } catch (error) {
    const timeout = error?.name === 'AbortError';
    return {ok:false,status:timeout?'TIMEOUT':'NETWORK_ERROR',httpStatus:null,body:null,headers:{},latencyMs:Date.now()-started};
  } finally { clearTimeout(timer); }
}

module.exports = {postGroq};
