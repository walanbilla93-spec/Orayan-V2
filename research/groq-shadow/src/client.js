'use strict';

const {ENDPOINT} = require('./constants');

function boundedText(value, max, secrets = []) {
  if (typeof value !== 'string') return null;
  let clean = value;
  for (const secret of secrets) if (secret) clean=clean.split(String(secret)).join('[REDACTED_SECRET]');
  clean = clean.replace(/bearer\s+\S+/gi,'[REDACTED_AUTH]')
    .replace(/\bgsk_[a-z0-9_-]+\b/gi,'[REDACTED_GROQ_KEY]').replace(/\s+/g,' ').trim();
  return clean ? clean.slice(0,max) : null;
}

function sanitizedApiError(body, secrets = []) {
  const error = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : {};
  return {
    type:boundedText(error.type,96,secrets),
    code:boundedText(error.code,96,secrets),
    message:boundedText(error.message,512,secrets),
  };
}

function classifyApiError(httpStatus, error) {
  if (httpStatus === 400) {
    const detail = `${error?.type || ''} ${error?.code || ''} ${error?.message || ''}`.toLowerCase();
    return /schema|json|response.?format|failed.?generation|structured/.test(detail) ? 'API_400_SCHEMA' : 'API_400_REQUEST';
  }
  if (httpStatus === 401) return 'API_401_AUTH';
  if (httpStatus === 403) return 'API_403_FORBIDDEN';
  if (httpStatus === 429) return 'API_429_RATE_LIMIT';
  if (httpStatus >= 500) return 'API_5XX';
  return `API_${httpStatus || 'UNKNOWN'}`;
}

async function postGroq(requestBody, {apiKey, timeoutMs, fetchImpl = globalThis.fetch,onRaw}) {
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
    if(onRaw)await onRaw(text,{httpStatus:response.status,providerCallId:response.headers?.get?.("x-request-id")||null});
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = {unparsed:true}; }
    const headers = {
      retry_after:response.headers?.get?.('retry-after') || null,
      remaining_requests:response.headers?.get?.('x-ratelimit-remaining-requests') || null,
      remaining_tokens:response.headers?.get?.('x-ratelimit-remaining-tokens') || null,
    };
    if (response.ok) return {ok:true,status:'OK',httpStatus:response.status,body,headers,latencyMs:Date.now()-started};
    const error = sanitizedApiError(body,[apiKey]);
    const status = classifyApiError(response.status,error);
    return {ok:false,status,httpStatus:response.status,body,headers,error,latencyMs:Date.now()-started};
  } catch (error) {
    if(error.code==='RESEARCH_CAPTURE_HALTED')throw error;
    const timeout = error?.name === 'AbortError';
    return {ok:false,status:timeout?'TIMEOUT':'NETWORK_ERROR',httpStatus:null,body:null,headers:{},latencyMs:Date.now()-started};
  } finally { clearTimeout(timer); }
}

module.exports = {postGroq,sanitizedApiError,classifyApiError};
