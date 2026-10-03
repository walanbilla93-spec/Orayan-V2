'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),zlib=require('zlib');
const {Archive}=require('../lib/v3Archive'),{CaptureLedger,HOUR,atomic,hourOf}=require('../lib/v34bCapture'),codec=require('../lib/v34bCodec');
const r=require('../lib/v34bResearch'),c=require('../lib/v3Trades'),g=require('../lib/v3Geometry'),control=require('../lib/v34Control'),{ShadowJournal}=require('../lib/v3Shadow');
const at=Date.UTC(2026,9,3,6),m=60000;
const tmp=t=>{const p=fs.mkdtempSync(path.join(os.tmpdir(),'capture-hardening-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;};
const entry=(channel='v3',capturedAt=at)=>({channel,row:{outputType:'VALIDATION',capturedAt,symbol:'S',candidateId:'C',scanId:'SCAN',holdoutCohort:'H',implementationHash:'HASH',payload:'🙂'}});
const noise={noise:{status:'AVAILABLE',definition:'ATR_SMA_TR14_RV_RMS_LOG_RETURN20_TR_MEAN20_V1',atr1m:1,cutoff:at-m,receivedAt:at-1}};
function trade(side='BUY',distance=.5,target=6){const d=side==='BUY'?1:-1;return c.create({side,symbol:'S',candidateId:'C',episodeId:'E',decisionAt:at,geometry:{entryPrice:100,invalidationPrice:100-d*distance,objectivePrice:100+d*target,
  tickSize:.01,qtyStep:.001,minOrderQty:.001,maxOrderQty:10000,minCostAdjustedRR:2,entryWindowMin:5,maxHoldMin:10,sizing:{riskUsdt:1,maxNotionalUsdt:10000},
  costs:{entryFeePct:.055,exitFeePct:.055,entrySlippageBps:3,stopSlippageBps:3,targetThroughBps:1,tickSize:.01}}},'T',at+1);}
const bar=(ts,open=100,high=100.2,low=99.8,close=100)=>({ts,open,high,low,close});
test('every required channel retains attempts across hourly and rolling alarms',t=>{const a=new Archive(tmp(t),{hourBytes:1,maxBytes:1});
  for(const ch of ['v3','v2','ai','trades','paths','errors','arms'])a.write([entry(ch)]);
  for(const b of a.ledger.status(at).totals){assert.equal(b.attemptedRows,b.acceptedRows);assert.equal(b.skippedRows,0);assert.equal(b.attemptedBytes,b.acceptedBytes);}
  assert.ok(a.ledger.state.envelopeExceedances);assert.equal(a.pausedUntil,null);
});
for(const stage of ['before-redo','after-redo'])test('durable exact replay after crash '+stage,t=>{
  const dir=tmp(t),a=new Archive(dir),e=entry(),original=stage==='before-redo'?fs.openSync:fs.renameSync;let injected=false;
  if(stage==='before-redo')fs.openSync=function(file,...args){if(String(file).endsWith('.jsonl.gz.tmp')&&!injected){injected=true;throw Object.assign(Error('STORAGE'),{code:'EIO'});}return original.call(fs,file,...args);};
  else fs.renameSync=function(src,...args){if(String(src).endsWith('.jsonl.gz.tmp')&&!injected){injected=true;throw Object.assign(Error('STORAGE'),{code:'EIO'});}return original.call(fs,src,...args);};
  try{assert.throws(()=>a.write([e]),/STORAGE/);}finally{if(stage==='before-redo')fs.openSync=original;else fs.renameSync=original;}
  const b=new Archive(dir),s=b.ledger.status(at).totals;assert.equal(s.reduce((n,x)=>n+x.attemptedRows,0),1);assert.equal(s.reduce((n,x)=>n+x.acceptedRows,0),1);assert.equal(s.reduce((n,x)=>n+x.skippedRows,0),0);
  assert.equal(fs.existsSync(path.join(dir,'capture-pending.json')),false);const rows=codec.decode(b.list('v3').flatMap(f=>zlib.gunzipSync(fs.readFileSync(f.path)).toString().trim().split('\n').map(JSON.parse)));
  assert.equal(rows[0].payload,'🙂');assert.equal(rows.length,1);
});
test('irrecoverable validation failure has independent durable exact tombstone',t=>{const dir=tmp(t),a=new Archive(dir);const e=entry('ai');e.row.payload=require('crypto').randomBytes(5000).toString('hex');
  assert.throws(()=>a.write([e]),/COMPACT_ROW_TOO_LARGE/);a.prune(at+40*HOUR);const b=new Archive(dir),files=fs.readdirSync(b.ledger.tombstones);assert.equal(files.length,1);
  const tomb=JSON.parse(fs.readFileSync(path.join(b.ledger.tombstones,files[0])));assert.equal(tomb.attemptedBytes,Buffer.byteLength(JSON.stringify(e.row)+'\n'));assert.equal(tomb.candidateId,'C');assert.equal(tomb.scanId,'SCAN');assert.equal(tomb.recovered,false);assert.equal(tomb.permanentLoss,true);
});
test('hour boundary burst preserves independent exact rows bytes and physical allocation',t=>{const a=new Archive(tmp(t),{hourBytes:10,maxBytes:100});
  a.write([entry('v3',at+HOUR-1),entry('v2',at+HOUR-1),entry('v3',at+HOUR),entry('v2',at+HOUR)]);
  const bs=a.ledger.records();assert.equal(new Set(bs.map(x=>x.hour)).size,2);for(const b of bs){assert.equal(b.attemptedRows,b.acceptedRows+b.skippedRows);assert.equal(b.attemptedBytes,b.acceptedBytes+b.skippedBytes);assert.equal(Number.isInteger(b.physicalCompressedBytesWritten),true);assert.equal(b.writerImplementationHash,'HASH');assert.equal(b.cohortId,'H');assert.ok(b.reconciliationChecksum);}
  assert.equal(bs.reduce((n,b)=>n+b.physicalCompressedGrowthBytes,0),a.total());
});
test('historical residual and cohort baseline never rewrite ledger history',t=>{const l=new CaptureLedger(tmp(t));l.state.totals.old={attemptedRows:10,acceptedRows:3,skippedRows:7,attemptedBytes:100,acceptedBytes:30,skippedBytes:70};
  assert.equal(l.identity(86707).baselineSkippedRows,86700);l.beginCohort('NEW',at);assert.equal(l.status(at).skipCounters.currentHoldout,0);assert.equal(l.status(at).skipCounters.ledgerEra,7);assert.equal(l.identity(90000).baselineSkippedRows,86700);
});
test('full research hours require measurements and both priorities; partial cohort hour excluded',t=>{const l=new CaptureLedger(tmp(t));l.beginCohort('H',at+1);
  for(let i=0;i<=120;i++){const now=at+i*m;l.measurement(now,true);l.receiptPulse(now,true);}assert.equal(l.state.completedHours.fullResearch,1);
  l.measurement(at+2*HOUR,false);for(let i=121;i<=180;i++)l.receiptPulse(at+i*m,true);assert.equal(l.state.completedHours.priority,2);assert.equal(l.state.completedHours.standard,2);assert.equal(l.state.completedHours.fullResearch,0);
  assert.equal(l.status(at+3*HOUR).analyticallyClean,false);
});
test('standard permanent skip cannot produce full clean hour even with priority complete',t=>{const l=new CaptureLedger(tmp(t));l.beginCohort('H',at);
  for(let i=0;i<60;i++){l.measurement(at+i*m,true);l.receiptPulse(at+i*m,true);}l.account([entry()],'attempted','STANDARD');l.account([entry()],'skipped','STANDARD');l.receiptPulse(at+HOUR,true);
  assert.equal(l.state.completedHours.priority,1);assert.equal(l.state.completedHours.standard,0);assert.equal(l.state.completedHours.fullResearch,0);
});
test('shared raw manifests summary and dedicated ledger export freeze exact actual ledgers',async t=>{const j=new ShadowJournal(tmp(t));j.append('v3',entry().row);const s=await j.cohort();j.append('v3',{...entry().row,capturedAt:at+1});
  const e=j.export('ledger',s.generation),rows=zlib.gunzipSync(Buffer.concat(e.files.map(f=>fs.readFileSync(f.path)))).toString().trim().split('\n').map(JSON.parse);assert.equal(rows[1].attemptedRows,1);assert.equal(rows[1].acceptedRows,1);assert.equal(rows[0].generation,s.generation);
  for(const channel of ['v3','v2','ai','trades','paths','errors','arms']){const e=j.export(channel,s.generation),manifest=JSON.parse(zlib.gunzipSync(fs.readFileSync(e.files[0].path)).toString());assert.deepEqual(manifest.captureLedger,s.captureLedger);assert.ok(manifest.reconciliation.rowsReconciled);}
});
test('frozen control fingerprint and disabled execution remain exact',()=>{assert.equal(control.fingerprint,'9fb7a1e55834dd57f0d0c194dce76178e6a132d3e4fa39bcdc74f627193ad928');assert.equal(control.executionAllowed,false);assert.equal(r.DEFINITIONS.executionAllowed,false);assert.ok(r.DEFINITIONS.ATR1M_1P5_REPLACEMENT.includes('no 2R cap'));});
for(const side of ['BUY','SELL'])for(const distance of [.5,3])test('replacement tightens or widens with original objective and equal risk '+side+' '+distance,()=>{
  const t=trade(side,distance,10),original=JSON.stringify(t),a=r.admit(t,noise),d=side==='BUY'?1:-1;
  assert.equal(a.arms.ATR1M_1P5_REPLACEMENT.decisionProvisionalStop,100-d*1.5);assert.equal(a.arms.ATR1M_1P5_REPLACEMENT.trade.geometry.objectivePrice,t.geometry.objectivePrice);
  const bars=[bar(at+m)],ctl=c.step(t,bars,at+2*m).trade,out=r.advance(a,ctl,bars,at+2*m).arms.ATR1M_1P5_REPLACEMENT;
  assert.equal(out.trade.filledAt,at+m);assert.ok(out.trade.plannedRiskUsdt<=ctl.plannedRiskUsdt+1e-12);assert.equal(out.fillAdjustedActualStop,g.round(out.trade.entryPrice-d*1.5,.01,d!==1));assert.equal(JSON.stringify(t),original);assert.equal(out.matchedFillSubset,true);
});
test('replacement requires positive causal ATR and rejects bad decision and fill geometry',()=>{const t=trade();for(const n of [{...noise.noise,atr1m:0},{...noise.noise,receivedAt:at+1},{...noise.noise,cutoff:at+1}])assert.equal(r.admit(t,{noise:n}).arms.ATR1M_1P5_REPLACEMENT.status,'INELIGIBLE');
  assert.equal(r.admit(trade('BUY',.5,1),noise).arms.ATR1M_1P5_REPLACEMENT.decisionGeometryRejected,true);
  const a=r.admit(t,noise),bs=[bar(at+m,105,105.1,104.9,105)];assert.equal(r.advance(a,c.step(t,bs,at+2*m).trade,bs,at+2*m).arms.ATR1M_1P5_REPLACEMENT.fillGeometryRejected,true);
});
test('replacement path continues after control stop and funding stays censored until own horizon',()=>{const t=trade(),bs=[bar(at+m,100,100.2,99.2)],ctl=c.step(t,bs,at+2*m).trade;
  let a=r.advance(r.admit(t,noise),ctl,bs,at+2*m);assert.equal(ctl.status,'CLOSED');assert.equal(a.arms.ATR1M_1P5_REPLACEMENT.trade.status,'OPEN');assert.equal(r.active(a),true);
  a=r.advance(a,ctl,[bar(at+2*m,100,107,99.8,106)],at+3*m);assert.equal(a.arms.ATR1M_1P5_REPLACEMENT.outcome,'TARGET');assert.equal(a.arms.ATR1M_1P5_REPLACEMENT.opportunityNetCash,null);
  assert.equal(r.funding(a,[],at+5*m,at+m).arms.ATR1M_1P5_REPLACEMENT.complete,false);assert.equal(r.funding(a,[],at+5*m,at+3*m).arms.ATR1M_1P5_REPLACEMENT.complete,true);
});
test('replacement missing minute is censored and stop-first ambiguity matches frozen simulator',()=>{const t=trade();let a=r.advance(r.admit(t,noise),t,[bar(at+2*m)],at+3*m);assert.equal(a.arms.ATR1M_1P5_REPLACEMENT.trade.status,'DATA_GAP');assert.equal(a.arms.ATR1M_1P5_REPLACEMENT.opportunityNetCash,null);
  const bs=[bar(at+m,100,107,98,100)];a=r.advance(r.admit(t,noise),c.step(t,bs,at+2*m).trade,bs,at+2*m);assert.equal(a.arms.ATR1M_1P5_REPLACEMENT.outcome,'STOP_AMBIGUOUS');
});
test('replacement obeys lot quantity and notional caps while buffer remains independent',()=>{const t=trade();t.geometry.maxOrderQty=.2;t.geometry.sizing.maxNotionalUsdt=10;const a=r.admit(t,noise),bs=[bar(at+m)],ctl=c.step(t,bs,at+2*m).trade,out=r.advance(a,ctl,bs,at+2*m);
  const arm=out.arms.ATR1M_1P5_REPLACEMENT.trade;assert.ok(arm.quantity<=.2);assert.ok(arm.quantity*arm.entryPrice<=10);assert.ok(arm.plannedRiskUsdt<=ctl.plannedRiskUsdt+1e-12);
  assert.notEqual(a.arms.ATR1M_BUFFER.trade.geometry.invalidationPrice,a.arms.ATR1M_1P5_REPLACEMENT.trade.geometry.invalidationPrice);
});
test('observer presence does not mean usable provider result and ATR availability is explicit',()=>{const measurements=require('../lib/v34Measurements');const x=measurements.observer({status:'API_400_SCHEMA',completed_at_utc:at-1,available_to_system_at_utc:at-1,requested_at_utc:at-2},'Groq',at-1,at);assert.equal(x.presentAtDecision,true);assert.equal(x.usableAtDecision,false);
  const n=measurements.decision({decisionAt:at,symbol:'S',geometry:{},research:{}},{}).noise;assert.equal(n.positiveAtr,false);assert.equal(n.cachedAtDecision,false);assert.equal(n.status,'INSUFFICIENT_PRIOR_MINUTES');assert.equal(n.availabilityReason,'CACHE_RECEIPT_UNAVAILABLE');
});
test('new full-geometry opportunity cannot consume frozen control slots or first-admission ordinal',t=>{
  const j=new ShadowJournal(tmp(t));j.holdout.state.startedAt=at;j.holdout.state.cohortId='H';const tr=trade('BUY',3,6);
  const row={...tr,geometry:{...tr.geometry,status:'REJECTED',reason:'COST_ADJUSTED_RR_TOO_LOW'},configHash:'CONFIG',v2Decision:[],v3Decision:'REJECT',
    rejectReason:'COST_ADJUSTED_RR_TOO_LOW',regime:'BULL_TREND',directionPermission:true,closedBarOpenAt:at-15*m,research:{levels:[]},
    measurement34:{...noise,quote:{status:'AVAILABLE'},observers:{}}};
  j.record(row,'SCAN',at,at+2);assert.equal(j.activeTrades.size,0);assert.equal(j.tradeCounts.admitted,0);assert.equal(j.armWorkers.size,1);
  const e=Object.values(j.holdout.state.episodes)[0];assert.equal(e.admissions,0);assert.equal(e.replacementGeometryOpportunities,1);
  assert.equal(r.admit(tr,noise,e).arms.FIRST_ADMISSION_ONLY.status,'PAIRED_CONTROL');
  assert.equal([...j.armWorkers.values()][0].research35.arms.ATR1M_1P5_REPLACEMENT.newlyAdmittedOpportunity,true);
});
test('known Groq generated length violation is distinct from unproven request schema failure',()=>{
  const x=require('../lib/v34Measurements').observer({status:'API_400_SCHEMA',api_error:{code:'json_validate_failed',message:"jsonschema: '/reason_notes/0' maxLength: got 97, want 96"}},'Groq',at,at);
  assert.equal(x.providerFailureKind,'GENERATED_OUTPUT_SCHEMA_VIOLATION');assert.deepEqual(x.schemaViolation,{code:'json_validate_failed',field:'reason_notes',observedLength:97,allowedLength:96});assert.equal(x.usableAtDecision,false);
});
test('new analytical cohort waits for live qualification and preserves contaminated evidence byte-for-byte',t=>{
  const dir=tmp(t),old={cohortId:'V34B_CLEAN_HOLDOUT_2026-10-03T03:10:43.114Z',startedAt:1790997043114,episodes:{E:{admissions:2}},admissions:{},validation:{captureRevision:'OLD'}};
  atomic(path.join(dir,'holdout-v34b.json'),old);const {Holdout}=require('../lib/v34bHoldout'),h=new Holdout(dir),start=h.state.notBeforeAt;
  h.start(control,'CONFIG',start);assert.equal(h.state.startedAt,null);assert.equal(h.state.previousCohorts.at(-1).status,'capture-incomplete/exploratory');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,h.state.previousCohorts.at(-1).preservedFile))),old);
  h.start(control,'CONFIG',start,{passed:true,repairCommit:'HASH',capturePolicy:'POLICY',ledgerBaseline:{attemptedRows:1}});assert.equal(h.state.qualification.repairCommit,'HASH');assert.deepEqual(h.state.episodes,{});
});
test('export enumeration yields to capture and freezes audit status before concurrent writes',async t=>{
  const j=new ShadowJournal(tmp(t));j.append('v3',entry().row);const pending=j.cohort();assert.equal(j.cohort(),pending);
  let completed=false;pending.then(()=>{completed=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(completed,false);
  j.append('v3',{...entry().row,capturedAt:at+1});const s=await pending;
  assert.equal(s.cursors.v3,1);assert.equal(s.status.counts.v3,1);assert.equal(s.retained.v3.logicalRows,1);
  assert.equal(s.captureLedger.reduce((n,b)=>n+b.acceptedRows,0),1);assert.equal(j.counts.v3,2);assert.ok(s.enumerationDurationMs>=0);
});
test('cached immutable export counts never survive a mutable-head replacement',async t=>{
  const a=new Archive(tmp(t));a.write([entry()]);const first=await a.cohort();assert.equal(first.retained.v3.logicalRows,1);
  const item=a.list('v3')[0];assert.ok(item.retainedStats);a.write([{channel:'v3',row:{...entry().row,capturedAt:at+1}}]);
  assert.notEqual(a.list('v3')[0],item);const second=await a.cohort();assert.equal(second.retained.v3.logicalRows,2);
});
test('no active analytical cohort cannot inherit legacy unassigned skips',t=>{
  const l=new CaptureLedger(tmp(t));l.account([entry()],'attempted','STANDARD');l.account([entry()],'skipped','STANDARD');
  assert.equal(l.status(at).skipCounters.ledgerEra,1);assert.equal(l.status(at).skipCounters.currentHoldout,null);
  assert.equal(l.status(at).skipCounters.currentHoldoutStatus,'NO_ACTIVE_ANALYTICAL_COHORT');
});
test('hourly ledgers partition writer hashes and disclose legacy unpartitioned attribution',t=>{
  const a=new Archive(tmp(t));a.write([entry()]);a.write([{channel:'v3',row:{...entry().row,implementationHash:'SECOND_HASH',capturedAt:at+1}}]);
  const rows=a.ledger.records();assert.equal(rows.length,2);assert.deepEqual(new Set(rows.map(b=>b.writerImplementationHash)),new Set(['HASH','SECOND_HASH']));
  const b=JSON.parse(fs.readFileSync(path.join(a.ledger.dir,hourOf(at)+'.json'))),first=Object.values(b)[0];delete first.writerImplementationHashScope;
  atomic(path.join(a.ledger.dir,hourOf(at)+'.json'),b);assert.equal(a.ledger.records()[0].writerImplementationHash,null);
  assert.ok(a.ledger.records()[0].legacyUnavailableFields.includes('writerImplementationHash'));
});
test('replacement fill after control next-open geometry rejection is a new full-geometry opportunity',()=>{
  const t=trade('BUY',3,8),bars=[bar(at+m,101.5,101.7,101.4,101.6)],ctl=c.step(t,bars,at+2*m).trade;
  assert.equal(ctl.status,'CANCELLED');assert.equal(ctl.outcome,'NEXT_OPEN_GEOMETRY_REJECTED');
  const a=r.advance(r.admit(t,noise),ctl,bars,at+2*m).arms.ATR1M_1P5_REPLACEMENT;
  assert.equal(a.fillStatus,'FILLED');assert.equal(a.newlyAdmittedOpportunity,true);assert.equal(a.fullGeometrySubset,true);assert.equal(a.matchedFillSubset,false);
});
