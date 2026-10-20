'use strict';
const fs=require('node:fs'),path=require('node:path');
const {sha,u64,integer,fail}=require('./codec');
const {read,write,syncDir,safeFile,hashFile}=require('./io');
const PAGE=65536,HEADER=64,MAGIC=Buffer.from('RSV3MT01');
const ROLE=Object.freeze({slots:1,values:2});
const TAG=Buffer.from('RSV3PAGE');
function leaf(role,page,b){return sha(TAG,Buffer.from([1,ROLE[role]]),u64(page),u64(b.length),b);}
function parent(a,b){return sha(TAG,Buffer.from([2]),a,b);}
function pad(role,n){return sha(TAG,Buffer.from([3,ROLE[role]]),u64(n));}
function empty(role){return sha(TAG,Buffer.from([4,ROLE[role]]));}
function shape(bytes){integer(bytes);const pages=Math.ceil(bytes/PAGE);let base=1;while(base<pages)base*=2;integer(HEADER+(base*2-1)*32);return {pages,base};}
function header(role,bytes){const {pages,base}=shape(bytes),b=Buffer.alloc(HEADER);MAGIC.copy(b);b.writeUInt32LE(1,8);b.writeUInt32LE(ROLE[role],12);u64(bytes).copy(b,16);u64(pages).copy(b,24);u64(base).copy(b,32);return b;}
function nodeOffset(n){return integer(HEADER+(integer(n)-1)*32);}
function buildTree(file,tree,role){
  const bytes=fs.statSync(file).size,{pages,base}=shape(bytes),src=fs.openSync(file,'r'),out=fs.openSync(tree,'wx+',0o600);
  try{
    write(out,header(role,bytes),0);
    const page=Buffer.alloc(PAGE),hashes=Buffer.alloc(PAGE);
    // Disk-level passes: fixed page and hash buffers, no resident leaf array.
    for(let start=0;start<base;start+=PAGE/32){const count=Math.min(PAGE/32,base-start);
      for(let j=0;j<count;j++){const i=start+j,n=Math.min(PAGE,bytes-i*PAGE);const h=i<pages?leaf(role,i,read(src,page.subarray(0,n),i*PAGE)):pad(role,i);h.copy(hashes,j*32);}
      write(out,hashes.subarray(0,count*32),nodeOffset(base+start));
    }
    const parents=Buffer.alloc(PAGE/2);
    for(let width=base/2;width>=1;width/=2){for(let start=0;start<width;start+=PAGE/64){const count=Math.min(PAGE/64,width-start);
      read(out,hashes.subarray(0,count*64),nodeOffset((width+start)*2));
      for(let j=0;j<count;j++)parent(hashes.subarray(j*64,j*64+32),hashes.subarray(j*64+32,j*64+64)).copy(parents,j*32);
      write(out,parents.subarray(0,count*32),nodeOffset(width+start));
    }}
    // Empty files use a separate canonical root; tree still has one pad node.
    const root=pages?read(out,Buffer.alloc(32),nodeOffset(1)):empty(role);fs.fsyncSync(out);
    return {v:1,role,bytes,pages,base,root:root.toString('hex'),sha256:hashFile(file),treeSha256:hashFile(tree),treeBytes:fs.fstatSync(out).size};
  }finally{fs.closeSync(src);fs.closeSync(out);}
}
function validateDescriptor(d,role){
  if(!d||d.v!==1||d.role!==role||!ROLE[role]||! /^[a-f0-9]{64}$/.test(d.root)||! /^[a-f0-9]{64}$/.test(d.sha256)||! /^[a-f0-9]{64}$/.test(d.treeSha256))fail('page descriptor');
  const s=shape(d.bytes);if(s.pages!==d.pages||s.base!==d.base||d.treeBytes!==HEADER+(s.base*2-1)*32)fail('tree shape');
  if(!s.pages&&d.root!==empty(role).toString('hex'))fail('empty root');
}
class Pages {
  constructor(dir,d,role,handles,cache,stats){
    validateDescriptor(d,role);this.d=d;this.role=role;this.handles=handles;this.cache=cache;this.stats=stats;
    this.file=safeFile(dir,d.sha256+'.'+role);this.tree=safeFile(dir,d.treeSha256+'.mtree');
    if(fs.statSync(this.file).size!==d.bytes||fs.statSync(this.tree).size!==d.treeBytes)fail('file size');
    if(!read(handles.get(this.tree),Buffer.alloc(HEADER),0).equals(header(role,d.bytes)))fail('tree header');
    this.identity=d.sha256+':'+d.root+':'+role;
  }
  page(n){
    integer(n);if(n>=this.d.pages)fail('page out of range');const id=this.identity+':'+n,cached=this.cache.get(id);if(cached)return cached.b;
    const len=Math.min(PAGE,this.d.bytes-n*PAGE),b=read(this.handles.get(this.file),Buffer.alloc(len),n*PAGE);this.stats.readBytes+=len;
    let h=leaf(this.role,n,b),node=this.d.base+n,depth=0;
    const sibling=Buffer.alloc(32);
    while(node>1){if(++depth>64)fail('proof depth');const other=node%2?node-1:node+1;
      read(this.handles.get(this.tree),sibling,nodeOffset(other));this.stats.proofBytes+=32;
      h=node%2?parent(sibling,h):parent(h,sibling);node=Math.floor(node/2);
    }
    if(h.toString('hex')!==this.d.root)fail('page authentication');this.cache.put(id,b);return b;
  }
  range(off,len,max){integer(off);integer(len,max);if(off+len>this.d.bytes)fail('range');const b=Buffer.alloc(len);let n=0;
    while(n<len){const at=off+n,p=Math.floor(at/PAGE),within=at%PAGE,page=this.page(p),take=Math.min(page.length-within,len-n);page.copy(b,n,within,within+take);n+=take;}return b;
  }
}
module.exports={PAGE,HEADER,ROLE,TAG,leaf,parent,pad,empty,shape,header,nodeOffset,buildTree,Pages,validateDescriptor};
