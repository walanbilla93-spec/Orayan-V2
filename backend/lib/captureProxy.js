'use strict';
const {Worker}=require('worker_threads'),fs=require('fs'),path=require('path');
const QUEUE_ROWS=1024,QUEUE_BYTES=8*1024*1024,PRIORITY_ROWS=128;
// A small bounded message queue isolates fsync, rotation and storage failure from
// the trading event loop. Only compact projected records cross the worker boundary.
class CaptureProxy {
 constructor(dir,options={}){
  this.dir=dir;this.state=fs.existsSync(path.join(dir,'status.json'))?JSON.parse(fs.readFileSync(path.join(dir,'status.json'),'utf8')):{...options,sequence:0,acceptedRows:0,retainedBytes:0,episodeMetadata:{},dedupe:{}};
  this.cached={...this.state,populationComplete:false,writerStarting:true};this.pending=new Map();this.pendingBytes=0;this.id=0;this.localDedupe={...this.state.dedupe};this.lossRows=0;this.lossBytes=0;this.nativeUpdates=new Map();
  this.worker=new Worker(path.join(__dirname,'captureWorker.js'),{workerData:{dir,options}});this.worker.unref();
  this.worker.on('message',m=>{if(m.state)this.state=m.state;if(m.status)this.cached=m.status;
   if(m.id){const p=this.pending.get(m.id);if(p){this.pending.delete(m.id);this.pendingBytes-=p.bytes;m.error?p.reject(Error(m.error)):p.resolve(m.value);}}
   if(m.error)this.cached={...this.cached,populationComplete:false,lastError:{code:m.error}};
   if(this.lossRows&&this.pending.size<QUEUE_ROWS){const rows=this.lossRows,bytes=this.lossBytes;this.lossRows=0;this.lossBytes=0;this.send('loss',{rows,bytes}).catch(()=>{this.lossRows+=rows;this.lossBytes+=bytes;});}
  });
  this.worker.on('error',e=>{this.dead=true;this.cached={...this.cached,populationComplete:false,writerFailed:true,lastError:{code:e.code||'CAPTURE_WORKER_ERROR'}};for(const p of this.pending.values())p.reject(Error('CAPTURE_WORKER_ERROR'));this.pending.clear();});
 }
 send(kind,data={}){if(this.dead)return Promise.reject(Error('CAPTURE_WORKER_UNAVAILABLE'));const id=++this.id,bytes=Buffer.byteLength(JSON.stringify(data));return new Promise((resolve,reject)=>{this.pendingBytes+=bytes;this.pending.set(id,{resolve,reject,bytes});this.worker.postMessage({id,kind,...data});});}
 emit(stream,record,options={}){
  if(options.key&&this.localDedupe[options.key]===options.signature)return false;
  const bytes=Buffer.byteLength(JSON.stringify(record));
  if(bytes>16384||this.pending.size>=(options.priority?QUEUE_ROWS:QUEUE_ROWS-PRIORITY_ROWS)||this.pendingBytes+bytes>QUEUE_BYTES||this.dead){this.lossRows++;this.lossBytes+=bytes;this.cached.populationComplete=false;return false;}
  if(stream==='decision_episode'&&record.sourceEpisodeId){this.state.episodeMetadata??={};this.state.episodeMetadata[record.sourceEpisodeId]={symbol:record.symbol,side:record.side,configHash:record.configHash};}
  if(options.key){this.localDedupe[options.key]=options.signature;while(Object.keys(this.localDedupe).length>4096)delete this.localDedupe[Object.keys(this.localDedupe)[0]];}
  this.send('emit',{stream,record,options}).then(value=>{if(!value&&options.key)delete this.localDedupe[options.key];}).catch(()=>{if(options.key)delete this.localDedupe[options.key];});return true;
 }
 health(error,context={}){if(this.pending.size>=QUEUE_ROWS||this.dead){this.lossRows++;this.cached.populationComplete=false;return false;}this.send('health',{code:error.code||error.reasonCode||error.errorCode||error.message||String(error),context}).catch(()=>{});return true;}
 nativeState(key,value){if(this.dead){this.lossRows++;this.cached.populationComplete=false;this.cached.nativeContinuityGap=true;return false;}this.state.nativeEpisodeIndex??={};this.state.nativeEpisodeIndex[key]=value;while(Object.keys(this.state.nativeEpisodeIndex).length>4096)delete this.state.nativeEpisodeIndex[Object.keys(this.state.nativeEpisodeIndex)[0]];this.nativeUpdates.set(key,value);while(this.nativeUpdates.size>4096){this.nativeUpdates.delete(this.nativeUpdates.keys().next().value);this.lossRows++;this.cached.populationComplete=false;this.cached.nativeContinuityGap=true;}if(!this.nativeTimer)this.nativeTimer=setImmediate(()=>{this.nativeTimer=null;this.flushNative();});return true;}
 flushNative(){if(!this.nativeUpdates.size)return;const updates=[...this.nativeUpdates];this.nativeUpdates.clear();this.send('nativeStates',{updates}).catch(()=>{this.lossRows++;this.cached.populationComplete=false;this.cached.nativeContinuityGap=true;});}
 status(){return {...this.cached,pendingRows:this.pending.size,pendingBytes:this.pendingBytes,queueLimits:{rows:QUEUE_ROWS,bytes:QUEUE_BYTES,priorityRows:PRIORITY_ROWS},volatileLostRows:this.lossRows,populationComplete:this.cached.populationComplete&&!this.lossRows};}
 async flush(){try{this.flushNative();await this.send('flush');}catch(e){this.cached={...this.cached,populationComplete:false,lastError:{code:e.message}};}return this.status();}
 async export(){this.flushNative();return this.send('export');}
 async close(){try{this.flushNative();await this.send('close');}finally{await this.worker.terminate();}}
}
module.exports={CaptureProxy};
