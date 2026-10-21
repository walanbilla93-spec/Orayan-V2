'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const IO=require('./io');
// External exact set and FIFO. Keys are checked in full, even on a hash collision.
// Directory iteration and queue reads hold one record, never a history-sized list.
class Scratch {
  constructor(parent,prefix='v3-work-'){this.dir=fs.mkdtempSync(path.join(parent,prefix));this.counts=Object.create(null);}
  file(table,key){const hash=crypto.createHash('sha256').update(Buffer.from(String(key),'utf16le')).digest('hex');return path.join(this.dir,table,hash.slice(0,2),hash+'.json');}
  get(table,key){const file=this.file(table,key);if(!fs.existsSync(file))return undefined;const r=JSON.parse(fs.readFileSync(file,'utf8'));if(r.key!==String(key))throw Error('SCRATCH_HASH_COLLISION');return r.value;}
  has(table,key){return this.get(table,key)!==undefined;}
  put(table,key,value=true){const exists=this.has(table,key),file=this.file(table,key);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify({key:String(key),value}));if(!exists)this.counts[table]=(this.counts[table]||0)+1;return !exists;}
  *entries(table){const root=path.join(this.dir,table);if(!fs.existsSync(root))return;const dirs=fs.opendirSync(root);try{let d;while((d=dirs.readSync())){const files=fs.opendirSync(path.join(root,d.name));try{let f;while((f=files.readSync())){const r=JSON.parse(fs.readFileSync(path.join(root,d.name,f.name),'utf8'));yield [r.key,r.value];}}finally{files.closeSync();}}}finally{dirs.closeSync();}}
  queue(){return new Queue(path.join(this.dir,crypto.randomUUID()+'.queue'));}
  close(){fs.rmSync(this.dir,{recursive:true,force:true});}
}
class Queue {
  constructor(file){this.fd=fs.openSync(file,'wx+');this.read=0;this.write=0;this.highWaterRecords=1;}
  push(value){const b=Buffer.from(JSON.stringify(value));if(b.length>1024*1024)throw Error('EXTERNAL_QUEUE_RECORD_CAP');const h=Buffer.alloc(4);h.writeUInt32LE(b.length);IO.write(this.fd,h,this.write);IO.write(this.fd,b,this.write+4);this.write+=b.length+4;}
  next(){if(this.read===this.write)return null;const h=IO.read(this.fd,Buffer.alloc(4),this.read),n=h.readUInt32LE();if(n>1024*1024)throw Error('EXTERNAL_QUEUE_RECORD_CAP');const b=IO.read(this.fd,Buffer.alloc(n),this.read+4);this.read+=4+n;return JSON.parse(b);}
  close(){fs.closeSync(this.fd);}
}
module.exports={Scratch,Queue};
