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
 const req=read(requestFile,{});
 if(req.schemaVersion!=='ORAYAN_RESEARCH_V2')throw Error('DESTRUCTIVE_LEGACY_RESET_DISABLED');
 if(!req.epochId){req.epochId=crypto.randomUUID();atomic(requestFile,req);}
 const {ResearchStore}=require('./researchStore'),c=new ResearchStore(path.join(root,'research-canonical-v2'));
 c.epoch(req.epochId||crypto.randomUUID());
 const receipt={epochId:c.state.epochId,complete:true,historicalResearchPreserved:true,completedAt:new Date().toISOString()};
 atomic(path.join(root,'capture-epoch-receipt.json'),receipt);fs.renameSync(requestFile,requestFile+'.completed');return receipt;
}
module.exports={run,inventory,safetyBaseline,DIRECTORY_RULES,FILES};
