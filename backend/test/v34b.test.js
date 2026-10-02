'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),zlib=require('zlib');
const {Archive,HOUR_BYTES,MAX_BYTES}=require('../lib/v3Archive'),codec=require('../lib/v34bCodec');
const r=require('../lib/v34bResearch'),c=require('../lib/v3Trades'),{CaptureLedger,classify,HOUR}=require('../lib/v34bCapture');
const {ShadowJournal}=require('../lib/v3Shadow');
const at=Date.UTC(2026,9,2,12),m=60000;
const tmp=t=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'v34b-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;};
const raw=a=>a.list('v3').flatMap(f=>zlib.gunzipSync(fs.readFileSync(f.path)).toString().trim().split('\n').filter(Boolean).map(JSON.parse));
function trade(side='BUY'){
  const d=side==='BUY'?1:-1,g={entryPrice:100,invalidationPrice:100-d*.5,objectivePrice:100+d*5,tickSize:.01,qtyStep:.001,
    minOrderQty:.001,maxOrderQty:10000,minCostAdjustedRR:2,entryWindowMin:5,maxHoldMin:10,
    sizing:{riskUsdt:1,maxNotionalUsdt:10000},costs:{entryFeePct:.055,exitFeePct:.055,entrySlippageBps:3,stopSlippageBps:3,targetThroughBps:1,tickSize:.01}};
  return c.create({geometry:g,side,symbol:'TEST',decisionAt:at,episodeId:'E',candidateId:'C'},'T',at+1);
}
const noise={noise:{status:'AVAILABLE',atr1m:1,receivedAt:at-1,cutoff:at-m}};
const bar=(ts,open=100,high=101,low=99.8,close=100)=>({ts,open,high,low,close});
test('recovery never crosses trades or claims different-cursor or permanent skips are complete',t=>{
  const l=new CaptureLedger(tmp(t)),base={capturedAt:at,errorCode:'UNAVAILABLE',subsystem:'PATH',symbol:'S',completenessStatus:'RETRY_PENDING'};
  l.error({...base,tradeId:'A',retryCursor:{lastBarAt:1}});l.error({...base,tradeId:'B',retryCursor:{lastBarAt:1}});
  l.error({...base,errorCode:'V3_ARCHIVE_BUDGET_PAUSED',tradeId:'A',retryCursor:{lastBarAt:1},completenessStatus:'SKIPPED_PERMANENT'});
  l.recovered('PATH','S',at+1,{tradeId:'A',retryCursor:{lastBarAt:1}});
  let es=Object.values(l.state.errors);assert.equal(es.find(e=>e.tradeId==='B').recoveredAt,null);
  assert.equal(es.find(e=>e.errorCode==='V3_ARCHIVE_BUDGET_PAUSED').completenessStatus,'SKIPPED_PERMANENT');
  assert.equal(es.find(e=>e.tradeId==='A'&&e.errorCode==='UNAVAILABLE').recoveredAt,at+1);
  l.recovered('PATH','S',at+2,{tradeId:'B',retryCursor:{lastBarAt:2}});
  assert.equal(es.find(e=>e.tradeId==='B').recoveredAt,null);assert.equal(es.find(e=>e.tradeId==='B').completenessStatus,'RESUMED_PRIOR_CURSOR_COVERAGE_UNVERIFIED');
});
test('pre-repair validation cohort is preserved separately before clean holdout starts',t=>{
  const dir=tmp(t),old={startedAt:at,cohortId:'INITIAL_VALIDATION',validation:{},episodes:{E:{symbol:'S'}},admissions:{T:{status:'OPEN'}}};
  fs.writeFileSync(path.join(dir,'holdout-v34b.json'),JSON.stringify(old));
  const {Holdout}=require('../lib/v34bHoldout'),h=new Holdout(dir);
  assert.equal(h.state.startedAt,null);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,h.state.previousCohorts[0].preservedFile))),old);
  h.start(require('../lib/v34Control'),'same-config',at+1);
  assert.equal(h.state.startedAt,at+1);assert.deepEqual(h.state.admissions,{});
  assert.equal(new Holdout(dir).state.startedAt,at+1);
});
test('exact sparse delta reconstruction preserves nested deletions arrays unicode and restart/hour closure',t=>{
  const dir=tmp(t),a=new Archive(dir),expected=[];
  for(let i=0;i<8;i++){
    const row={symbol:'DELTA',capturedAt:at+i,outputType:'V3_SURFACE_EXPOSURE',nested:{same:Array(100).fill('🙂 immutable'),
      price:.000000123456789+i*.0000000001,items:i%2?[1,2,3]:[1,2],...(i%2?{}:{removed:true})},clock:i};
    expected.push(row);a.write([{channel:'v3',row}]);
  }
  assert.ok(raw(a).some(r=>r.$v34bRecord?.delta?.changes.length));
  const decoded=codec.decode(raw(a));for(let i=0;i<expected.length;i++){
    const {captureSchema,archiveChannel,priorityClass,captureGeneration,exposureCount,...body}=decoded[i];assert.deepEqual(body,expected[i]);
  }
  const b=new Archive(dir);b.write([{channel:'v3',row:{...expected.at(-1),capturedAt:at+9}}]);
  assert.equal(codec.decode(raw(b)).length,9);
  b.write([{channel:'v3',row:{...expected.at(-1),capturedAt:at+HOUR}}]);
  const next=b.list('v3').filter(f=>f.hour.endsWith('-13')).flatMap(f=>zlib.gunzipSync(fs.readFileSync(f.path)).toString().trim().split('\n').map(JSON.parse));
  assert.equal(codec.decode(next)[0].nested.price,expected.at(-1).nested.price);
  const damaged=raw(a).map(r=>r.$v34bRecord?.delta?{...r,$v34bRecord:{...r.$v34bRecord,delta:{...r.$v34bRecord.delta,changes:[[['clock'],999]]}}}:r);
  assert.throws(()=>codec.decode(damaged),/HASH_MISMATCH/);
});
test('large causal priority delta changes remain bounded and reconstruct every field',t=>{
  const a=new Archive(tmp(t),{hourBytes:1,maxBytes:1}),rows=[];
  for(let i=0;i<2;i++){
    const row={symbol:'BIG',capturedAt:at+i,outputType:'ADMISSION',v3Decision:'ACCEPT_SHADOW',
      levels:Array.from({length:1000},(_,n)=>({id:n,price:n+i+.123456789,knownAt:at+i}))};
    rows.push(row);a.write([{channel:'v3',row}]);
  }
  const decoded=codec.decode(raw(a));for(let i=0;i<2;i++)assert.deepEqual(decoded[i].levels,rows[i].levels);
  assert.equal(a.ledger.status(at).currentPrioritySkips,0);
  assert.ok(raw(a).filter(r=>r.outputType!=='V3_IMMUTABLE_PAYLOAD').every(r=>Buffer.byteLength(JSON.stringify(r))<8192));
});
test('exact offered row and byte math, priority isolation, durable hourly counters across restart',t=>{
  const dir=tmp(t),a=new Archive(dir,{hourBytes:1000,maxBytes:5000});
  const small={capturedAt:at,outputType:'UPDATE',value:'small'},large={...small,value:require('crypto').randomBytes(2400).toString('hex')};
  a.write([{channel:'v3',row:small}]);assert.throws(()=>a.write([{channel:'v3',row:large}]),/BUDGET/);
  a.write([{channel:'paths',row:{...large,outputType:'FILLED_PATH'}}]);
  const b=new Archive(dir),v=b.ledger.status(at).totals;
  for(const x of v){assert.equal(x.attemptedRows,x.acceptedRows+x.skippedRows);assert.equal(x.attemptedBytes,x.acceptedBytes+x.skippedBytes);}
  const s=v.find(x=>x.channel==='v3');assert.equal(s.skippedRows,1);assert.equal(s.skippedBytes,Buffer.byteLength(JSON.stringify(large)+'\n'));
  assert.equal(v.find(x=>x.channel==='paths').skippedRows,0);assert.ok(b.total()>0);
});
test('priority admission batch and counters cannot be starved by standard quota',t=>{
  const a=new Archive(tmp(t),{hourBytes:1,maxBytes:1});
  a.write([{channel:'v3',row:{capturedAt:at,outputType:'ADMISSION',v3Decision:'ACCEPT_SHADOW'}},{channel:'v2',row:{capturedAt:at,outputType:'MATCH'}}]);
  a.write([{channel:'errors',row:{capturedAt:at,outputType:'ERROR'}}]);
  assert.equal(a.ledger.status(at).totals.reduce((n,b)=>n+b.skippedRows,0),0);assert.ok(a.status().priorityOverflowBytes>0);
});
test('lossless references preserve all prices floats provenance paths and repeated exposure',t=>{
  const a=new Archive(tmp(t)),x={capturedAt:at,outputType:'TEST',measurement34:{breadth:{universe:Array.from({length:80},(_,i)=>'SYMBOL'+i)},
    noise:{returns20:Array(20).fill(.12345678912345)},ratio:1.1234567891234567},research:{levels:Array(12).fill({id:'L',knownAt:1,invalidationPrice:.0000123456789})}};
  for(let i=0;i<4;i++)a.write([{channel:'v3',row:{...x,capturedAt:at+i}}]);
  const decoded=codec.decode(raw(a));assert.equal(decoded.length,4);
  for(let i=0;i<4;i++){const {archiveChannel,priorityClass,captureGeneration,exposureCount,captureSchema,...body}=decoded[i];assert.deepEqual(body,{...x,capturedAt:at+i});assert.equal(exposureCount,1);}
  assert.equal(raw(a).filter(x=>x.outputType==='V3_IMMUTABLE_PAYLOAD').length,codec.encode(x).definitions.length);
  assert.throws(()=>codec.decode([{x:{$v34bRef:'missing'}}]),/UNRESOLVED/);
});
test('one generation freezes every channel and cursor under subsequent writes',t=>{
  const a=new Archive(tmp(t));for(const channel of ['v3','v2','ai','trades','paths','errors','arms'])a.write([{channel,row:{capturedAt:at,outputType:'TEST'}}]);
  const s=a.cohort(at+1),bytes=Object.fromEntries(Object.entries(s.channels).map(([k,v])=>[k,Buffer.concat(v.files.map(f=>fs.readFileSync(f.path))).toString('base64')]));
  for(const channel of Object.keys(s.channels)){assert.equal(s.cursors[channel],1);a.write([{channel,row:{capturedAt:at+2,outputType:'TEST'}}]);
    assert.equal(Buffer.concat(s.channels[channel].files.map(f=>fs.readFileSync(f.path))).toString('base64'),bytes[channel]);}
  a.cohort(at+11*m);assert.equal(a.sessions.has(s.generation),false);
});
test('immutable daily snapshots survive rolling prune and verify every block hash',t=>{
  const a=new Archive(tmp(t));a.write([{channel:'v3',row:{capturedAt:at,outputType:'TEST',kind:'candidate_birth',research:{values:Array(100).fill(.123456789)}}}]);
  a.prune(at+40*HOUR);assert.equal(a.list('v3').length,0);const d=a.dailyList()[0];assert.equal(d.day,'2026-10-02');
  for(const f of d.files){const bytes=fs.readFileSync(path.join(a.dir,'daily-snapshots',d.day,f.name));assert.equal(require('crypto').createHash('sha256').update(bytes).digest('hex'),f.sha256);assert.doesNotThrow(()=>zlib.gunzipSync(bytes));}
});
test('30 complete clean hours required; dirty receipt coverage and priority skip reset streak',t=>{
  const l=new CaptureLedger(tmp(t));l.state.startedAt=at;l.state.lastEvaluatedHour=null;
  for(let n=0;n<=30*60;n++){l.receiptPulse(at+n*m,true);if(n===29*60)assert.equal(l.state.cleanHours,29);}
  assert.equal(l.state.cleanHours,30);assert.equal(l.state.trailingActivatedAt,at+30*HOUR);
  l.receiptPulse(at+30*HOUR+m,false);l.receiptPulse(at+31*HOUR,true);assert.equal(l.state.cleanHours,0);
});
test('FIRST_ADMISSION_ONLY consumes cancellation/no-fill; FIRST_FILLED_ONLY allows retries until actual fill',()=>{
  const t=trade(),first=r.admit(t,noise,{},false),repeat=r.admit(t,noise,{admissions:1,firstFillAt:null},false);
  assert.equal(first.arms.FIRST_ADMISSION_ONLY.status,'PAIRED_CONTROL');assert.equal(repeat.arms.FIRST_ADMISSION_ONLY.status,'SUPPRESSED');
  assert.equal(repeat.arms.FIRST_FILLED_ONLY.status,'PAIRED_CONTROL');
  const filled=r.admit(t,noise,{admissions:2,firstFillAt:at+m},false);assert.equal(filled.arms.FIRST_FILLED_ONLY.status,'SUPPRESSED');
  assert.equal(filled.arms.FIRST_FILLED_ONLY.opportunityNetCash,0);
  const cancelled=c.step(t,[bar(at+m,105,106,104,105)],at+2*m).trade;
  const result=r.advance(first,cancelled,[],at+2*m);assert.equal(result.arms.FIRST_ADMISSION_ONLY.opportunityNetCash,0);
});
test('ATR buffer requires exact causal ATR and sub-one-ATR stop, rechecks costs/RR and flags relaxed structure',()=>{
  const t=trade();assert.equal(r.admit(t,noise).arms.ATR1M_BUFFER.STRUCTURE_RELAXED,true);
  assert.equal(r.admit(t,{noise:{...noise.noise,receivedAt:at+1}}).arms.ATR1M_BUFFER.status,'INELIGIBLE');
  const wide=trade();wide.geometry.invalidationPrice=98;assert.equal(r.admit(wide,noise).arms.ATR1M_BUFFER.status,'INELIGIBLE');
  const shortTarget=trade();shortTarget.geometry.objectivePrice=101;assert.equal(r.admit(shortTarget,noise).arms.ATR1M_BUFFER.status,'REJECTED_BY_BUFFER_GEOMETRY');
});
test('ATR paired both-side fills preserve equal cash risk with lot shortfall and never mutate control',()=>{
  for(const side of ['BUY','SELL']){
    const t=trade(side),before=JSON.stringify(t),bs=[bar(at+m,100,100.2,99.8)],control=c.step(t,bs,at+2*m).trade;
    const a=r.advance(r.admit(t,noise),control,bs,at+2*m).arms.ATR1M_BUFFER.trade;
    assert.equal(JSON.stringify(t),before);assert.equal(a.entryPrice,control.entryPrice);
    assert.ok(a.plannedRiskUsdt<=control.plannedRiskUsdt+1e-12);assert.ok(control.plannedRiskUsdt-a.plannedRiskUsdt<a.geometry.qtyStep*a.fillEconomics.lossPerUnit+1e-12);
    assert.ok(a.quantity<control.quantity);assert.equal(a.geometry.objectivePrice,control.geometry.objectivePrice);
  }
});
test('buffer next-open gap rejects by geometry; adverse stop gap and full funding cash settle',()=>{
  const t=trade(),bs=[bar(at+m,100,100.2,99.8),bar(at+2*m,98,98.2,97.8,98)];
  const ctl=c.step(t,bs,at+3*m).trade,a=r.advance(r.admit(t,noise),ctl,bs,at+3*m);
  assert.equal(a.arms.ATR1M_BUFFER.trade.outcome,'STOP_GAP');assert.ok(a.arms.ATR1M_BUFFER.trade.exitPrice<99);
  const funded=r.funding(a,[{fundingRateTimestamp:at+m,fundingRate:.001}],at+5*m).arms.ATR1M_BUFFER;
  assert.equal(funded.opportunityNetCash,funded.trade.netPnlBeforeFunding-funded.trade.fundingCost);
  const reject=r.advance(r.admit(t,noise),c.step(t,[bar(at+m,104,104.2,103.8,104)],at+2*m).trade,[bar(at+m,104,104.2,103.8,104)],at+2*m);
  assert.equal(reject.arms.ATR1M_BUFFER.status,'REJECTED_BY_BUFFER_GEOMETRY');assert.equal(reject.arms.ATR1M_BUFFER.opportunityNetCash,0);
});
test('trailing is dormant, causal after-fill receipt only, next-minute action and never-widen for both sides',()=>{
  for(const side of ['BUY','SELL']){
    const t=trade(side),d=side==='BUY'?1:-1;assert.equal(r.admit(t,noise,{},false).arms.RECEIPT_DEFENDED_TRAILING.status,'DORMANT');
    const bs=[bar(at+m,100,100.2,99.8)],ctl=c.step(t,bs,at+2*m).trade;
    let arm=r.advance(r.admit(t,noise,{},true),ctl,bs,at+2*m);
    r.receive(arm,[{id:'future',invalidationPrice:100,knownAt:at+4*m,receivedAt:at+3*m},{id:'before',invalidationPrice:100,knownAt:at,receivedAt:at+2*m}],ctl.filledAt);
    assert.equal(arm.arms.RECEIPT_DEFENDED_TRAILING.receipts.length,0);
    r.receive(arm,[{id:'new',invalidationPrice:100-d*.2,knownAt:at+2*m,receivedAt:at+2*m+1}],ctl.filledAt);
    arm=r.advance(arm,ctl,[bar(at+2*m,100,100.1,99.9)],at+3*m);assert.equal(arm.arms.RECEIPT_DEFENDED_TRAILING.moves.length,0);
    arm=r.advance(arm,ctl,[bar(at+3*m,100,100.1,99.9)],at+4*m);const a=arm.arms.RECEIPT_DEFENDED_TRAILING;
    assert.equal(a.moves.length,1);assert.equal(a.moves[0].appliedAt,at+3*m);assert.ok(d*(a.moves[0].newStop-a.moves[0].oldStop)>0);
    r.receive(arm,[{id:'widen',invalidationPrice:100-d*2,knownAt:at+3*m,receivedAt:at+3*m+1}],ctl.filledAt);
    arm=r.advance(arm,ctl,[bar(at+4*m,100,100.1,99.9)],at+5*m);assert.equal(arm.arms.RECEIPT_DEFENDED_TRAILING.moves.length,1);
    assert.equal(ctl.geometry.invalidationPrice,t.geometry.invalidationPrice);
  }
});
test('error taxonomy redacts context, exposes retry recovery and preserves historical counters',t=>{
  assert.equal(classify(Object.assign(Error('secret'),{name:'AbortError'})),'ABORTED');assert.equal(classify(Object.assign(Error('secret'),{status:429})),'RATE_LIMIT');
  assert.equal(classify(Object.assign(Error('secret'),{name:'TimeoutError'})),'TIMEOUT');assert.equal(classify(Error('COMPACT_ROW_TOO_LARGE')),'OVERSIZE');
  const j=new ShadowJournal(tmp(t));j.captureError(Object.assign(Error('Bearer SECRET'),{name:'AbortError'}),{symbol:'S',tradeId:'T',subsystem:'PATH',retryCursor:{lastBarAt:at}});
  j.archive.ledger.recovered('PATH','S',at,{tradeId:'T',retryCursor:{lastBarAt:at}});assert.equal(Object.values(j.archive.ledger.state.errors)[0].recoveredAt,at);
  assert.equal(JSON.stringify(j.summary()).includes('SECRET'),false);assert.equal(j.counts.errors,1);
});
test('shared export routes and UI freeze/daily/arms downloads exist and JavaScript parses',()=>{
  require('child_process').execFileSync(process.execPath,['--check',path.resolve(__dirname,'../../frontend/app.js')]);
  const routes=fs.readFileSync(path.resolve(__dirname,'../routes/api.js'),'utf8');for(const route of ['/api/v3/cohort','/api/v3/daily'])assert.ok(routes.includes(route));
  const html=fs.readFileSync(path.resolve(__dirname,'../../frontend/index.html'),'utf8');for(const id of ['v35Holdout','v35Capture','v35Arms','btnV3Freeze','btnV3Daily','btnExportV3Arms'])assert.ok(html.includes('id="'+id+'"'));
  assert.equal(MAX_BYTES,335544320);assert.equal(HOUR_BYTES,8388608);assert.ok(31*HOUR_BYTES<MAX_BYTES);
});
test('durable redo repairs partially renamed channels and reconciles interrupted offered records',t=>{
  const dir=tmp(t),a=new Archive(dir),entry={channel:'v3',row:{capturedAt:at,outputType:'INTERRUPTED'}};
  a.ledger.account([entry],'attempted','STANDARD');
  const b=new Archive(dir),counter=b.ledger.status(at).totals[0];assert.equal(counter.skippedRows,1);assert.equal(counter.interruptedUncommittedRows,1);
  const name='v2-2026-10-02-12-00000.jsonl.gz',state=JSON.parse(JSON.stringify(b.ledger.state));
  fs.writeFileSync(path.join(dir,name+'.tmp'),zlib.gzipSync(JSON.stringify({capturedAt:at,outputType:'RECOVERED'})+'\n'));
  fs.writeFileSync(path.join(dir,'archive-transaction.json'),JSON.stringify({names:[name],ledger:state,hours:[]}));
  const recovered=new Archive(dir);assert.equal(recovered.list('v2').length,1);assert.equal(fs.existsSync(path.join(dir,'archive-transaction.json')),false);
});
test('surviving research arm worker restores separately and never consumes control capacity',t=>{
  const dir=tmp(t),j=new ShadowJournal(dir),t0=trade();t0.research35=r.admit(t0,noise,{},false);
  t0.status='CANCELLED';j.armWorkers.set(t0.tradeId,t0);j.saveCheckpoint();
  const restored=new ShadowJournal(dir);assert.equal(restored.activeTrades.size,0);assert.equal(restored.armWorkers.size,1);
  assert.deepEqual(restored.armWorkers.get(t0.tradeId).research35,t0.research35);
  assert.equal(restored.status().executionAllowed,false);
});
test('cached quote age and missing reason never claim an exact historical fill quote',()=>{
  const t=trade();t.geometry.reactionLevel={id:'R',zoneHigh:100,zoneLow:100};
  const m34=require('../lib/v34Trades');t.research34=m34.init(t,noise);
  const bs=[bar(at+m,100,100.1,99.9)];
  const out=m34.step(t,bs,at+2*m,{quoteAt:()=>({bid:99.99,ask:100.01,receivedAt:at+m-30000})}).trade.research34.fill;
  assert.equal(out.quote.semantic,'CACHED_PRE_FILL_QUOTE');assert.equal(out.quote.ageMs,30000);assert.equal(out.fillBidAskAvailable,false);
  const missing=m34.step(t,bs,at+2*m,{quoteAt:()=>null}).trade.research34.fill;
  assert.equal(missing.quote.semantic,'MISSING_FILL_QUOTE');assert.equal(missing.quote.missingReason,'NO_CAUSAL_QUOTE_RECEIPT');
});
test('funding only settles a research arm when the fetched window covers its own terminal time',()=>{
  const t=trade(),bs=[bar(at+m,100,100.2,99.8),bar(at+2*m,98,98.2,97.8,98)];
  const a=r.advance(r.admit(t,noise),c.step(t,bs,at+3*m).trade,bs,at+3*m);
  assert.equal(r.funding(a,[],at+5*m,at+m).arms.ATR1M_BUFFER.trade.fundingStatus,'PENDING');
  assert.equal(r.funding(a,[],at+5*m,at+2*m).arms.ATR1M_BUFFER.trade.fundingStatus,'SETTLED_RATE_MODELLED');
});
test('large path arrays and Unicode payloads reconstruct losslessly within bounded reference blocks',()=>{
  const input={capturedAt:at,bars:Array.from({length:1000},(_,i)=>({ts:at+i*m,open:100,high:101,low:99,close:100,receivedAt:at+i*m+1})),
    output:{rationale:'😀'.repeat(40000)}};
  const encoded=codec.encode(input);for(const d of encoded.definitions)assert.ok(Buffer.byteLength(JSON.stringify(d)+'\n')<=65536);
  const decoded=codec.decode([...encoded.definitions,encoded.row])[0];delete decoded.captureSchema;assert.deepEqual(decoded,input);
});
