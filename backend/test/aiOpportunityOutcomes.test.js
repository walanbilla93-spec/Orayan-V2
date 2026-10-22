'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {Tracker,reduce}=require('../lib/aiOpportunityOutcomes'),{ResearchStoreV3}=require('../lib/researchStoreV3');
const M=60000,at=Date.parse('2026-10-22T00:00:00Z');
const settings={entryWindowMin:5,maxHoldMin:15,entryBufferBps:0,tpThroughBps:0,testnet:false};
const identity={source_epoch:'original-clean-epoch',opportunity_id:'opportunity',shared_context_hash:'hash',birth_cutoff:new Date(at+1000).toISOString(),cohort_id:'cohort'};
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'ai-outcomes-'));let c=new ResearchStoreV3(root,{create:true,offline:true,epochId:'current-writer',reserveBytes:0});c.state.cleanProspectiveExperiment=true;
 t.after(()=>{c.index.handles.close();c.index.cache.clear();fs.rmSync(root,{recursive:true,force:true});});return {root,get c(){return c;},reopen(){c.flush();c.index.handles.close();c.index.cache.clear();c=new ResearchStoreV3(root,{offline:true});return c;}};}
function register(tracker,extra={}){return tracker.register({identity,symbol:'TESTUSDT',side:'BUY',entry:100,sl:98,tp:104,settings,...extra});}
const bar=(ts,low=99,high=101)=>({ts,open:100,low,high,close:100});
test('frozen hypothetical path distinguishes TP, SL, no-fill, timeout and OHLC ambiguity',t=>{
 const {c}=fixture(t),tracker=new Tracker(c),p=register(tracker);assert.equal(p.nextMinute,at+M);
 const run=bars=>reduce(p,bars,at+30*M);
 assert.equal(run([bar(at+M),bar(at+2*M,99,105)]).label,'TP_FIRST');
 assert.equal(run([bar(at+M),bar(at+2*M,97,101)]).label,'SL_FIRST');
 assert.equal(run([bar(at+M),bar(at+2*M,97,105)]).label,'AMBIGUOUS_TP_SL');
 assert.equal(run([bar(at+M,97,105)]).label,'ENTRY_BAR_AMBIGUOUS');
 const noFill=Array.from({length:5},(_,n)=>({...bar(at+(n+1)*M,101,103),open:102,close:102}));assert.equal(run(noFill).label,'ENTRY_NOT_FILLED');
 assert.equal(run(Array.from({length:16},(_,n)=>bar(at+(n+1)*M))).label,'TIMEOUT');
 assert.throws(()=>run([bar(at+2*M)]),/CANDLE_GAP/);
 const expiryBars=Array.from({length:5},(_,n)=>n===4?bar(at+5*M):({...bar(at+(n+1)*M,101,103),open:102,close:102}));assert.equal(run(expiryBars).label,'ENTRY_EXPIRY_BAR_AMBIGUOUS');
 const sell=register(tracker,{identity:{...identity,opportunity_id:'sell'},side:'SELL',sl:102,tp:96});assert.equal(reduce(sell,[bar(at+M),bar(at+2*M,95,101)],at+3*M).label,'TP_FIRST');
});
test('SKIP and RETAIN share one persisted path, survive restart and export with original identities',async t=>{
 const f=fixture(t);let now=at+3*M,requests=0;
 const fetchBars=async params=>{requests++;assert.ok(params.limit<=256);return {list:[[at+2*M,100,105,99,100],[at+M,100,101,99,100]]};};
 let tracker=new Tracker(f.c,{now:()=>now,fetchBars}),p=register(tracker);const source=structuredClone(settings);
 tracker.attach({...identity,provider:'Groq',attemptId:'g',availableAt:at+2000},{status:'OK',decision:{decision:'SKIP'}},'g-event');
 assert.equal(tracker.summary().registered,1);tracker=new Tracker(f.reopen(),{now:()=>now,fetchBars});
 f.c.transaction(()=>{f.c.state.aiOpportunityOutcomes={...tracker.summary(),recovery:'COMPLETE'};});
 await tracker.tick();assert.equal(tracker.get(p.id).label,'TP_FIRST');assert.equal(tracker.summary().providers.Groq['SKIP:TP_FIRST'],1);
 tracker.attach({...identity,provider:'Alibaba',attemptId:'q'},{status:'OK',decision:{decision:'RETAIN'}},'q-event');
 tracker.attach({...identity,provider:'Alibaba',attemptId:'duplicate'},{status:'OK',decision:{decision:'RETAIN'}},'duplicate-event');
 assert.equal(tracker.summary().providers.Alibaba['RETAIN:TP_FIRST'],1);assert.equal(tracker.summary().opinions,2);await tracker.tick();assert.equal(requests,1);assert.deepEqual(settings,source);
 assert.equal(f.c.enumerationAttempts,0);assert.equal(f.c.memory().structures.historyDictionaries.count,0);
 const archive=require('../lib/researchArchive'),target=path.join(f.root,'outcomes.zip');await archive.build(f.c,{sinceAt:0,target});
 let resolved=0;await archive.zipEntries(target,async(name,s)=>{if(name!=='records/outcomes.jsonl'){s.resume();return;}let b=[];for await(const r of archive.lines(s)){if(r.index===0)b=[];b.push(Buffer.from(r.data,'base64'));if(r.index+1===r.meta.chunks){const row=JSON.parse(Buffer.concat(b));if(row.phase==='RESOLVED'){resolved++;assert.equal(row.identity.source_epoch,identity.source_epoch);assert.equal(row.label,'TP_FIRST');}}}});assert.equal(resolved,1);
});
test('missing candles are retried and explicitly unavailable, never inferred as a loss or no-fill',async t=>{
 const {c}=fixture(t);let now=at+3*M;const tracker=new Tracker(c,{now:()=>now,fetchBars:async()=>({list:[]})});const p=register(tracker);
 tracker.attach({...identity,provider:'Groq'},{status:'OK',decision:{decision:'SKIP'}},'g-event');
 c.transaction(()=>{c.state.aiOpportunityOutcomes={...tracker.summary(),recovery:'COMPLETE'};});
 for(let n=0;n<12;n++){await tracker.tick();now+=120001;}
 assert.equal(tracker.get(p.id).label,'DATA_UNAVAILABLE');assert.equal(tracker.summary().labels.DATA_UNAVAILABLE,1);assert.equal(tracker.summary().labels.SL_FIRST,undefined);
});
test('restart recovery uses frozen birth policy and links existing model responses without new API calls',async t=>{
 const {c}=fixture(t);c.emit('configuration',{configHash:'cfg',config:settings});
 c.emit('decisions',{boundary:'candidate_birth',sourceEpisodeId:identity.opportunity_id,symbol:'TESTUSDT',side:'BUY',configHash:'cfg',geometry:{entryPrice:100,invalidationPrice:98,objectivePrice:104},meta_lite:{...identity,birth_cutoff:undefined,causal_cutoff:identity.birth_cutoff}});
 c.emit('ai_calls',{...identity,sourceEpisodeId:identity.opportunity_id,provider:'Groq',event:'PARSED_RESPONSE',status:'OK',normalizedResponse:{decision:'SKIP'}});
 const tracker=new Tracker(c,{fetchBars:async()=>{throw Error('RECOVERY_MUST_NOT_FETCH');}});await tracker.recover();assert.equal(tracker.summary().registered,1);assert.equal(tracker.summary().opinions,1);assert.equal(tracker.summary().unlinkedRecordedOpinions,0);
 const p=tracker.get(require('../lib/aiOpportunityOutcomes').idFor(identity));assert.equal(p.origin,'RECONSTRUCTED_FROM_FROZEN_BIRTH');assert.deepEqual(p.policy,settings);await tracker.recover();assert.equal(tracker.summary().opinions,1);
 // A crash after canonical response persistence but before its observer links it
 // must be reconciled even when an earlier recovery was marked complete.
 c.emit('ai_calls',{...identity,sourceEpisodeId:identity.opportunity_id,provider:'Alibaba',event:'PARSED_RESPONSE',status:'TIMEOUT',normalizedResponse:{decision:'ABSTAIN'}});
 const restarted=new Tracker(c);await restarted.recover();assert.equal(restarted.summary().providerResponses,2);assert.equal(restarted.summary().opinions,1);assert.equal(restarted.summary().failedResponses,1);
});
