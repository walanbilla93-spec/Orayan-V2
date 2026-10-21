#!/usr/bin/env node
'use strict';
const path=require('path');
async function main(){
  const [command='migrate',rootArg=process.env.DATA_DIR]=process.argv.slice(2);
  if(!rootArg)throw Error('DATA_DIR_REQUIRED');const root=path.resolve(rootArg);
  if(process.env.ORAYAN_V3_OFFLINE!=='true')throw Error('STOP_SERVICE_AND_SET_ORAYAN_V3_OFFLINE_TRUE');
  const A=require('../lib/researchV3Activation');let result;
  if(command==='migrate'){
    let next=0;
    result=await require('../lib/researchV3Migration').migrate(root,{afterStep:step=>{
      const now=Date.now();if(now<next&&!step.startsWith('stage:')&&step!=='verified')return;
      next=now+30000;console.error(JSON.stringify({migrationProgress:step,at:new Date(now).toISOString(),memory:process.memoryUsage()}));
    }});
  }
  else if(command==='abandon-audit')result=require('../lib/researchV3Abandon').audit(root);
  else if(command==='prepare-clean-epoch')result=await require('../lib/researchV3CleanEpoch').prepare(root);
  else if(command==='publish-clean-epoch')result=require('../lib/researchV3CleanEpoch').publish(root);
  else if(command==='remove-abandoned-staging')result=require('../lib/researchV3Abandon').remove(root);
  else if(command==='verify')result=A.verify(root);
  else if(command==='activate')result=A.activate(root);
  else if(command==='rollback-before-write')result=A.rollback(root);
  else if(command==='release-offline-lease')result=require('../lib/researchV3Lease').releaseOffline(path.join(root,'research-canonical-v3'))||{released:true};
  else if(command==='health'){
    if(A.select(root,'v3')!=='v3')throw Error('V3_NOT_SELECTED');
    const dir=path.join(root,'research-canonical-v3'),release=require('../lib/researchV3Lease').acquire(dir);let c;
    try{c=new(require('../lib/researchStoreV3').ResearchStoreV3)(dir,{offline:true});result={status:c.status(),memory:c.memory(),activation:A.readMarker(root)};}finally{c?.index.handles.close();c?.index.cache.clear();release();}
  }else throw Error('UNKNOWN_COMMAND');
  console.log(JSON.stringify(result,null,2));
}
if(require.main===module)main().catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports={main};
