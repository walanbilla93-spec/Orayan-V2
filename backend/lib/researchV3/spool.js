'use strict';
// Offline-only external sort. At most 16 input readers and bounded runs.
const fs=require('node:fs'),path=require('node:path');
const C=require('./codec'),IO=require('./io');
class Input {
  constructor(file){this.fd=fs.openSync(file,'r');this.b=Buffer.alloc(65536);this.at=0;this.end=0;this.eof=false;}
  take(n,allowEnd=false){C.integer(n,C.MAX_KEY+C.MAX_VALUE+56);const out=Buffer.alloc(n);let done=0;while(done<n){if(this.at===this.end){this.end=fs.readSync(this.fd,this.b,0,this.b.length,null);this.at=0;if(!this.end){if(allowEnd&&!done)return null;C.fail('truncated sort record');}}const size=Math.min(n-done,this.end-this.at);this.b.copy(out,done,this.at,this.at+size);this.at+=size;done+=size;}return out;}
  next(){const head=this.take(4,true);if(!head)return null;const n=head.readUInt32LE();if(n<56)C.fail('sort frame');const b=this.take(n),kl=b.readUInt32LE(32),vl=b.readUInt32LE(36);if(56+kl+vl!==n)C.fail('sort lengths');return C.record(b.subarray(56,56+kl),b.subarray(56+kl),C.from64(b,40),b.readUInt32LE(48),b.subarray(0,32));}
  close(){fs.closeSync(this.fd);}
}
class Output {
  constructor(file){this.fd=fs.openSync(file,'wx',0o600);this.b=Buffer.alloc(65536);this.n=0;}
  bytes(b){let at=0;while(at<b.length){const n=Math.min(b.length-at,this.b.length-this.n);b.copy(this.b,this.n,at,at+n);this.n+=n;at+=n;if(this.n===this.b.length){IO.write(this.fd,this.b);this.n=0;}}}
  add(r){const n=56+r.key.length+r.value.length,h=Buffer.alloc(60);h.writeUInt32LE(n);r.digest.copy(h,4);h.writeUInt32LE(r.key.length,36);h.writeUInt32LE(r.value.length,40);C.u64(r.lsn).copy(h,44);h.writeUInt32LE(r.flags,52);this.bytes(h);this.bytes(r.key);this.bytes(r.value);}
  close(){if(this.fd===null)return;const fd=this.fd;this.fd=null;try{if(this.n)IO.write(fd,this.b.subarray(0,this.n));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
}
function merge(files,out,compare=C.compare){if(files.length>16)C.fail('fan-in');const readers=files.map(f=>new Input(f)),heads=readers.map(r=>r.next()),writer=new Output(out);try{for(;;){let best=-1;for(let i=0;i<heads.length;i++)if(heads[i]&&(best<0||compare(heads[i],heads[best])<0))best=i;if(best<0)break;writer.add(heads[best]);heads[best]=readers[best].next();}}finally{writer.close();for(const r of readers)r.close();}}
function sort(dir,records,compare=C.compare){
  fs.mkdirSync(dir);let run=0,rows=[],budget=0;
  const file=(pass,n)=>path.join(dir,'p'+pass+'-'+n+'.run');
  function flush(){if(!rows.length)return;rows.sort(compare);const w=new Output(file(0,run++));try{for(const r of rows)w.add(r);}finally{w.close();}rows=[];budget=0;}
  for(const r of records){const cost=(r.key.length+r.value.length+128)*3+256;if(cost>4*1024*1024)C.fail('sort value requires blob');if(budget+cost>4*1024*1024)flush();rows.push(r);budget+=cost;}flush();
  if(!run){const w=new Output(file(0,0));w.close();run=1;}
  let pass=0,count=run;while(count>1){let next=0;for(let start=0;start<count;start+=16){merge(Array.from({length:Math.min(16,count-start)},(_,i)=>file(pass,start+i)),file(pass+1,next++),compare);}count=next;pass++;}
  return file(pass,0);
}
module.exports={Input,Output,merge,sort};
