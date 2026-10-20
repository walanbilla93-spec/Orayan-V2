'use strict';
const {hash}=require('./metaBrainV1');
const num=x=>typeof x==='number'&&Number.isFinite(x)?x:null;
function build(trade,birth,decisions={},path={},at=Date.now()) {
 if(trade?.mode!=='paper'||trade.status!=='CLOSED'||trade.engine==='MARCI_SHADOW'||trade.researchEngine?.startsWith('MARCI'))return null;
 if(!Number.isFinite(trade.closedAt)||!trade.id||trade.closedAt>at)return null;
 const identity=birth?.identity??null, r=num(trade.realisedRR);
 // Existing OHLC extrema cannot establish event ordering or signal validity.
 const category=r==null?'OUTCOME_UNAVAILABLE':r>0?'POSITIVE_NET_R':r<0?'NEGATIVE_NET_R':'FLAT_NET_R';
 return {contract:'AI_POST_TRADE_FEEDBACK_V1',feedback_id:hash(['AI_POST_TRADE_FEEDBACK_V1',trade.id,trade.closedAt,trade.originEpoch??identity?.source_epoch??null]),
  trade_id:trade.id,closed_at:trade.closedAt,at,available_at:at,resolved_at:trade.closedAt,identity,sourceEpisodeId:identity?.opportunity_id??trade.episodeId??null,
  cohort_status:identity?'LINKED':'UNAVAILABLE_BIRTH_REFERENCE',symbol:trade.symbol,side:trade.side,
  causal_context:birth?.context??{regime:'UNAVAILABLE',side:trade.side,symbol:trade.symbol},
  original_ai:{Meta:birth?.decision??{status:'UNAVAILABLE'},MetaLite:birth?.meta_lite??{status:'UNAVAILABLE'},
   Qwen:decisions.Qwen??{status:'UNAVAILABLE'},Groq:decisions.Groq??{status:'UNAVAILABLE'}},
  native:{mode:'PAPER',admission:'ORDER_CREATED',fill_status:trade.filledAt?'FILLED':'UNAVAILABLE',
   filled_at:trade.filledAt??null,fill_price:num(trade.fillPrice),outcome:'CLOSED',realized_r:r,
   close_reason:typeof trade.closeReason==='string'?trade.closeReason.slice(0,160):'UNAVAILABLE',
   net_pnl:num(trade.netPnl),fees:num(trade.fees),funding:num(trade.fundingCost),funding_status:trade.fundingStatus??'UNAVAILABLE',cost_status:num(trade.fees)==null?'UNAVAILABLE':'PARTIAL_FEES_ONLY'},
  path:{mfe_r:num(path.mfeR),mae_r:num(path.maeR),precision:path.excursionPrecision??'UNAVAILABLE',
   intrabar_order:'UNKNOWN',terminal_minute_may_include_post_exit:true,early_path:'UNAVAILABLE'},
  false_signal_taxonomy:'AMBIGUOUS_UNSUPPORTED',taxonomy_reason:'NO_VALIDATED_CAUSAL_PATH_ORDERING',
  lesson_category:category,execution_authority:'NONE'};
}
module.exports={build};
