'use strict';
// Frozen research experiment, NOT the original Meta evaluator. No state or I/O.
const VERSION = 'META_LITE_V1';
const REASONS = Object.freeze(['EVIDENCE_ACCEPTABLE','LOW_REWARD_RISK','SPREAD_STOP_FRACTION',
  'OPPOSING_REGIME','INPUT_MISSING','SOURCE_NOT_CAUSAL','SOURCE_STALE',
  'INVALID_GEOMETRY','UNKNOWN_REGIME','SHARED_PACKET_UNAVAILABLE','EVALUATOR_ERROR']);
const REGIMES = Object.freeze(['BULL_TREND','BEAR_TREND','BULL_RANGE','BEAR_RANGE','CHOP']);
const number = x => typeof x === 'number' && Number.isFinite(x) ? x : null;
const clock = x => typeof x === 'string' && Number.isFinite(Date.parse(x)) ? x : null;
function project(packet) {
  const s = packet?.snapshot, p = s?.planned_trade, q = p?.quote_evidence, r = s?.regime;
  // Exact input allowlist. Never read score, gates, risk/reason flags, H1/H2 or outcomes.
  return {cutoff:clock(s?.candidate_birth_at_utc),side:['BUY','SELL'].includes(s?.side)?s.side:null,
    entry:number(p?.entry),stop:number(p?.sl),target:number(p?.tp),
    bid:number(q?.bid),ask:number(q?.ask),
    quote_observed:clock(q?.observed_at_utc),quote_received:clock(q?.available_to_system_at_utc),
    regime:REGIMES.includes(r?.label)?r.label:null,
    regime_observed:clock(r?.observed_at_utc),regime_received:clock(r?.available_to_system_at_utc)};
}
function result(packet, input, status, reasons) {
  const i = packet?.identity;
  return {meta_lite_version:VERSION,cohort_id:i?.cohort_id??null,
    shared_context_hash:i?.shared_context_hash??null,opportunity_id:i?.opportunity_id??null,
    source_epoch:i?.source_epoch??null,causal_cutoff:i?.birth_cutoff??input?.cutoff??null,
    status,decision:status==='OK_RETAIN'?'RETAIN':status==='OK_SKIP'?'SKIP':'ABSTAIN',
    confidence:status==='OK_RETAIN'?0.55:status==='OK_SKIP'?0.65:0,
    confidence_kind:'UNCALIBRATED_FIXED_V1',reason_codes:reasons,input,
    execution_authority:'NONE',learning_influence:0};
}
function evaluate(packet) {
  const x = project(packet), i = packet?.identity;
  if (!i?.cohort_id || !i?.shared_context_hash || !i?.opportunity_id || !i?.source_epoch ||
      !x.cutoff || x.cutoff !== i.birth_cutoff)
    return result(packet,null,'INPUT_UNAVAILABLE',['SHARED_PACKET_UNAVAILABLE']);
  if (Object.values(x).some(v=>v==null))
    return result(packet,null,'INPUT_UNAVAILABLE',[x.regime==null?'UNKNOWN_REGIME':'INPUT_MISSING']);
  const cutoff = Date.parse(x.cutoff);
  if ([x.quote_observed,x.quote_received,x.regime_observed,x.regime_received].some(t=>Date.parse(t)>cutoff) ||
      Date.parse(x.quote_observed)>Date.parse(x.quote_received) || Date.parse(x.regime_observed)>Date.parse(x.regime_received))
    return result(packet,null,'INPUT_UNAVAILABLE',['SOURCE_NOT_CAUSAL']);
  if (cutoff-Date.parse(x.quote_observed)>15000 || cutoff-Date.parse(x.regime_observed)>1200000)
    return result(packet,x,'INPUT_UNAVAILABLE',['SOURCE_STALE']);
  const sign = x.side==='BUY'?1:-1, risk = sign*(x.entry-x.stop), reward = sign*(x.target-x.entry);
  if (!(x.entry>0 && x.stop>0 && x.target>0 && risk>0 && reward>0 && x.bid>0 && x.ask>=x.bid))
    return result(packet,x,'OK_ABSTAIN',['INVALID_GEOMETRY']);
  const reasons = [];
  if (reward/risk<1.5) reasons.push('LOW_REWARD_RISK');
  if ((x.ask-x.bid)/risk>=0.1) reasons.push('SPREAD_STOP_FRACTION');
  if (x.side==='BUY' && x.regime==='BEAR_TREND' || x.side==='SELL' && x.regime==='BULL_TREND') reasons.push('OPPOSING_REGIME');
  return result(packet,x,reasons.length?'OK_SKIP':'OK_RETAIN',reasons.length?reasons:['EVIDENCE_ACCEPTABLE']);
}
function unavailable(birth, epoch, reason = 'SHARED_PACKET_UNAVAILABLE', packet) {
  const identity = {opportunity_id:birth.episodeId,source_epoch:epoch,
    birth_cutoff:new Date(birth.decisionAt??birth.at).toISOString()};
  identity.cohort_id = require('crypto').createHash('sha256').update(require('./researchRequest').canonical([
    require('./researchPayload').PACKET_VERSION,epoch,birth.episodeId])).digest('hex');
  return result(packet || {identity},null,reason==='EVALUATOR_ERROR'?'CENSORED_OPERATIONAL':'INPUT_UNAVAILABLE',[reason]);
}
module.exports = {VERSION,REASONS,project,evaluate,unavailable};
