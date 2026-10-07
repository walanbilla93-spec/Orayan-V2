'use strict';
const {Worker}=require('worker_threads'),fs=require('fs'),path=require('path');
// A small bounded message queue isolates fsync, rotation and storage failure from
// the trading event loop. Only compact projected records cross the worker boundary.
class CaptureProxy {
 constructor(dir,options={}){
  this.dir=dir;this.state=fs.existsSync(path.join(dir,'status.json'))?JSON.parse(fs.readFileSync(path.join(dir,'status.json'),'utf8')):{...options,sequence:0,acceptedRows:0,retainedBytes:0,episodeMetadata:{},dedupe:{}};
  this.cached={...this.state,populationComplete:false,writerStarting:true};this.pending=new Map();this.id=0;this.localDedupe={...this.state.dedupe};this.lossRows=0;this.lossBytes=0;
  this.worker=new Worker(path.join(__dirname,'captureWorker.js'),{workerData:{dir,options}});this.worker.unref();
  this.worker.on('message',m=>{if(m.state)this.state=m.state;if(m.status)this.cached=m.status;
   if(m.id){const p=this.pending.get(m.id);if(p){this.pending.delete(m.id);m.error?p.reject(Error(m.error)):p.resolve(m.value);}}
   if(m.error)this.cached={...this.cached,populationComplete:false,lastError:{code:m.error}};
   if(this.lossRows&&this.pending.size<64){const rows=this.lossRows,bytes=this.lossBytes;this.lossRows=0;this.lossBytes=0;this.send('loss',{rows,bytes}).catch(()=>{});}
  });
  this.worker.on('error',e=>{this.dead=true;this.cached={...this.cached,populationComplete:false,writerFailed:true,lastError:{code:e.code||'CAPTURE_WORKER_ERROR'}};for(const p of this.pending.values())p.reject(Error('CAPTURE_WORKER_ERROR'));this.pending.clear();});
 }
 send(kind,data={}){if(this.dead)return Promise.reject(Error('CAPTURE_WORKER_UNAVAILABLE'));const id=++this.id;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.worker.postMessage({id,kind,...data});});}
 emit(stream,record,options={}){
  if(options.key&&this.localDedupe[options.key]===options.signature)return false;
  if(this.pending.size>=64||this.dead){this.lossRows++;this.lossBytes+=Buffer.byteLength(JSON.stringify(record));this.cached.populationComplete=false;return false;}
  if(stream==='decision_episode'&&record.sourceEpisodeId){this.state.episodeMetadata??={};this.state.episodeMetadata[record.sourceEpisodeId]={symbol:record.symbol,side:record.side,configHash:record.configHash};}
  if(options.key){this.localDedupe[options.key]=options.signature;while(Object.keys(this.localDedupe).length>4096)delete this.localDedupe[Object.keys(this.localDedupe)[0]];}
  this.send('emit',{stream,record,options}).then(value=>{if(!value&&options.key)delete this.localDedupe[options.key];}).catch(()=>{if(options.key)delete this.localDedupe[options.key];});return true;
 }
 health(error,context={}){if(this.pending.size>=64||this.dead){this.lossRows++;return false;}this.send('health',{code:error.code||error.reasonCode||error.errorCode||error.message||String(error),context}).catch(()=>{});return true;}
 status(){return {...this.cached,pendingRows:this.pending.size,volatileLostRows:this.lossRows,populationComplete:this.cached.populationComplete&&!this.lossRows};}
 async flush(){try{await this.send('flush');}catch(e){this.cached={...this.cached,populationComplete:false,lastError:{code:e.message}};}return this.status();}
 async export(){return this.send('export');}
 async close(){try{await this.send('close');}finally{await this.worker.terminate();}}
}
module.exports={CaptureProxy};
