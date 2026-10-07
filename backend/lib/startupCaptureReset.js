'use strict';
// Offline startup migration. Runs before any engine/provider/observer is imported.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const DIRECTORY_RULES={
 'research-v2':/^(compact|births|outcomes|liquidations|coverage|flow|forward)-[0-9-]+\.jsonl$|^compact-cohort\.json$/,
 'research-events-v1':/^events-[0-9-]+\.jsonl$/,
 'research-supplement-v1':/^supplement-[0-9-]+\.jsonl$/,
 'early-entry-shadow-v1':/^early-entry-[0-9-]+\.jsonl$/,
 'groq-shadow':/^(candidate-snapshots|decisions)\.jsonl$/,
 'alibaba-shadow':/^(candidate-snapshots|decisions)\.jsonl$/,
 'v3-shadow':/^(v2|v3|ai|trades)-[0-9-]+\.jsonl$|^checkpoint\.json$/,
 'v3-shadow-compact-v1':/^(v2|v3|ai|trades|errors|paths|arms)-[0-9-]+\.jsonl\.gz(?:\.tmp)?$|^checkpoint\.json(?:\.tmp)?$|^holdout-v34b(?:-validation-[0-9]+)?\.json$|^capture-live-qualification\.json$|^capture-pending\.json$|^archive-transaction\.json$|^export-[a-f0-9-]+(?:-[a-z0-9]+-manifest)?\.gz$/
};
const FILES=['researchEnvironmentV1.json','researchEventsV1.json','signalEventsCompactV2.json','signalHistory.json','trades.json','marciShadowTrades.json'];
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const read=(file,other)=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):other;
const atomic=(file,j)=>{const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(j));fs.renameSync(tmp,file);};
function safetyBaseline(trades){if(trades.some(t=>['PENDING','OPEN'].includes(t.status)))throw Error('ACTIVE_EXECUTION_POSITION_RESET_BLOCKED');return {total:trades.length,closed:trades.map((t,index)=>({t,index})).filter(x=>x.t.status==='CLOSED').map(({t,index})=>({index,closedAt:t.closedAt,netPnl:t.netPnl}))};}
function within(root,file){const rel=path.relative(root,file);if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('RESET_OUTSIDE_ROOT');if(fs.lstatSync(file).isSymbolicLink())throw Error('RESET_SYMLINK_BLOCKED');}
function inventory(root){const files=[];function walk(file,family,relative=''){
  within(root,file);const s=fs.lstatSync(file);if(s.isDirectory()){
    if(relative&&family==='v3-shadow-compact-v1'&&!/^(capture-ledger(?:\/tombstones)?|daily-snapshots(?:\/[0-9]{4}-[0-9]{2}-[0-9]{2})?)$/.test(relative))throw Error('UNKNOWN_CAPTURE_SUBDIRECTORY:'+relative);
    if(relative&&family!=='v3-shadow-compact-v1')throw Error('UNKNOWN_CAPTURE_SUBDIRECTORY:'+relative);
    for(const n of fs.readdirSync(file))walk(path.join(file,n),family,relative?relative+'/'+n:n);return;
  }
  let known=relative.includes('/')?false:DIRECTORY_RULES[family]?.test(relative);
  if(family==='v3-shadow-compact-v1'&&relative.startsWith('capture-ledger/'))known=/^capture-ledger\/(totals|[0-9-]+)\.json(?:\.tmp)?$|^capture-ledger\/tombstones\/[a-zA-Z0-9_.-]+\.json(?:l)?$/.test(relative);
  if(family==='v3-shadow-compact-v1'&&relative.startsWith('daily-snapshots/'))known=/^daily-snapshots\/[0-9-]+\/((v2|v3|ai|trades|errors|paths|arms)-[0-9-]+\.jsonl\.gz|manifest\.json|download-manifest\.jsonl\.gz)$/.test(relative);
  if(!known)throw Error('UNKNOWN_CAPTURE_FILE:'+family+'/'+relative);
  files.push({path:file,bytes:s.size,modifiedAt:s.mtime.toISOString(),...(s.size<2097152&&file.endsWith('.json')?{sha256:sha(fs.readFileSync(file))}:{})});
 }
 for(const family of Object.keys(DIRECTORY_RULES)){const f=path.join(root,family);if(fs.existsSync(f))walk(f,family);}
 for(const name of FILES){const f=path.join(root,name);if(fs.existsSync(f)){within(root,f);const s=fs.lstatSync(f);if(!s.isFile())throw Error('RESET_FILE_TYPE');files.push({path:f,bytes:s.size,modifiedAt:s.mtime.toISOString(),sha256:sha(fs.readFileSync(f))});}}
 return {at:new Date().toISOString(),root,metadataOnly:true,files,totalBytes:files.reduce((n,f)=>n+f.bytes,0),totalFiles:files.length};
}
function run(root=path.resolve(__dirname,'../data')){
 const requestFile=path.join(root,'capture-reset-request.json');if(!fs.existsSync(requestFile))return {requested:false};
 const req=read(requestFile,{});if(req.schemaVersion!=='ORAYAN_MINIMAL_CAPTURE_V1'||!req.epochId||!req.planSha256||req.expectedMode!=='paper')throw Error('INVALID_CAPTURE_RESET_REQUEST');
 const receiptFile=path.join(root,'capture-reset-receipt.json');if(fs.existsSync(receiptFile)&&read(receiptFile,{}).epochId===req.epochId){fs.unlinkSync(requestFile);for(const name of ['capture-operational-marci.json','capture-reset-progress.json'])if(fs.existsSync(path.join(root,name)))fs.unlinkSync(path.join(root,name));return {alreadyComplete:true};}
 const settings=read(path.join(root,'settings.json'),{});if((settings.mode??'paper')!=='paper')throw Error('EXECUTION_MODE_RESET_BLOCKED');
 const progressFile=path.join(root,'capture-reset-progress.json'),operative=path.join(root,'capture-operational-marci.json');
 let progress=read(progressFile,null),audit,baseline,pendingShadow,hashes,censoredOldV3ResearchPositions;
 if(progress){if(progress.epochId!==req.epochId)throw Error('RESET_EPOCH_CONFLICT');audit=read(path.join(root,'capture-pre-reset-final-audit.json'));baseline=read(path.join(root,'captureSafetyClosed.json'));pendingShadow=read(operative);hashes=progress.protectedHashes;censoredOldV3ResearchPositions=progress.censoredOldV3ResearchPositions;}
 else {
  const trades=read(path.join(root,'trades.json'),[]),shadow=read(path.join(root,'marciShadowTrades.json'),[]);baseline=safetyBaseline(trades);
  audit=inventory(root); // Validate the entire allowlist BEFORE deleting a single byte.
  const protectedNames=['settings.json','symbolStats.json','bosPending.json'];hashes=Object.fromEntries(protectedNames.filter(n=>fs.existsSync(path.join(root,n))).map(n=>[n,sha(fs.readFileSync(path.join(root,n)))]));
  const oldCheckpoint=read(path.join(root,'v3-shadow-compact-v1/checkpoint.json'),{});censoredOldV3ResearchPositions=(oldCheckpoint.activeTrades||[]).length+(oldCheckpoint.armWorkers||[]).length;
  pendingShadow=shadow.filter(t=>['PENDING','OPEN'].includes(t.status));
  atomic(operative,pendingShadow.map(t=>({...t,inheritedWorkingState:true,originEpoch:'PRE_RESET'})));
  atomic(path.join(root,'captureSafetyClosed.json'),baseline);atomic(path.join(root,'capture-pre-reset-final-audit.json'),audit);
  progress={epochId:req.epochId,protectedHashes:hashes,censoredOldV3ResearchPositions,preparedAt:new Date().toISOString()};atomic(progressFile,progress);
 }
 // Explicit files only; never delete a directory parent or the shared volume.
 for(const f of audit.files)if(fs.existsSync(f.path)){within(root,f.path);fs.unlinkSync(f.path);}
 for(const name of FILES)atomic(path.join(root,name),[]);
 atomic(path.join(root,'marciShadowTrades.json'),pendingShadow.map(t=>({...t,inheritedWorkingState:true,originEpoch:'PRE_RESET'})));
 // The extra operational file is a temporary migration handoff, not a retained backup.
 const policy={epochId:req.epochId,startedAt:Date.now(),schemaVersion:req.schemaVersion,planSha256:req.planSha256,schemaSha256:req.schemaSha256,mode:'paper'};
 atomic(path.join(root,'capture-minimal-policy.json'),policy);
 for(const [name,hash]of Object.entries(hashes))if(sha(fs.readFileSync(path.join(root,name)))!==hash)throw Error('PROTECTED_STATE_CHANGED');
 const control=read(path.join(root,'engineControl.json'),{});atomic(path.join(root,'engineControl.json'),{...control,desiredRunning:req.resumeEngine===true,lastStopReason:'CAPTURE_RESET_COMPLETE'});
 const receipt={completedAt:new Date().toISOString(),epochId:req.epochId,cleanEpochStartedAt:policy.startedAt,schemaVersion:req.schemaVersion,planSha256:req.planSha256,schemaSha256:req.schemaSha256,cleared:audit.files.map(f=>({path:f.path,bytes:f.bytes})),clearedBytes:audit.totalBytes,clearedFiles:audit.totalFiles,protectedHashes:hashes,executionModePreserved:'paper',activeLiveOrdersTouched:0,activeMainPositions:0,preservedMarciWorkingPositions:pendingShadow.length,safetyTuples:baseline.closed.length,safetyReason:'Exact operational breaker input; no candidate/trade identity or prices retained',censoredOldV3ResearchPositions,fullPayloadBackupCreated:false,complete:true};
 atomic(receiptFile,receipt);fs.unlinkSync(requestFile);fs.unlinkSync(operative);fs.unlinkSync(progressFile);return receipt;
}
module.exports={run,inventory,safetyBaseline,DIRECTORY_RULES,FILES};
