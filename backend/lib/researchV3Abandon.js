'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const IO=require('./researchV3/io'),A=require('./researchV3Activation');
const {files}=require('./researchV3Migration'),{jsonLines}=require('./researchV3/index');
const flag=root=>path.join(root,'research-v3-bulk-migration-abandoned.json');
function createReceiptFile(file,root){
  try{return fs.openSync(file,'wx',0o444);}catch(e){
    if(e.code!=='ENOSPC'||!root)throw e;
    // Reuse only our own dead launcher's disposable PID files when the abandoned
    // copy has exhausted filesystem inodes. Never consume a canonical file.
    for(const name of ['orayan-v3-migration.pid','orayan-v3-migration-batch.pid','orayan-v3-migration-final.pid']){
      const slot=path.join(root,name);if(!fs.existsSync(slot))continue;const s=fs.lstatSync(slot);
      if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>32||!/^\d+\s*$/.test(fs.readFileSync(slot,'utf8')))throw Error('AUDIT_INODE_SLOT_NOT_DISPOSABLE');
      fs.renameSync(slot,file);const fd=fs.openSync(file,'w');fs.fchmodSync(fd,0o444);return fd;
    }throw e;
  }
}
function sealed(file,body,root=null){
  const data=JSON.stringify(body),value={body,sha256:crypto.createHash('sha256').update(data).digest('hex')};
  const fd=createReceiptFile(file,root);try{IO.write(fd,Buffer.from(JSON.stringify(value,null,2)+'\n'));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}if(process.platform!=='win32')IO.syncDir(path.dirname(file));return value;
}
function read(file){const r=JSON.parse(fs.readFileSync(file,'utf8'));if(crypto.createHash('sha256').update(JSON.stringify(r.body)).digest('hex')!==r.sha256)throw Error('ABANDONMENT_RECEIPT_INTEGRITY');return r;}
function offline(root){
  if(process.env.ORAYAN_V3_OFFLINE!=='true')throw Error('OFFLINE_ASSERTION_REQUIRED');
  if(A.readMarker(root)!==null||A.select(root,'v2')!=='v2')throw Error('STAGING_WAS_ACTIVATED');
  const dir=path.join(root,'research-canonical-v3'),lock=path.join(dir,'WRITER.lock','owner.json');
  if(fs.existsSync(lock)){const o=JSON.parse(fs.readFileSync(lock));if(o.host===require('os').hostname()){try{process.kill(o.pid,0);throw Error('MIGRATION_WRITER_STILL_RUNNING');}catch(e){if(e.code!=='ESRCH')throw e;}}else throw Error('CONFIRM_PREVIOUS_CONTAINER_STOPPED');}
  const current=path.join(dir,'index','CURRENT');if(fs.existsSync(current)&&JSON.parse(fs.readFileSync(current)).body.state.activationWriteStarted)throw Error('AUTHORITATIVE_WRITES_EXIST');
  return dir;
}
function inventory(dir){
  const stat=fs.lstatSync(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('STAGING_ROOT_NOT_DIRECTORY');
  let count=0,bytes=0,allocated=0;const h=crypto.createHash('sha256');
  for(const rel of files(dir)){const s=fs.lstatSync(path.join(dir,rel));if(s.dev!==stat.dev||s.nlink!==1)throw Error('STAGING_FILE_NOT_EXCLUSIVE:'+rel);count++;bytes+=s.size;allocated+=(s.blocks??Math.ceil(s.size/512))*512;h.update(JSON.stringify([rel,s.dev,s.ino,s.size,s.mtimeMs])+'\n');}
  return {files:count,bytes,allocatedBytes:allocated,inventorySHA256:h.digest('hex'),symlinks:0,sharedFiles:0,rootDevice:stat.dev,rootInode:stat.ino};
}
function verifySource(root,hashes){
  const source=path.join(root,'research-canonical-v2');let count=0;
  for(const r of jsonLines(hashes)){if(r.incomplete)throw Error('SOURCE_MANIFEST_TORN');const file=path.resolve(source,r.path);if(!file.startsWith(source+path.sep)||fs.statSync(file).size!==r.bytes||IO.hashFile(file)!==r.sha256)throw Error('V2_SOURCE_BYTES_CHANGED:'+r.path);count++;}
  let actual=0;for(const _ of files(source))actual++;if(actual!==count)throw Error('V2_SOURCE_FILE_COUNT_CHANGED');return {files:count,manifestSHA256:IO.hashFile(hashes),bytesUnchanged:true};
}
function audit(root){
  root=path.resolve(root);const dir=offline(root),proof=inventory(dir),receipts=path.join(root,'research-cutover-receipts');fs.mkdirSync(receipts,{recursive:true});
  const hashes=path.join(dir,'source-hashes.jsonl'),source=verifySource(root,hashes),copy=path.join(receipts,'v2-source-hashes-'+source.manifestSHA256+'.jsonl');
  if(!fs.existsSync(copy)){const fd=createReceiptFile(copy,root),input=fs.openSync(hashes,'r'),b=Buffer.alloc(65536);try{let n;while((n=fs.readSync(input,b,0,b.length,null)))IO.write(fd,b.subarray(0,n));fs.fsyncSync(fd);}finally{fs.closeSync(fd);fs.closeSync(input);}}
  const body={contract:'ORAYAN_V3_STAGING_ABANDONMENT_1',state:'ABANDONED_BEFORE_ACTIVATION',at:new Date().toISOString(),root,staging:dir,activationMarkerAbsent:true,activationWriteStarted:false,authoritativeV3Writes:0,selectedBackend:'v2',v2RemainedSelectedThroughout:true,selectionEvidence:'ABSENT_ACTIVATION_MARKER_AND_NO_WRITE_FLAG_OR_WAL_WRITE_INTENT;SERVICE_HELD_WITHOUT_SERVER',bulkMigrationWillNotResume:true,v2Source:source,sourceHashes:copy,stagingIsolation:proof};
  const receipt=path.join(receipts,'v3-abandonment-'+crypto.randomUUID()+'.json'),sealedReceipt=sealed(receipt,body,root);
  if(!fs.existsSync(flag(root)))sealed(flag(root),{contract:'ORAYAN_V3_BULK_MIGRATION_PERMANENT_STOP_1',receipt,receiptSHA256:sealedReceipt.sha256},root);
  return {receipt,...body};
}
function remove(root){
  root=path.resolve(root);const fence=read(flag(root)).body,r=read(fence.receipt);if(r.sha256!==fence.receiptSHA256)throw Error('ABANDONMENT_FENCE_CONFLICT');
  const dir=offline(root),before=inventory(dir);if(JSON.stringify(before)!==JSON.stringify(r.body.stagingIsolation))throw Error('STAGING_CHANGED_SINCE_ABANDONMENT_AUDIT');
  verifySource(root,r.body.sourceHashes);require('./researchV3/scratch').removeTree(dir);const source=verifySource(root,r.body.sourceHashes);
  const body={contract:'ORAYAN_V3_STAGING_REMOVAL_1',at:new Date().toISOString(),abandonmentReceipt:fence.receipt,removed:dir,reclaimedAllocatedBytes:before.allocatedBytes,reclaimedLogicalBytes:before.bytes,v2Source:source};
  const receipt=path.join(path.dirname(fence.receipt),'v3-removal-'+crypto.randomUUID()+'.json');sealed(receipt,body);return {receipt,...body};
}
module.exports={audit,remove,inventory,verifySource,sealed,read,createReceiptFile};
