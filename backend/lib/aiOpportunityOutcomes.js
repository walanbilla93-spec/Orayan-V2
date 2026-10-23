'use strict';
// Research only. Frozen hypothetical geometry; no executor, order or settings writes.
// Plans live in the existing disk index, with a separate pending cursor. Never
// hydrate completed plans or candle history into process-wide maps/arrays.
const {sha}=require('./researchStore');
const MINUTE=60000, PAGE=256, VERSION='AI_OPPORTUNITY_OUTCOME_V1';
const pause=()=>new Promise(resolve=>setImmediate(resolve));
const idFor=i=>sha(JSON.stringify([VERSION,i.source_epoch,i.opportunity_id,i.shared_context_hash]));
function policy(settings){
  const out={};
  for(const [k,min,max]of [['entryWindowMin',5,480],['maxHoldMin',15,4320],['entryBufferBps',0,50],['tpThroughBps',0,50]]){
    const n=settings?.[k];if(typeof n!=='number'||!Number.isFinite(n)||n<min||n>max)throw Error('OUTCOME_FROZEN_POLICY_UNAVAILABLE:'+k);out[k]=n;
  }
  out.testnet=settings.testnet===true;return out;
}
function identity(x){const i=require('./researchPayload').identity(x);return {...i,birth_cutoff:i.birth_cutoff||x.causal_cutoff};}
function valid(i){return i&&['source_epoch','opportunity_id','shared_context_hash'].every(k=>typeof i[k]==='string'&&i[k].length>0)&&Number.isFinite(Date.parse(i.birth_cutoff));}
function reduce(plan,bars,through){
  const p=structuredClone(plan),buy=p.side==='BUY',entryBuffer=p.entry*p.policy.entryBufferBps/1e4;
  for(const b of bars){
    if(b.ts<p.nextMinute)continue;
    if(b.ts>=through)break;
    if(b.ts!==p.nextMinute)throw Error('OUTCOME_CANDLE_GAP');
    if(p.filledAt==null&&b.ts>=p.entryDeadline){p.label='ENTRY_NOT_FILLED';break;}
    if(p.filledAt!=null&&b.ts>=p.holdDeadline){p.label='TIMEOUT';break;}
    const tp=buy?b.high>=p.tp*(1+p.policy.tpThroughBps/1e4):b.low<=p.tp*(1-p.policy.tpThroughBps/1e4);
    const sl=buy?b.low<=p.sl:b.high>=p.sl;
    if(p.filledAt==null){
      const touched=buy?b.low<=p.entry-entryBuffer:b.high>=p.entry+entryBuffer;
      if(touched&&b.ts+MINUTE>p.entryDeadline){p.label='ENTRY_EXPIRY_BAR_AMBIGUOUS';p.nextMinute=b.ts+MINUTE;p.barsEvaluated++;p.resolvedMinute=b.ts;break;}
      if(touched){p.filledAt=b.ts;p.holdDeadline=b.ts+p.policy.maxHoldMin*MINUTE;
        // OHLC cannot order a limit fill against a barrier in its entry minute.
        if(tp||sl){p.label='ENTRY_BAR_AMBIGUOUS';p.tpTouched=tp;p.slTouched=sl;}
      }
    }else if(tp||sl){p.label=tp&&sl?'AMBIGUOUS_TP_SL':tp?'TP_FIRST':'SL_FIRST';p.tpTouched=tp;p.slTouched=sl;}
    p.nextMinute=b.ts+MINUTE;p.barsEvaluated++;
    if(p.label){p.resolvedMinute=b.ts;break;}
  }
  if(!p.label&&p.nextMinute>=p.entryDeadline&&p.filledAt==null)p.label='ENTRY_NOT_FILLED';
  if(!p.label&&p.filledAt!=null&&p.nextMinute>=p.holdDeadline)p.label='TIMEOUT';
  return p;
}
class Tracker{
  constructor(c,{now=Date.now,fetchBars}={}){this.c=c;this.now=now;this.fetchBars=fetchBars||((params,testnet)=>require('./bybit').researchGet('/v5/market/kline',params,testnet));this.busy=false;}
  get(id){return this.c.get('work','ai-outcome:'+id);}
  emit(key,row){const c=this.c;if(c.get('dedupe',key))return;
    if(!c.emit('outcomes',{event:VERSION,...row},{key,signature:key}))throw Error('OUTCOME_CAPTURE_FAILED');
  }
  summary(){return this.c.state.aiOpportunityOutcomes||{version:VERSION,registered:0,pending:0,resolved:0,opinions:0,providerResponses:0,reviewedOpportunities:0,failedResponses:0,labels:{},providers:{},recovery:'PENDING'};}
  save(p,prior){const c=this.c,s=structuredClone(this.summary());
    if(!prior)s.registered++;
    if(p.label&&!prior?.label){s.pending--;s.resolved++;s.labels[p.label]=(s.labels[p.label]||0)+1;}
    if(Object.keys(p.opinions).length&&!Object.keys(prior?.opinions||{}).length){s.reviewedOpportunities++;if(!p.label)s.pending++;}
    for(const [provider,o]of Object.entries(p.opinions)){
      const old=prior?.opinions?.[provider];if(!old)s.providerResponses++;
      if(o.status==='OK'&&old?.status!=='OK')s.opinions++;
      if(o.status!=='OK'&&!old)s.failedResponses++;
      if(o.status==='OK'&&old&&old.status!=='OK')s.failedResponses--;
      if(p.label&&o.status==='OK'&&!o.scored){const key=o.decision+':'+p.label;s.providers[provider]??={};s.providers[provider][key]=(s.providers[provider][key]||0)+1;o.scored=true;}
    }
    c.transaction(()=>{c.put('work','ai-outcome:'+p.id,p);if(p.label)c.remove('aiOutcomePending',p.id);else if(Object.keys(p.opinions).length)c.put('aiOutcomePending',p.id,{nextAttemptAt:p.nextAttemptAt||0});c.state.aiOpportunityOutcomes=s;});
  }
  register({identity:i,symbol,side,entry,sl,tp,settings,origin='PROSPECTIVE',birthEventId=null}){
    if(!valid(i))throw Error('OUTCOME_IDENTITY_UNAVAILABLE');const id=idFor(i),old=this.get(id);if(old)return old;
    const cutoff=Date.parse(i.birth_cutoff),p={id,identity:i,symbol,side,entry,sl,tp,policy:policy(settings),origin,birthEventId,
      registeredAt:this.now(),nextMinute:Math.ceil(cutoff/MINUTE)*MINUTE,entryDeadline:cutoff+settings.entryWindowMin*MINUTE,
      filledAt:null,holdDeadline:null,barsEvaluated:0,opinions:{},failures:0};
    if(!/^[A-Z0-9]{2,40}$/.test(symbol)||!['BUY','SELL'].includes(side)||![entry,sl,tp].every(x=>typeof x==='number'&&Number.isFinite(x)&&x>0)||!(side==='BUY'?sl<entry&&entry<tp:tp<entry&&entry<sl))throw Error('OUTCOME_GEOMETRY_UNAVAILABLE');
    this.emit('ai-outcome-plan:'+id,{phase:'REGISTERED',sourceEpisodeId:i.opportunity_id,...p});this.save(p,null);return p;
  }
  attach(ctx,result,eventId){
    const i=identity(ctx);if(!valid(i))return false;const p=this.get(idFor(i));if(!p)return false;
    const provider=ctx.provider,decision=result.decision?.decision;
    if(!['Groq','Alibaba'].includes(provider)||typeof result.status!=='string'||result.status==='OK'&&!['RETAIN','SKIP','ABSTAIN'].includes(decision))return false;
    if(p.opinions[provider]?.status==='OK'||p.opinions[provider]?.eventId===eventId)return true;
    const prior=structuredClone(p);p.opinions[provider]={status:result.status,decision:result.status==='OK'?decision:null,eventId,attemptId:ctx.attemptId,availableAt:ctx.availableAt||this.now(),scored:false};
    this.emit('ai-outcome-opinion:'+p.id+':'+provider+':'+eventId,{phase:'OPINION_LINKED',sourceEpisodeId:i.opportunity_id,outcomePlanId:p.id,identity:i,provider,opinion:p.opinions[provider]});this.save(p,prior);return true;
  }
  async recover(){
    const c=this.c;if(this.recovered)return;
    c.exportReaders=(c.exportReaders||0)+1;let n=0,missing=0,unlinked=0;
    try{
      // Two streaming disk passes: births first, then original responses. No
      // historical trades.json, V2 namespace, synthetic AI calls or new epochs.
      await require('./researchArchiveV3').recoveryRows(c,async row=>{
        if(row.stream!=='decisions'||row.boundary!=='candidate_birth'||!row.meta_lite||!valid(identity(row.meta_lite)))return;
        try{const configId=c.get('definitions',row.configHash),meta=configId&&c.get('events',configId),config=meta&&c.readRow(meta).config;
          const g=row.geometry;this.register({identity:identity(row.meta_lite),symbol:row.symbol,side:row.side,entry:g?.entryPrice,sl:g?.invalidationPrice,tp:g?.objectivePrice,settings:config,origin:'RECONSTRUCTED_FROM_FROZEN_BIRTH',birthEventId:row.eventId});
        }catch(e){if(!/^OUTCOME_(FROZEN_POLICY|GEOMETRY|IDENTITY)_UNAVAILABLE/.test(e.message))throw e;missing++;}
        if(++n%16===0)await pause();
      },m=>m.stream==='decisions',row=>row.stream==='decisions'&&row.boundary==='candidate_birth');
      await require('./researchArchiveV3').recoveryRows(c,async row=>{if(row.stream==='ai_calls'&&row.event==='PARSED_RESPONSE'&&!this.attach({...row,availableAt:row.at},{status:row.status,decision:row.normalizedResponse||row.parsed},row.eventId))unlinked++;},m=>m.stream==='ai_calls'&&m.aiEvent==='PARSED_RESPONSE',row=>row.stream==='ai_calls'&&row.event==='PARSED_RESPONSE');
      c.transaction(()=>{c.state.aiOpportunityOutcomes={...this.summary(),recovery:'COMPLETE',unrecoverableBirths:missing,unlinkedRecordedOpinions:unlinked,recoveryCompletedAt:this.now()};});
      this.recovered=true;
    }finally{c.exportReaders--;}
  }
  async tick(limit=4){
    if(this.busy)return;this.busy=true;
    try{await this.recover();let calls=0,n=0;
      for(const [id,due]of this.c.entries('aiOutcomePending')){
        if(++n%64===0)await pause();if(due.nextAttemptAt>this.now())continue;if(calls>=limit)break;
        const old=this.get(id);if(!old)throw Error('OUTCOME_PENDING_PLAN_MISSING');let p=structuredClone(old);
        // Only completed minutes, and at most 256 candles per research request.
        const through=Math.min(Math.floor(this.now()/MINUTE)*MINUTE,p.filledAt==null?Math.ceil(p.entryDeadline/MINUTE)*MINUTE:p.holdDeadline);
        if(p.nextMinute>=through)continue;calls++;
        try{
          const end=Math.min(through,p.nextMinute+PAGE*MINUTE);
          const res=await this.fetchBars({category:'linear',symbol:p.symbol,interval:'1',start:p.nextMinute,end:end-1,limit:PAGE},p.policy.testnet);
          if(!Array.isArray(res?.list)||res.list.length>PAGE)throw Error('OUTCOME_CANDLE_RESPONSE_INVALID');
          const bars=res.list.map(x=>({ts:Number(x[0]),open:Number(x[1]),high:Number(x[2]),low:Number(x[3]),close:Number(x[4])})).sort((a,b)=>a.ts-b.ts);
          if(!bars.length)throw Error('OUTCOME_CANDLE_DATA_UNAVAILABLE');
          for(const b of bars)if(!Object.values(b).every(Number.isFinite)||b.ts%MINUTE||b.high<Math.max(b.open,b.close,b.low)||b.low>Math.min(b.open,b.close,b.high))throw Error('OUTCOME_CANDLE_RESPONSE_INVALID');
          p=reduce(p,bars,end);if(p.nextMinute<end&&!p.label)throw Error('OUTCOME_CANDLE_GAP');p.failures=0;p.nextAttemptAt=this.now()+60000;p.lastError=null;
        }catch(e){p=structuredClone(old);p.failures++;p.lastError=e.reasonCode||e.code||e.message;p.nextAttemptAt=this.now()+120000;
          if(p.failures>=12){p.label='DATA_UNAVAILABLE';p.resolvedMinute=null;}
        }
        if(p.label)this.emit('ai-outcome-resolved:'+id,{phase:'RESOLVED',sourceEpisodeId:p.identity.opportunity_id,outcomePlanId:id,identity:p.identity,label:p.label,trackingComplete:true,
          observationSource:'BYBIT_COMPLETED_1M_OHLC',origin:p.origin,geometry:{entry:p.entry,sl:p.sl,tp:p.tp},policy:p.policy,
          evaluatedFromAt:Math.ceil(Date.parse(p.identity.birth_cutoff)/MINUTE)*MINUTE,evaluatedThroughAt:p.nextMinute,
          filledAt:p.filledAt,resolvedMinute:p.resolvedMinute??null,tpTouched:p.tpTouched??null,slTouched:p.slTouched??null,barsEvaluated:p.barsEvaluated,opinionReferences:p.opinions,
          partialBirthMinuteExcluded:true,entryBarOrder:'UNKNOWN',lastError:p.lastError});
        this.save(p,old);await pause();
      }
    }finally{this.busy=false;}
  }
}
let singleton;
function current(){const c=require('./minimalCapture').current();if(c.backend!=='v3'||!c.state.cleanProspectiveExperiment)return null;if(singleton?.c!==c)singleton=new Tracker(c);return singleton;}
function observeBirth(packet,signal,settings){try{return current()?.register({identity:packet.identity,symbol:signal.symbol,side:signal.side,entry:signal.entry,sl:signal.sl,tp:signal.tp,settings});}catch(e){require('./logger').warn('research','AI outcome registration unavailable',{error:e.message});}}
function observeAI(ctx,result,eventId){try{current()?.attach(ctx,result,eventId);}catch(e){require('./logger').warn('research','AI outcome link unavailable',{error:e.message});}}
module.exports={Tracker,reduce,policy,idFor,observeBirth,observeAI,current,VERSION};
