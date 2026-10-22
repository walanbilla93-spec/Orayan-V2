'use strict';
// These namespaces are created empty during the clean cutover. Never visit the
// DATA_DIR siblings (V2 history, old lessons, trades.json or provider ledgers).
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const IO=require('./researchV3/io');
const ROOTS=['feedback-memory','prospective-native','shadow-operational'];
const RECEIPTS=['migration-receipt.json','operational-obligations.jsonl'];
const pause=()=>new Promise(resolve=>setImmediate(resolve));
async function spool(store,target){
  if(store.backend!=='v3'||!store.state.cleanProspectiveExperiment)throw Error('CLEAN_V3_EPOCH_REQUIRED');
  const output=fs.openSync(target,'wx',0o600),buffer=Buffer.alloc(65536);
  let files=0,bytes=0;
  function line(value){IO.write(output,Buffer.from(JSON.stringify(value)+'\n'));}
  async function copy(file,relative){
    if(!fs.existsSync(file))return;
    const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error('EPOCH_EVIDENCE_NOT_REGULAR');
    const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    const observedAt=Date.now(),size=fs.fstatSync(fd).size,hash=crypto.createHash('sha256');
    try{
      line({type:'file',path:relative,bytes:size,observedAt,sourceEpoch:store.state.epochId});
      for(let offset=0;offset<size;offset+=buffer.length){
        const b=IO.read(fd,buffer.subarray(0,Math.min(buffer.length,size-offset)),offset);
        hash.update(b);line({type:'chunk',offset,data:b.toString('base64')});await pause();
      }
      line({type:'end',path:relative,bytes:size,sha256:hash.digest('hex')});files++;bytes+=size;
    }finally{fs.closeSync(fd);}
  }
  async function walk(relative,depth=0){
    const root=path.join(store.dir,relative);if(!fs.existsSync(root))return;
    if(depth>6||fs.lstatSync(root).isSymbolicLink())throw Error('EPOCH_EVIDENCE_UNSAFE_DIRECTORY');
    const dir=fs.opendirSync(root,{bufferSize:16});
    try{let entry;while((entry=dir.readSync())){
      const name=path.posix.join(relative,entry.name);
      if(entry.isSymbolicLink())throw Error('EPOCH_EVIDENCE_SYMLINK');
      if(entry.isDirectory())await walk(name,depth+1);
      else if(/\.(json|jsonl|jsonl\.gz)$/.test(entry.name))await copy(path.join(store.dir,name),name);
      await pause();
    }}finally{dir.closeSync();}
  }
  try{
    for(const root of ROOTS)await walk(root);
    for(const receipt of RECEIPTS)await copy(path.join(store.dir,receipt),receipt);
    fs.fsyncSync(output);return {files,sourceBytes:bytes,namespaces:ROOTS,
      encoding:'file/chunk/end JSONL; base64 chunks with per-file SHA256',
      consistency:'Canonical events use the manifest sequence watermark. Supplemental files use independent observedAt/byte watermarks; later appends are excluded.',
      completedV2HistoryIncluded:false};
  }finally{fs.closeSync(output);}
}
module.exports={spool};
