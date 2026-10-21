'use strict';
// Offline fixture construction only; never called from a cooperative callback.
const fs=require('node:fs'),path=require('node:path'),C=require('../../lib/researchV3/codec'),S=require('../../lib/researchV3/shard'),Spool=require('../../lib/researchV3/spool');
const H=215336;
function prepare(root){const file=path.join(root,'fixture-descriptors.json');if(fs.existsSync(file))return JSON.parse(fs.readFileSync(file));const dir=path.join(root,'fixture');fs.mkdirSync(dir);function* records(){for(let i=0;i<H;i++)yield C.record(C.key('D','record',['fixture/'+i]),Buffer.alloc(128,65),i+1);}
 const input=new Spool.Input(Spool.sort(path.join(dir,'sort'),records())),directory=S.directory();let r,w,b=-1;try{while((r=input.next())){if(r.digest[0]!==b){if(w)directory.D[b]=w.finish();b=r.digest[0];w=new S.Writer(dir,'D',b);}w.add(r);}if(w)directory.D[b]=w.finish();}finally{input.close();}
 const representative=[];for(const d of directory.D){if(d.empty)continue;const reader=new S.Reader(dir,d);try{representative.push(reader.at(0,true).key.toString('hex'));}finally{reader.close();}}
 const result={H,seed:'sequential-key-v1',directory,representative};fs.writeFileSync(file,JSON.stringify(result));return result;
}
function attach(root,dir,fixture){fs.mkdirSync(dir,{recursive:true});for(const d of fixture.directory.D)if(!d.empty)for(const role of ['slots','values'])for(const name of [d[role].sha256+'.'+role,d[role].treeSha256+'.mtree']){const target=path.join(dir,name);if(!fs.existsSync(target)){if(process.platform==='win32')fs.copyFileSync(path.join(root,'fixture',name),target,fs.constants.COPYFILE_EXCL);else fs.linkSync(path.join(root,'fixture',name),target);}}
}
module.exports={prepare,attach};
