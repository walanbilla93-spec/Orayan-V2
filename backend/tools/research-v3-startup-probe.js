#!/usr/bin/env node
'use strict';
// Runs the actual local server entrypoint against an explicitly supplied fixture
// data root. No trading RUN intent or external transports are enabled here.
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
async function main(){
  const [rootArg,outputArg]=process.argv.slice(2);if(!rootArg)throw Error('FIXTURE_DATA_DIR_REQUIRED');const root=path.resolve(rootArg);
  if(!fs.existsSync(path.join(root,'engineControl.json'))||JSON.parse(fs.readFileSync(path.join(root,'engineControl.json'),'utf8')).desiredRunning!==false)throw Error('FIXTURE_MUST_HAVE_STOPPED_ENGINE');
  require('../lib/store').DATA_DIR=root;
  process.env.RESEARCH_STORE_BACKEND='v3';process.env.GROQ_SHADOW_ENABLED='false';process.env.ALIBABA_SHADOW_ENABLED='false';
  const legacy=require('../lib/researchStore'),Original=legacy.ResearchStore;let legacyConstructs=0;
  legacy.ResearchStore=new Proxy(Original,{construct(){legacyConstructs++;throw Error('LEGACY_V2_BOOT_FORBIDDEN');}});
  const open=fs.openSync,v2=path.join(root,'research-canonical-v2')+path.sep;let v2Opens=0;
  fs.openSync=(file,...args)=>{if(typeof file==='string'&&path.resolve(file).startsWith(v2)){v2Opens++;throw Error('V2_HISTORY_OPEN_AT_BOOT');}return open(file,...args);};
  const runtime=require('../lib/researchRuntime');
  const before=process.memoryUsage();const {server,startServer}=require('../server');
  startServer(0);await new Promise(resolve=>server.once('listening',resolve));
  await Promise.all([require('../lib/groqShadowProducer').initialize(),require('../lib/alibabaShadowProducer').initialize()]);
  const c=runtime.current(),memory=c.memory(),status=c.status();
  assert.equal(legacyConstructs,0);assert.equal(v2Opens,0);assert.equal(c.enumerationAttempts,0);
  assert.equal(c.index.cursorReads.events||0,0,'boot must never enumerate retained event history');
  assert.equal(memory.structures.historyDictionaries.count,0);
  const result={runtime:process.version,platform:process.platform,fixtureDataDir:root,serviceEntrypoint:'backend/server.js',legacyConstructs,retainedRows:status.retainedRows,eventSequence:status.sequence,before,memory,storeStartup:c.startupMemory,providerRecovery:{Groq:require('../lib/groqShadowProducer').maintenanceStatus(),Alibaba:require('../lib/alibabaShadowProducer').maintenanceStatus()},assertions:{noLegacyV2Constructor:true,noRetainedEventCursorAtBoot:true,noHistoricalEnumeration:true},activation:require('../lib/researchV3Activation').readMarker(root)};
  if(outputArg)fs.writeFileSync(path.resolve(outputArg),JSON.stringify(result,null,2));else console.log(JSON.stringify(result,null,2));
  await new Promise(resolve=>server.close(resolve));await runtime.close();legacy.ResearchStore=Original;fs.openSync=open;
}
if(require.main===module)main().then(()=>process.exit(0)).catch(e=>{console.error(e.stack);process.exit(1);});
module.exports={main};
