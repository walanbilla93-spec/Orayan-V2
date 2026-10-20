'use strict';
// Pure frozen artifact inference. No market, provider, execution or training imports.
const {canonical}=require('./researchRequest');
const hash=x=>require('crypto').createHash('sha256').update(canonical(x)).digest('hex');
const CONTRACT='META_BRAIN_FEATURES_V1';
const FEATURES=Object.freeze(['reward_risk','spread_risk','native_score','side','regime_alignment','meta_lite']);
const finite=x=>typeof x==='number'&&Number.isFinite(x)?x:null;
function project(packet,meta) {
 const s=packet?.snapshot,p=s?.planned_trade,q=p?.quote_evidence,side=s?.side==='BUY'?1:s?.side==='SELL'?-1:null;
 const risk=side!=null&&finite(p?.entry)!=null&&finite(p?.sl)!=null?side*(p.entry-p.sl):null;
 const regime=s?.regime?.label;
 const alignment=side==null?null:['BULL_TREND','BULL_RANGE'].includes(regime)?side:['BEAR_TREND','BEAR_RANGE'].includes(regime)?-side:regime==='CHOP'?0:null;
 const values={reward_risk:risk>0&&finite(p?.tp)!=null?side*(p.tp-p.entry)/risk:null,
  spread_risk:risk>0&&finite(q?.ask)!=null&&finite(q?.bid)!=null&&q.ask>=q.bid?(q.ask-q.bid)/risk:null,
  native_score:finite(s?.score?.value??s?.score),side,regime_alignment:alignment,
  meta_lite:meta?.decision==='RETAIN'?1:meta?.decision==='SKIP'?-1:meta?.decision==='ABSTAIN'?0:null};
 return {contract:CONTRACT,identity:packet?.identity??null,symbol:s?.symbol??null,side:s?.side??null,
  regime:regime??'UNAVAILABLE',values,missing:FEATURES.filter(k=>values[k]==null),
  provider_status:{Qwen:'NOT_AVAILABLE_AT_BIRTH',Groq:'NOT_AVAILABLE_AT_BIRTH'}};
}
function validate(model) {
 if(model?.contract!==CONTRACT||model?.training_status!=='DEVELOPMENT_TRAINED'||model?.execution_authority!=='NONE'||
  canonical(model.features)!==canonical(FEATURES)||!Number.isFinite(Date.parse(model.training_cutoff))||
  !Array.isArray(model.weights)||model.weights.length!==FEATURES.length||!model.weights.every(Number.isFinite)||
  !Array.isArray(model.means)||model.means.length!==FEATURES.length||!model.means.every(Number.isFinite)||
  !Array.isArray(model.scales)||model.scales.length!==FEATURES.length||!model.scales.every(x=>Number.isFinite(x)&&x>0)||
  !Number.isFinite(model.bias)||model.retain_threshold!==0.6||model.skip_threshold!==0.4)throw Error('INVALID_FROZEN_MODEL');
 const {model_id,...body}=model;if(model_id!==hash(body))throw Error('MODEL_HASH_MISMATCH');return model;
}
function infer(input,model,at=Date.now()) {
 const result={version:'META_BRAIN_V1',feature_contract:CONTRACT,...input.identity,at,
  execution_authority:'NONE',learning_influence:0,decision:'ABSTAIN',confidence:null,
  confidence_kind:'UNCALIBRATED_DEVELOPMENT_SUCCESS_SCORE',model_id:model?.model_id??'NO_MODEL',
  training_status:model?'DEVELOPMENT_TRAINED':'UNTRAINED',reason_codes:[],top_features:[],provider_status:input.provider_status};
 const cutoff=Date.parse(input.identity?.birth_cutoff);
 if(!Number.isFinite(cutoff)||at<cutoff||!input.identity?.shared_context_hash){result.reason_codes=['IDENTITY_UNAVAILABLE'];return result;}
 if(!model){result.reason_codes=['NO_FROZEN_MODEL'];return result;}
 validate(model);
 if(Date.parse(model.training_cutoff)>=cutoff){result.reason_codes=['TRAINING_NOT_PRIOR_TO_BIRTH'];return result;}
 if(input.missing.length){result.reason_codes=['FEATURES_UNAVAILABLE'];result.missing=input.missing;return result;}
 const terms=FEATURES.map((key,i)=>({key,contribution:model.weights[i]*(input.values[key]-model.means[i])/model.scales[i]}));
 const z=model.bias+terms.reduce((n,x)=>n+x.contribution,0),score=1/(1+Math.exp(-Math.max(-40,Math.min(40,z))));
 result.confidence=score;result.decision=score>=model.retain_threshold?'RETAIN':score<=model.skip_threshold?'SKIP':'ABSTAIN';
 result.reason_codes=[result.decision==='ABSTAIN'?'SCORE_IN_UNCERTAINTY_BAND':'FROZEN_DEVELOPMENT_SCORE'];
 result.top_features=terms.sort((a,b)=>Math.abs(b.contribution)-Math.abs(a.contribution)||a.key.localeCompare(b.key)).slice(0,3);return result;
}
module.exports={CONTRACT,FEATURES,project,validate,infer,hash};
