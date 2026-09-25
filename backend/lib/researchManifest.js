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

async function buildManifest() {
  const watermarkAt=Date.now(),plan=plannedFiles(),files=[];
  for (const item of plan) files.push(await inspectFile(item));
  const identity=runtime.exportIdentity(watermarkAt,files.map(x=>[x.path,x.bytes,x.sha256]));
  return {schemaVersion:'RESEARCH_EXPORT_MANIFEST_V1',...identity,
    fileCount:files.length,rowCount:files.reduce((sum,x)=>sum+x.rowCount,0),files};
}

module.exports={buildManifest,plannedFiles,_test:{inspectFile}};
