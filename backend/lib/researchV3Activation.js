'use strict';
const fs=require('fs'),path=require('path');
const {atomic,sha}=require('./researchStore');
const IO=require('./researchV3/io');
const markerPath=root=>path.join(root,'research-backend-activation.json');
function readMarker(root) {
  const file=markerPath(root);if(!fs.existsSync(file))return null;
  let receipt;try{if(fs.statSync(file).size>16384)throw Error();receipt=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw Error('V3_ACTIVATION_AMBIGUOUS');}
  if(!receipt.body||sha(JSON.stringify(receipt.body))!==receipt.sha256||receipt.body.contract!=='ORAYAN_BACKEND_ACTIVATION_1'||!['V2','V3_SELECTED','V3_WRITE_INTENT'].includes(receipt.body.state))throw Error('V3_ACTIVATION_AMBIGUOUS');
  return receipt.body;
}
function save(root,body){atomic(markerPath(root),{body,sha256:sha(JSON.stringify(body))});}
function hasWrites(root){
  const current=path.join(root,'research-canonical-v3','index','CURRENT');if(!fs.existsSync(current))return false;
  if(fs.statSync(current).size>4*1024*1024)throw Error('V3_ACTIVATION_AMBIGUOUS');
  const r=JSON.parse(fs.readFileSync(current,'utf8'));if(sha(JSON.stringify(r.body))!==r.sha256)throw Error('V3_ACTIVATION_AMBIGUOUS');
  if(r.body.state.activationWriteStarted)return true;
  const wal=path.join(path.dirname(current),'transactions.jsonl');if(fs.existsSync(wal)){
    if(fs.statSync(wal).size>8*1024*1024)throw Error('V3_ACTIVATION_AMBIGUOUS');
    for(const line of require('./researchV3/index').jsonLines(wal)){if(line.incomplete)break;if(sha(line.data)!==line.sha256)throw Error('V3_ACTIVATION_AMBIGUOUS');if(JSON.parse(line.data).state.activationWriteStarted)return true;}
  }return false;
}
function verify(root) {
  const dir=path.join(root,'research-canonical-v3'),file=path.join(dir,'migration-receipt.json');
  const r=JSON.parse(fs.readFileSync(file,'utf8')), {sha256,...body}=r;
  if(sha(JSON.stringify(body))!==sha256||r.state!=='VERIFIED_NOT_ACTIVE'||path.resolve(r.destination)!==path.resolve(dir)||IO.hashFile(path.join(dir,'index','CURRENT'))!==r.currentSHA256)throw Error('V3_VERIFICATION_FAILED');
  return r;
}
function select(root,flag=process.env.RESEARCH_STORE_BACKEND||'v2') {
  if(!['v2','v3'].includes(flag))throw Error('INVALID_RESEARCH_STORE_BACKEND');
  const m=readMarker(root);
  if(hasWrites(root)&&m?.state!=='V3_WRITE_INTENT')throw Error('V3_ACTIVATION_AMBIGUOUS');
  if(m?.state==='V3_WRITE_INTENT') {if(flag!=='v3')throw Error('V3_FIX_FORWARD_REQUIRED');return 'v3';}
  if(flag==='v3') {if(m?.state!=='V3_SELECTED')throw Error('V3_EXPLICIT_ACTIVATION_REQUIRED');verify(root);return 'v3';}
  if(m?.state==='V3_SELECTED')throw Error('V3_SELECTION_REQUIRES_EXPLICIT_ROLLBACK');
  return 'v2';
}
function activate(root) {
  const old=readMarker(root);if(old?.state==='V3_WRITE_INTENT')return old;
  if(hasWrites(root))throw Error('V3_FIX_FORWARD_REQUIRED');
  const r=verify(root);
  if(r.contract==='ORAYAN_CLEAN_V3_EPOCH_1'){
    const proof=require('./researchV3Abandon').verifySource(root,r.sourceHashes);if(proof.manifestSHA256!==r.sourceHashesBefore)throw Error('CLEAN_SOURCE_RECEIPT');
    for(const [rel,hash]of Object.entries(r.inputHashes))if(IO.hashFile(path.join(root,rel))!==hash)throw Error('OPERATIONAL_INPUT_CHANGED');
    const state=JSON.parse(fs.readFileSync(path.join(r.destination,'index','CURRENT'))).body.state;if(state.epochId!==r.epochId||!state.cleanProspectiveExperiment)throw Error('CLEAN_EPOCH_IDENTITY');
  }else{
    const hashes=path.join(r.destination,'source-hashes.jsonl'),scratch=new(require('./researchV3/scratch').Scratch)(require('os').tmpdir(),'orayan-v3-activate-');
    try{if(IO.hashFile(hashes)!==r.sourceHashesBefore)throw Error('MIGRATION_SOURCE_HASH_RECEIPT');require('./researchV3Migration').checkHashes(path.join(root,'research-canonical-v2'),hashes,scratch);}finally{scratch.close();}
  }
  const body={contract:'ORAYAN_BACKEND_ACTIVATION_1',state:'V3_SELECTED',destination:r.destination,baselineLSN:r.storageLSN,migrationSHA256:r.sha256,sourceHashes:r.sourceHashesBefore,at:Date.now()};save(root,body);return body;
}
function beforeWrite(store) {
  const root=path.dirname(store.dir),m=readMarker(root);
  if(!m||!['V3_SELECTED','V3_WRITE_INTENT'].includes(m.state)||path.resolve(m.destination)!==path.resolve(store.dir))throw Error('V3_ADMISSION_FENCED');
  if(m.state==='V3_SELECTED') {verify(root);save(root,{...m,state:'V3_WRITE_INTENT',beforeLSN:store.index.root.lsn,writeIntentAt:Date.now()});}
  store.state.activationWriteStarted=true;
}
function rollback(root) {
  const m=readMarker(root);if(m?.state==='V3_WRITE_INTENT'||hasWrites(root))throw Error('V3_FIX_FORWARD_REQUIRED');
  if(m?.state==='V3_SELECTED')verify(root);
  save(root,{contract:'ORAYAN_BACKEND_ACTIVATION_1',state:'V2',at:Date.now()});return 'v2';
}
module.exports={readMarker,verify,select,activate,beforeWrite,rollback};
