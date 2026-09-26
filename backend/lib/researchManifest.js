'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const store = require('./store');
const runtime = require('./runtimeIdentity');

const SOURCES = [
  ['research-events-v1', /^events-\d{4}-\d{2}-\d{2}-\d{2}\.jsonl$/],
  ['research-v2', /^(compact-\d{4}-\d{2}-\d{2}-\d{2}|births-\d{4}-\d{2}-\d{2}|outcomes-\d{4}-\d{2}-\d{2}|liquidations-\d{4}-\d{2}-\d{2}|coverage-\d{4}-\d{2}-\d{2})\.jsonl$/],
  ['research-supplement-v1', /^supplement-\d{4}-\d{2}-\d{2}-\d{2}\.jsonl$/],
  ['early-entry-shadow-v1', /^early-entry-\d{4}-\d{2}-\d{2}-\d{2}\.jsonl$/],
];

function plannedFiles() {
  const files=[];
  for (const [folder,pattern] of SOURCES) {
    const dir=path.join(store.DATA_DIR,folder);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter(name=>pattern.test(name)).sort()) {
      const file=path.join(dir,name),stat=fs.statSync(file);
      if (stat.isFile()) files.push({file,size:stat.size,relativePath:path.relative(store.DATA_DIR,file).replaceAll('\\','/')});
    }
  }
  return files;
}

async function inspectFile(plan) {
  const hash=crypto.createHash('sha256'),decoder=new StringDecoder('utf8');
  let carry='',rowCount=0,malformedRows=0,firstAt=null,lastAt=null;
  if (plan.size>0) for await (const chunk of fs.createReadStream(plan.file,{start:0,end:plan.size-1,highWaterMark:65536})) {
    hash.update(chunk);carry+=decoder.write(chunk);
    let end;
    while((end=carry.indexOf('\n'))>=0){const line=carry.slice(0,end);carry=carry.slice(end+1);visit(line);}
    if(carry.length>1048576)throw Error(`JSONL row exceeds 1 MB: ${plan.relativePath}`);
  }
  carry+=decoder.end();if(carry)visit(carry);
  function visit(line){if(!line)return;rowCount++;try{const row=JSON.parse(line),at=Number(row.at??row.observedAt??row.capturedAt);
    if(Number.isFinite(at)){if(firstAt===null||at<firstAt)firstAt=at;if(lastAt===null||at>lastAt)lastAt=at;}}
    catch(_){malformedRows++;}}
  return {path:plan.relativePath,bytes:plan.size,rowCount,malformedRows,firstAt,lastAt,
    sha256:hash.digest('hex')};
}

async function visitJsonLines(plan,visit) {
  if (!plan.size) return;
  const decoder=new StringDecoder('utf8');
  let carry='';
  for await (const chunk of fs.createReadStream(plan.file,{start:0,end:plan.size-1,highWaterMark:65536})) {
    carry+=decoder.write(chunk);
    let end;
    while((end=carry.indexOf('\n'))>=0) {
      const line=carry.slice(0,end);carry=carry.slice(end+1);
      if(line)try{visit(JSON.parse(line));}catch(_){/* malformed rows are reported by the manifest */}
    }
    if(carry.length>1048576)throw Error(`JSONL row exceeds 1 MB: ${plan.relativePath}`);
  }
  carry+=decoder.end();
  if(carry)try{visit(JSON.parse(carry));}catch(_){/* see file malformedRows */}
}

function percentile(sorted,p) {
  return sorted.length ? sorted[Math.min(sorted.length-1,Math.floor((sorted.length-1)*p))] : null;
}
function counterObject(counter) {
  return Object.fromEntries([...counter.entries()].sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
}
function inc(counter,key) {counter.set(key,(counter.get(key)||0)+1);}

async function buildResearchHealth(plan,watermarkAt) {
  const births=new Map(),flows=new Map(),boots=new Map(),scanAt=new Map(),seenEvents=new Set();
  const operationalTypes=new Map(),operationalReasons=new Map(),operationalEndpoints=new Map();
  let exactDuplicateEvents=0;
  for (const item of plan) await visitJsonLines(item,row=>{
    const at=Number(row.at??row.observedAt??row.capturedAt);
    if(Number.isFinite(at)&&at>watermarkAt)return;
    const eventId=row.eventId;
    // Duplicate IDs are an integrity signal, not a reason to drop transport events: two
    // requests can legitimately be rejected in the same millisecond and share the legacy
    // operational-event digest. Candidate/flow denominators are deduplicated by their IDs below.
    if(eventId){if(seenEvents.has(eventId))exactDuplicateEvents++;else seenEvents.add(eventId);}
    if(row.processBootId){
      const boot=boots.get(row.processBootId)||{processBootId:row.processBootId,
        processStartedAt:Number(row.processStartedAt)||null,firstAt:null,lastAt:null,rowCount:0};
      boot.rowCount++;
      if(Number.isFinite(at)){boot.firstAt=boot.firstAt===null?at:Math.min(boot.firstAt,at);
        boot.lastAt=boot.lastAt===null?at:Math.max(boot.lastAt,at);}
      boots.set(row.processBootId,boot);
    }
    if(row.scanId&&Number.isFinite(at)){
      const prior=scanAt.get(row.scanId);if(prior===undefined||at<prior)scanAt.set(row.scanId,at);
    }
    if(!item.relativePath.startsWith('research-v2/'))return;
    if(row.kind==='candidate_birth'&&row.candidateId&&!births.has(row.candidateId))births.set(row.candidateId,row);
    else if(row.kind==='order_flow_label'&&row.candidateId){
      const prior=flows.get(row.candidateId);
      if(!prior||Number(row.at)>=Number(prior.at))flows.set(row.candidateId,row);
    } else if(row.kind==='operational_event'){
      const type=row.type||'UNKNOWN',reason=row.reasonCode||'UNSPECIFIED',endpoint=row.endpoint||'UNSPECIFIED';
      inc(operationalTypes,type);inc(operationalReasons,`${type}|${reason}`);inc(operationalEndpoints,`${type}|${endpoint}`);
    }
  });
  function cohortSummary(predicate) {
    const reasonCounts=new Map(),quoteReasons=new Map(),liquidationCoverage=new Map();
    let total=0,mature=0,usableFlow=0,terminalFlow=0,completeQuotes=0;
    for(const [candidateId,birth] of births) {
      if(!predicate(birth))continue;
      total++;
      const at=Number(birth.at),isMature=Number.isFinite(at)&&at<=watermarkAt-61*60000;
      if(!isMature)continue;
      mature++;
      const flow=flows.get(candidateId);
      if(flow){terminalFlow++;if(flow.status==='OK'){usableFlow++;inc(reasonCounts,'OK');}
        else inc(reasonCounts,flow.reasonCode||'UNSPECIFIED_NOT_AVAILABLE');}
      else inc(reasonCounts,'MISSING_TERMINAL');
      const market=birth.market||{},decisionAt=Number(birth.decisionAt??birth.at),observedAt=Number(market.tickerObservedAt);
      let quoteReason='OK';
      if(!Number.isFinite(decisionAt))quoteReason='MISSING_DECISION_TIME';
      else if(!Number.isFinite(Number(market.bid))||!Number.isFinite(Number(market.ask)))quoteReason='MISSING_BID_ASK';
      else if(!Number.isFinite(observedAt))quoteReason='MISSING_QUOTE_TIME';
      else if(observedAt>decisionAt)quoteReason='QUOTE_AFTER_DECISION';
      else if(decisionAt-observedAt>120000)quoteReason='QUOTE_OLDER_THAN_120S';
      if(quoteReason==='OK')completeQuotes++;
      inc(quoteReasons,quoteReason);
      inc(liquidationCoverage,birth.liquidations?.coverage||'MISSING');
    }
    return {births:total,matureBirths:mature,immatureBirths:total-mature,
      flow:{usable:usableFlow,terminal:terminalFlow,missingTerminal:mature-terminalFlow,
        usablePct:mature?Math.round(10000*usableFlow/mature)/100:null,byReason:counterObject(reasonCounts)},
      decisionQuotes:{complete:completeQuotes,completePct:mature?Math.round(10000*completeQuotes/mature)/100:null,
        byReason:counterObject(quoteReasons)},liquidationCoverage:counterObject(liquidationCoverage)};
  }
  const times=[...scanAt.values()].sort((a,b)=>a-b),gaps=[];
  for(let i=1;i<times.length;i++)gaps.push(times[i]-times[i-1]);
  gaps.sort((a,b)=>a-b);
  const bootRows=[...boots.values()].sort((a,b)=>(a.processStartedAt||a.firstAt||0)-(b.processStartedAt||b.firstAt||0));
  return {schemaVersion:'RESEARCH_HEALTH_V1',watermarkAt,matureAfterMs:61*60000,
    cohorts:{allRetained:cohortSummary(()=>true),currentBoot:cohortSummary(row=>row.processBootId===runtime.processBootId),
      newOrayanCurrentBoot:cohortSummary(row=>row.processBootId===runtime.processBootId&&row.engine==='NEW_ORAYAN')},
    transport:{eventTypes:counterObject(operationalTypes),typeAndReason:counterObject(operationalReasons),
      typeAndEndpoint:counterObject(operationalEndpoints)},
    scans:{basis:'distinct scanId values observed in research-event or prospective rows; scans with no persisted research row are not visible',
      observedScanIds:times.length,gapMs:{median:percentile(gaps,.5),p95:percentile(gaps,.95),max:gaps.at(-1)||null,
        over120s:gaps.filter(x=>x>120000).length,over300s:gaps.filter(x=>x>300000).length}},
    restarts:{bootCount:bootRows.length,boots:bootRows},integrity:{exactDuplicateEventIds:exactDuplicateEvents,
      uniqueBirths:births.size,uniqueFlowTerminals:flows.size,manifestFiles:plan.length}};
}

async function buildManifest() {
  const watermarkAt=Date.now(),plan=plannedFiles(),files=[];
  for (const item of plan) files.push(await inspectFile(item));
  const researchHealth=await buildResearchHealth(plan,watermarkAt);
  const identity=runtime.exportIdentity(watermarkAt,files.map(x=>[x.path,x.bytes,x.sha256]));
  return {schemaVersion:'RESEARCH_EXPORT_MANIFEST_V1',...identity,
    fileCount:files.length,rowCount:files.reduce((sum,x)=>sum+x.rowCount,0),files,researchHealth};
}

module.exports={buildManifest,plannedFiles,_test:{inspectFile,visitJsonLines,buildResearchHealth}};
