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
  else if(message.kind==='loss'){for(let i=0;i<message.rows;i++)c.failure('ASYNC_QUEUE_CAP',i?0:message.bytes);}
  else if(message.kind==='export')value=c.export();
  else if(message.kind==='flush')c.flush();
  else if(message.kind==='close'){c.state.sessionOpen=false;c.flush();}
  parentPort.postMessage({id:message.id,state:c.state,status:c.status(),value});
  if(message.kind==='close')parentPort.close();
 }catch(e){parentPort.postMessage({id:message.id,error:e.code||e.message,status:{...c.status(),populationComplete:false}});}
});
