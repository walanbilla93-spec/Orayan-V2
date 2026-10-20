'use strict';
const fs=require('node:fs'),path=require('node:path');
const {fail,integer,sha}=require('./codec');
function read(fd,b,at) {
  integer(at); integer(at+b.length); let off=0;
  while(off<b.length){const n=fs.readSync(fd,b,off,b.length-off,at+off);if(!n)fail('truncated file');off+=n;} return b;
}
function write(fd,b,at=null) {
  if(at!==null){integer(at);integer(at+b.length);} let off=0;
  while(off<b.length){const n=fs.writeSync(fd,b,off,b.length-off,at===null?null:at+off);if(!n)throw Error('short write');off+=n;}
}
function syncDir(dir) { const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);} }
function safeFile(dir,name) {
  if(typeof name!=='string'||!/^[-a-zA-Z0-9.]+$/.test(name)||name==='.'||name==='..')fail('unsafe index path');
  const file=path.join(dir,name); const s=fs.lstatSync(file); if(!s.isFile()||s.isSymbolicLink())fail('nonregular index file');return file;
}
function hashFile(file) {
  const fd=fs.openSync(file,'r'),crypto=require('node:crypto'),h=crypto.createHash('sha256'),b=Buffer.alloc(65536);
  try{let n;while((n=fs.readSync(fd,b,0,b.length,null))>0)h.update(b.subarray(0,n));return h.digest('hex');}finally{fs.closeSync(fd);}
}
// No lock stealing. An incomplete owner record also fences a second writer.
function lock(dir) {
  const target=path.join(dir,'WRITER.lock'); fs.mkdirSync(target);
  const owner={version:1,pid:process.pid,host:require('node:os').hostname(),nonce:require('node:crypto').randomUUID(),boot:process.platform==='linux'?fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim():null};
  const bytes=Buffer.from(JSON.stringify(owner));const fd=fs.openSync(path.join(target,'owner.json'),'wx',0o600);
  try{write(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);} if(process.platform!=='win32'){syncDir(target);syncDir(dir);}
  let released=false;
  return {owner,release(){if(released)return;if(!fs.readFileSync(path.join(target,'owner.json')).equals(bytes))fail('writer ownership changed');fs.unlinkSync(path.join(target,'owner.json'));fs.rmdirSync(target);if(process.platform!=='win32')syncDir(dir);released=true;}};
}
class Handles {
  constructor(limit=32){this.limit=integer(limit,32);if(!limit)fail();this.map=new Map();}
  get(file){if(this.map.has(file)){const fd=this.map.get(file);this.map.delete(file);this.map.set(file,fd);return fd;}while(this.map.size>=this.limit){const [p,fd]=this.map.entries().next().value;fs.closeSync(fd);this.map.delete(p);}const fd=fs.openSync(file,'r');this.map.set(file,fd);return fd;}
  close(){for(const fd of this.map.values())fs.closeSync(fd);this.map.clear();}
}
class Cache {
  constructor(limit=12*1024*1024){this.limit=integer(limit,12*1024*1024);this.bytes=0;this.map=new Map();this.hits=0;this.misses=0;}
  get(k){const v=this.map.get(k);if(!v){this.misses++;return null;}this.hits++;this.map.delete(k);this.map.set(k,v);return v;}
  put(k,b){const cost=b.length+k.length*2+128;if(cost>this.limit)return;while(this.bytes+cost>this.limit){const [old,v]=this.map.entries().next().value;this.map.delete(old);this.bytes-=v.cost;}this.map.set(k,{b,cost});this.bytes+=cost;}
  clear(){this.map.clear();this.bytes=0;}
}
module.exports={read,write,syncDir,safeFile,hashFile,lock,Handles,Cache};
