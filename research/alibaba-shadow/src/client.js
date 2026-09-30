'use strict';

const {DEFAULT_BASE_URL}=require('./constants');

function boundedText(value,max,secrets=[]) {
  if(typeof value!=='string')return null;
  let clean=value;
  for(const secret of secrets)if(secret)clean=clean.split(String(secret)).join('[REDACTED_SECRET]');
  clean=clean.replace(/bearer\s+\S+/gi,'[REDACTED_AUTH]')
    .replace(/\bsk-[a-z0-9_-]{8,}\b/gi,'[REDACTED_ALIBABA_KEY]').replace(/\s+/g,' ').trim();
  return clean?clean.slice(0,max):null;
}
function sanitizedApiError(body,secrets=[]) {
  const error=body&&typeof body==='object'&&body.error&&typeof body.error==='object'?body.error:{};
  return {type:boundedText(error.type,96,secrets),code:boundedText(error.code,96,secrets),
    message:boundedText(error.message,512,secrets)};
}
function classifyApiError(httpStatus,error) {
  if(httpStatus===400){
    const detail=`${error?.type||''} ${error?.code||''} ${error?.message||''}`.toLowerCase();
    return /schema|json|response.?format|structured|enable_thinking/.test(detail)?'API_400_SCHEMA':'API_400_REQUEST';
  }
  if(httpStatus===401)return 'API_401_AUTH';
  if(httpStatus===403)return 'API_403_FORBIDDEN';
  if(httpStatus===429)return 'API_429_RATE_LIMIT';
  if(httpStatus>=500)return 'API_5XX';
  return `API_${httpStatus||'UNKNOWN'}`;
}

function endpointFor(baseUrl=DEFAULT_BASE_URL) {
  let url;
  try{url=new URL(baseUrl);}catch(_){throw Object.assign(new Error('Alibaba base URL is invalid.'),{code:'ALIBABA_BASE_URL_INVALID'});}
  const official=url.hostname==='dashscope-intl.aliyuncs.com'||
    url.hostname==='trial.ap-southeast-1.maas.aliyuncs.com'||
    /^[a-z0-9-]+\.ap-southeast-1\.maas\.aliyuncs\.com$/i.test(url.hostname);
  if(url.protocol!=='https:'||!official||url.username||url.password||url.search||url.hash||
    url.port||url.pathname.replace(/\/$/,'')!=='/compatible-mode/v1'){
    throw Object.assign(new Error('Alibaba base URL must be an official Singapore OpenAI-compatible endpoint.'),
      {code:'ALIBABA_BASE_URL_NOT_SINGAPORE'});
  }
  return `${url.toString().replace(/\/$/,'')}/chat/completions`;
}

async function postAlibaba(requestBody,{apiKey,baseUrl=DEFAULT_BASE_URL,timeoutMs,fetchImpl=globalThis.fetch}) {
  if(!apiKey)return {ok:false,status:'API_KEY_ABSENT',httpStatus:null,body:null,headers:{}};
  if(typeof fetchImpl!=='function')return {ok:false,status:'FETCH_UNAVAILABLE',httpStatus:null,body:null,headers:{}};
  let endpoint;
  try{endpoint=endpointFor(baseUrl);}catch(error){return {ok:false,status:error.code,httpStatus:null,body:null,headers:{},
    error:{type:'configuration_error',code:error.code,message:error.message}};}
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs),started=Date.now();
  try{
    const response=await fetchImpl(endpoint,{method:'POST',signal:controller.signal,
      headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify(requestBody)});
    const text=await response.text();let body=null;
    try{body=text?JSON.parse(text):null;}catch(_){body={unparsed:true};}
    const headers={retry_after:response.headers?.get?.('retry-after')||null,
      request_id:response.headers?.get?.('x-request-id')||response.headers?.get?.('request-id')||null,
      remaining_requests:response.headers?.get?.('x-ratelimit-remaining-requests')||null,
      remaining_tokens:response.headers?.get?.('x-ratelimit-remaining-tokens')||null};
    if(response.ok)return {ok:true,status:'OK',httpStatus:response.status,body,headers,latencyMs:Date.now()-started};
    const error=sanitizedApiError(body,[apiKey]);
    return {ok:false,status:classifyApiError(response.status,error),httpStatus:response.status,body,headers,error,
      latencyMs:Date.now()-started};
  }catch(error){return {ok:false,status:error?.name==='AbortError'?'TIMEOUT':'NETWORK_ERROR',httpStatus:null,body:null,
    headers:{},latencyMs:Date.now()-started};}
  finally{clearTimeout(timer);}
}

module.exports={postAlibaba,sanitizedApiError,classifyApiError,endpointFor};
