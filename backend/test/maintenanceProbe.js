'use strict';
// Fresh process, isolated native/canonical storage. All market input is local.
const fs=require('fs'), path=require('path'), assert=require('node:assert/strict');
const [mode,root,arg]=process.argv.slice(2);
fs.mkdirSync(root,{recursive:true});
const store=require('../lib/store');store.DATA_DIR=root;
store.read=(name,dflt)=>{const file=path.join(root,name+'.json');return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):dflt;};
store.write=(name,value)=>{fs.writeFileSync(path.join(root,name+'.json'),JSON.stringify(value));return true;};
const minimal=require('../lib/minimalCapture');minimal.enabled=()=>true;minimal.researchEnabled=()=>true;
const runtime=require('../lib/researchRuntime');runtime.prepare();
if(mode==='flag'&&arg!=='ABSENT')fs.writeFileSync(path.join(root,'maintenance-control.json'),arg);
const c=runtime.current();minimal.current=()=>c;
global.fetch=()=>{throw Error('FORBIDDEN_NETWORK');};
async function main() {
  if(mode==='flag') {
    const m=require('../lib/maintenance').current();
    const before={state:m.state,fenced:m.fenced(),reason:m.reason};
    if(arg==='ABSENT')assert.deepEqual(before,{state:'RUNNING',fenced:false,reason:null});
    else { assert.equal(before.state,'FAILED');assert.equal(before.fenced,true); }
    const pending=m.enter({retry:true});assert.equal(m.fenced(),true);
    assert.throws(()=>m.assertStart('research'),/MAINTENANCE_FENCED/);
    const sealed=await pending;assert.equal(sealed.snapshotSafe,true);
    return {before,after:sealed.state,snapshotSafe:sealed.snapshotSafe};
  }
  if(mode==='stats') {
    const trade={id:'N',signalId:'NS',symbol:'TESTUSDT',side:'BUY',mode:'paper',status:'OPEN',createdAt:Date.now()-120000,
      filledAt:Date.now()-60000,fillPrice:100,plannedEntry:100,qty:1,sl:98,tp:104};
    store.write('trades',[trade]);store.write('symbolStats',{});
    const settings=require('../lib/settings');const frozen={...settings.effective(),mode:'paper',gateSymbolExpectancyEnabled:false};
    settings.effective=()=>frozen;
    const market=require('../lib/marketData');market.getCandles=async()=>[{ts:Date.now(),open:100,high:101,low:97,close:98}];
    require('../lib/v3Shadow').refreshManagementContext=async()=>{};
    const stats=require('../lib/symbolStats'), engine=require('../lib/engine'), m=require('../lib/maintenance').current();
    const research=await m.enter();assert.equal(research.fullSealed,false);
    await engine.scanOnce();
    assert.equal(engine.getTrades({limit:Infinity})[0].status,'CLOSED');
    assert.equal(stats.maintenanceStatus().pending,true);
    assert.equal(stats.snapshot()[0].trades,1);
    let injection,original;
    if(arg==='write'||arg==='fsync') {
      injection=arg==='write'?'writeFileSync':'fsyncSync';original=fs[injection];
      fs[injection]=(...args)=>{
        const fd=args[0];let file='';
        // Failure is restricted to the real symbolStats temp-file operation.
        if(typeof fd==='number')file=opened.get(fd)||'';
        if(file.endsWith('symbolStats.json.tmp'))throw Error('INJECTED_'+arg.toUpperCase());
        return original(...args);
      };
    }
    const sealed=await m.fullSeal({timeoutMs:3000});
    if(injection) {
      fs[injection]=original;
      assert.equal(sealed.snapshotSafe,false);assert.equal(sealed.state,'FAILED');assert.equal(m.fenced(),true);
      assert.match(sealed.reason,/SYMBOL_STATS_CHECKPOINT_FAILED:INJECTED_/);
      assert.equal(stats.maintenanceStatus().dirty,true);
      const retry=await m.enter({retry:true});assert.equal(retry.snapshotSafe,true);
      return {failure:sealed.reason,snapshotSafe:sealed.snapshotSafe,retry:retry.snapshotSafe};
    }
    assert.equal(sealed.snapshotSafe,true);assert.equal(stats.maintenanceStatus().pending,false);
    const before=fs.readFileSync(path.join(root,'symbolStats.json'),'utf8');
    assert.equal(JSON.parse(before).TESTUSDT.results.length,1);
    await new Promise(r=>setTimeout(r,2200));
    assert.equal(fs.readFileSync(path.join(root,'symbolStats.json'),'utf8'),before);
    assert.equal(m.status().snapshotSafe,true);
    stats.recordClose({symbol:'LATEUSDT',netPnl:1},frozen);
    assert.equal(m.status().snapshotSafe,false);
    stats.maintenanceCheckpoint();
    assert.equal(m.status().snapshotSafe,false); // A consumed late writer cannot silently restore the old boundary.
    return {closed:'CLOSED',durable:true,changedAfterDelay:false,lateWriterSafe:m.status().snapshotSafe};
  }
  if(mode==='provider-seed') {
    const provider=arg.startsWith('groq')?'Groq':'Alibaba';
    c.emit('decisions',{sourceEpisodeId:'EP',boundary:'BIRTH'});
    c.emit('decisions',{sourceEpisodeId:'EP',boundary:'ADMISSION_ATTEMPT',admission:'REJECT'});
    const started={record_type:'REQUEST_STARTED',request_id:'ORPHAN',candidate_id:'X',candidate_episode_id:'EP',model:'test',
      requested_at_utc:new Date().toISOString(),estimated_tokens_reserved:250,estimated_cost_usd_reserved:.003};
    c.emit('ai_calls',{provider,event:'PROVIDER_LEDGER',ledgerRecord:started,sourceEpisodeId:'EP',at:Date.now()});
    if(arg.endsWith('terminal')) {
      const crypto=require('../lib/researchStore');
      const evaluationId=crypto.sha(JSON.stringify([provider,'EP','ORPHAN']));
      c.emit('ai_calls',{provider,event:'REQUEST_PREPARED',attemptId:'A',evaluationId,sourceEpisodeId:'EP'});
      c.emit('ai_calls',{provider,event:'PARSED_RESPONSE',attemptId:'A',evaluationId,sourceEpisodeId:'EP',tokens:{total:100}});
    }
    c.flush();
    // Model a process interruption while maintenance entry was active.
    store.write('maintenance-control',{maintenance:true,state:'ENTERING',maintenanceEpoch:require('crypto').randomUUID(),
      processBootId:require('../lib/runtimeIdentity').processBootId,sealedWatermark:null});
    return {seeded:true,aiAttempts:Object.keys(c.state.aiAttempts||{}).length};
  }
  if(mode==='provider') {
    const key=arg.startsWith('groq')?'groq':'alibaba', provider=key==='groq'?'Groq':'Alibaba';
    const producer=require('../lib/'+key+'ShadowProducer'), ledger=require('../../research/'+key+'-shadow/src/ledger');
    let calls=0;producer._test.setTransport(()=>{calls++;throw Error('TRANSPORT_FORBIDDEN');});
    const m=require('../lib/maintenance').current();
    assert.equal(m.fenced(),true);assert.equal(m.reason,'RESTART_REQUIRES_RESEAL');
    const sealed=await m.enter({retry:true,timeoutMs:3000});assert.equal(sealed.snapshotSafe,true);
    const before=c.status().sequence;
    for(let i=0;i<3;i++) {
      ledger._test.resetCaches(); // Exercise fresh reads, not just an already-warm index.
      await producer.status();
      assert.equal(c.status().sequence,before);assert.equal(m.status().snapshotSafe,true);
    }
    const cfg=producer.config();const index=await ledger.ledgerIndex(cfg.ledger,Date.now()+86400000,{canonical:require('../lib/researchAI').canonical(provider),readOnly:true});
    assert.equal(index.openRequests.size,0);assert.equal(c.status().sequence,before);
    const rows=[];await require('../lib/researchArchive').rows(c,r=>rows.push(r));
    const records=rows.filter(r=>r.provider===provider&&r.ledgerRecord).map(r=>r.ledgerRecord);
    assert.equal(records.filter(r=>r.record_type==='REQUEST_STARTED').length,1);
    assert.equal(records.filter(r=>r.status==='INTERRUPTED_UNKNOWN_OUTCOME').length,1);
    ledger._test.resetCaches();await producer.status();
    const today=await ledger.ledgerIndex(cfg.ledger,Date.now(),{canonical:require('../lib/researchAI').canonical(provider),readOnly:true});
    assert.equal(today.dayRequests,1);assert.equal(today.dayTokens,250);
    if(key==='alibaba')assert.equal(today.dayCostUsd,.003);
    assert.equal(calls,0);assert.equal(producer._test.getRuntime===undefined,false);
    return {state:sealed.state,snapshotSafe:true,stableSequence:before,starts:1,uncertain:1,requests:today.dayRequests,tokens:today.dayTokens,calls};
  }
  throw Error('UNKNOWN_MODE');
}
const opened=new Map(),originalOpen=fs.openSync;
fs.openSync=(file,...args)=>{const fd=originalOpen(file,...args);opened.set(fd,String(file));return fd;};
main().then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error);process.exitCode=1;});
