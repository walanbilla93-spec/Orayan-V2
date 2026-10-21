'use strict';
const fs=require('fs'),path=require('path'),os=require('os');
const IO=require('./researchV3/io');
// Same-host dead processes can be proven dead. Cross-host/incomplete ownership
// stays fenced until the offline operator explicitly releases the old lease.
function acquire(dir) {
  const lock=path.join(dir,'WRITER.lock');
  if(fs.existsSync(lock)) {
    let owner;try{owner=JSON.parse(fs.readFileSync(path.join(lock,'owner.json'),'utf8'));}catch{throw Error('V3_WRITER_OWNERSHIP_AMBIGUOUS');}
    if(owner.host!==os.hostname())throw Error('V3_WRITER_OTHER_HOST');
    let dead=false;try{process.kill(owner.pid,0);}catch(e){if(e.code==='ESRCH')dead=true;else throw Error('V3_WRITER_OWNERSHIP_AMBIGUOUS');}
    if(!dead)throw Error('V3_WRITER_ALREADY_RUNNING');
    fs.unlinkSync(path.join(lock,'owner.json'));fs.rmdirSync(lock);
  }
  const lease=IO.lock(dir);return ()=>lease.release();
}
function releaseOffline(dir) {
  const lock=path.join(dir,'WRITER.lock');if(!fs.existsSync(lock))return;
  // Explicit operator assertion is required across container host identities.
  if(process.env.ORAYAN_V3_OFFLINE!=='true')throw Error('OFFLINE_ASSERTION_REQUIRED');
  fs.unlinkSync(path.join(lock,'owner.json'));fs.rmdirSync(lock);if(process.platform!=='win32')IO.syncDir(dir);
}
module.exports={acquire,releaseOffline};
