'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const producer=require('../lib/alibabaShadowProducer'),payload=require('../lib/researchPayload');
const at=Date.parse('2026-10-23T04:00:00Z');
function environment(t,breadthAt){producer.observeEnvironment({at:t,marketSnapshot:{observedAt:breadthAt,directionalBreadth:25,universeCount:99},
 tickers:['BTCUSDT','ETHUSDT'].map(symbol=>({symbol,observedAt:t,change24hPct:1,fundingRate:.0001,openInterest:100})),btcRegime:{regime:'BULL_TREND',strength:20,observedAt:t}});}
function snapshot(){return producer.buildSnapshot({id:'C',symbol:'BTCUSDT',side:'BUY',entry:100,sl:98,tp:104,score:60,rr:2,atr:1},
 {decisionAt:at,episodeId:'EP'},{settings:{riskUsdtPerTrade:.5},ticker:{observedAt:at-1000,bid:100,ask:100.01,markPrice:100},btcRegime:{regime:'BULL_TREND',strength:20,observedAt:at-1000},openPositions:[]});}
test('repeated 15-minute breadth uses distinct causal observations while retaining real timestamps',()=>{
 producer._test.reset();environment(at-19*60000,at-26*60000);environment(at-10*60000,at-11*60000);environment(at-1000,at-11*60000);
 const s=snapshot(),f=s.h2.features.linear_breadth;
 assert.equal(Date.parse(f.observed_at_utc),at-11*60000);assert.equal(Date.parse(f.baseline_observed_at_utc),at-26*60000);
 for(const n of ['groq','alibaba'])assert.deepEqual(require('../../research/'+n+'-shadow/src/snapshot').validateSnapshot(s,at).abstainReasons.filter(x=>x.includes('baseline_gap')),[]);
 producer._test.reset();environment(at-10*60000,at-11*60000);environment(at-1000,at-11*60000);
 assert.equal(snapshot().h2.features.linear_breadth.status,'NOT_AVAILABLE','never invent a baseline after restart');
});
test('frozen quote stays fresh at birth during bounded dispatch; stale or future birth quotes still fail',()=>{
 const s={candidate_birth_at_utc:new Date(at).toISOString(),regime:{observed_at_utc:new Date(at-1000).toISOString(),age_seconds:1},
  planned_trade:{quote_evidence:{observed_at_utc:new Date(at-1000).toISOString(),age_seconds:1}},exposure:{observed_at_utc:new Date(at).toISOString(),age_seconds:0}};
 assert.deepEqual(payload.staleReasons(s,at+30000,75000),[]);
 s.planned_trade.quote_evidence.observed_at_utc=new Date(at-16000).toISOString();assert.ok(payload.staleReasons(s,at+30000,75000).includes('quote:stale_or_future'));
 s.planned_trade.quote_evidence.observed_at_utc=new Date(at+1).toISOString();assert.ok(payload.staleReasons(s,at+30000,75000).includes('quote:stale_or_future'));
 assert.ok(payload.staleReasons(s,at+75001,75000).includes('snapshot:stale_or_future'));
});
test('research quote cache uses lower priority acquisition and cannot overwrite native cached inputs',async()=>{
 const market=require('../lib/marketData'),bybit=require('../lib/bybit'),old={publicGet:bybit.publicGet,researchGet:bybit.researchGet};market.clearCaches();let research=0;
 const list=price=>({list:[{symbol:'BTCUSDT',bid1Price:String(price),ask1Price:String(price+1),lastPrice:String(price),markPrice:String(price)}]});
 bybit.publicGet=async()=>list(100);bybit.researchGet=async()=>{research++;return list(200);};
 try{const native=await market.getTickers({testnet:false}),fresh=await market.getTickers({testnet:false,research:true,ttlMs:5000});
  assert.equal(fresh[0].bid,200);assert.equal((await market.getTickers({testnet:false})),native);assert.equal(native[0].bid,100);
  assert.equal(await market.getTickers({testnet:false,research:true,ttlMs:5000}),fresh);assert.equal(research,1);
 }finally{Object.assign(bybit,old);market.clearCaches();}
});
test('feedback survives a writer epoch change in the same clean namespace; foreign history remains excluded',t=>{
 const {EvidenceStore}=require('../lib/metaBrainResearch'),feedback=require('../lib/aiPostTradeFeedback');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ai-repair-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const identity={source_epoch:'clean-first-writer',opportunity_id:'prior',shared_context_hash:'H'},birth={identity,context:{regime:'BULL_TREND',symbol:'BTCUSDT',side:'BUY'}};
 const f=feedback.build({id:'T',originEpoch:identity.source_epoch,mode:'paper',status:'CLOSED',closedAt:at-20000,symbol:'BTCUSDT',side:'BUY',realisedRR:-1},birth,{}, {},at-10000),key=['T',f.closed_at,identity.source_epoch];
 new EvidenceStore(root,{epochId:identity.source_epoch}).put('feedback',key,f);
 assert.throws(()=>new EvidenceStore(root,{epochId:'new-writer'}),/FEEDBACK_SOURCE_EPOCH_MISMATCH/);
 const c=new EvidenceStore(root,{epochId:'new-writer',acceptEpoch:e=>e==='clean-first-writer'});
 assert.deepEqual(c.read('feedback',key),f);assert.equal(c.lessons.length,1);
 assert.equal(c.retrieve(birth.context,{source_epoch:'new-writer',opportunity_id:'next',birth_cutoff:new Date(at).toISOString()}).lessons.length,1);
 assert.equal(c.retrieve(birth.context,{source_epoch:'foreign-v2',opportunity_id:'next',birth_cutoff:new Date(at).toISOString()}).lessons.length,0);
 assert.throws(()=>c.put('birth',['foreign-v2','X'],{identity:{...identity,source_epoch:'foreign-v2',opportunity_id:'X'},decision:{version:'META_BRAIN_V1'}}),/EPOCH_MISMATCH/);
});test('clean origin receipt proves initial writer membership even without an epoch-open index entry',t=>{
 const {cleanEpochMembership}=require('../lib/metaBrainResearch'),{sha}=require('../lib/researchStore');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ai-origin-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const body={contract:'ORAYAN_CLEAN_V3_EPOCH_1',destination:dir,epochId:'clean-origin',completedV2HistoryImported:false,oldAIOutputsImported:false,oldMetaLearningStateImported:false};
 const save=b=>fs.writeFileSync(path.join(dir,'migration-receipt.json'),JSON.stringify({...b,sha256:sha(JSON.stringify(b))}));save(body);
 const accepts=cleanEpochMembership({dir,get:(_table,key)=>key==='later-writer'});
 assert.equal(accepts('clean-origin'),true);assert.equal(accepts('later-writer'),true);assert.equal(accepts('old-v2'),false);
 save({...body,completedV2HistoryImported:true});assert.throws(()=>cleanEpochMembership({dir}),/RECEIPT_INVALID/);
 save({...body,destination:path.dirname(dir)});assert.throws(()=>cleanEpochMembership({dir}),/RECEIPT_INVALID/);
 save(body);const r=JSON.parse(fs.readFileSync(path.join(dir,'migration-receipt.json')));r.epochId='forged';fs.writeFileSync(path.join(dir,'migration-receipt.json'),JSON.stringify(r));
 assert.throws(()=>cleanEpochMembership({dir}),/RECEIPT_INVALID/);
});
