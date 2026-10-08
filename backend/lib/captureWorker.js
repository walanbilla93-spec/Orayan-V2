'use strict';
const {parentPort,workerData}=require('worker_threads');
const {Capture}=require('./minimalCapture');
const c=new Capture(workerData.dir,workerData.options);
if(c.state.sessionOpen){c.state.populationComplete=false;c.state.possibleCrashGap=true;}
c.state.sessionOpen=true;c.flush();
parentPort.postMessage({ready:true,state:c.state,status:c.status()});
parentPort.on('message',message=>{
 try {
  let value;
  if(message.kind==='emit')value=c.emit(message.stream,message.record,message.options);
  else if(message.kind==='health')value=c.health({code:message.code},message.context);
  else if(message.kind==='nativeState'){c.state.nativeEpisodeIndex??={};c.state.nativeEpisodeIndex[message.key]=message.value;while(Object.keys(c.state.nativeEpisodeIndex).length>4096)delete c.state.nativeEpisodeIndex[Object.keys(c.state.nativeEpisodeIndex)[0]];}
  else if(message.kind==='nativeStates'){c.state.nativeEpisodeIndex??={};for(const [key,value]of message.updates)c.state.nativeEpisodeIndex[key]=value;while(Object.keys(c.state.nativeEpisodeIndex).length>4096)delete c.state.nativeEpisodeIndex[Object.keys(c.state.nativeEpisodeIndex)[0]];}
  else if(message.kind==='loss'){for(let i=0;i<message.rows;i++)c.failure('ASYNC_QUEUE_CAP',i?0:message.bytes);}
  else if(message.kind==='export')value=c.export();
  else if(message.kind==='flush')c.flush();
  else if(message.kind==='close'){c.state.sessionOpen=false;c.flush();}
  parentPort.postMessage({id:message.id,state:['flush','export','close'].includes(message.kind)?c.state:undefined,status:c.status(),value});
  if(message.kind==='close')parentPort.close();
 }catch(e){parentPort.postMessage({id:message.id,error:e.code||e.message,status:{...c.status(),populationComplete:false}});}
});
