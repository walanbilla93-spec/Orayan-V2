'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),vm=require('vm');
const runtime=require('../lib/researchRuntime'),archive=require('../lib/researchArchive'),store=require('../lib/store');
const {routes}=require('../routes/api');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
test('current export single-flight, caller leases and failure retry',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'current-flight-test-')),oldRoot=store.DATA_DIR,build=archive.build;
  store.DATA_DIR=root;runtime.prepare();const c=runtime.current();
  c.emit('decisions',{sourceEpisodeId:'flight',boundary:'BIRTH',at:Date.now()});
  t.after(async()=>{archive.build=build;await runtime.close();store.DATA_DIR=oldRoot;fs.rmSync(root,{recursive:true,force:true});});
  await t.test('concurrent current and alias routes build once and retain ZIP until last caller releases',async()=>{
    const gate=deferred();let calls=0;
    archive.build=async(...args)=>{calls++;await gate.promise;return build(...args);};
    const pending=Array.from({length:3},(_,i)=>routes[i%2?'GET /api/capture/export':'GET /api/capture/current.zip']({req:{headers:{}}}));
    assert.equal(calls,1);assert.equal(c.exportReaders,1);gate.resolve();
    const results=await Promise.all(pending),file=results[0].files[0].path;
    const bytes=fs.readFileSync(file);assert.equal(bytes.readUInt32LE(),0x04034b50);
    for(const result of results){assert.equal(result.filename,'orayan-current-30h.zip');assert.equal(result.contentType,'application/zip');assert.equal(result.files[0].path,file);assert.deepEqual(fs.readFileSync(result.files[0].path),bytes);}
    results[0].cleanup();results[0].cleanup();assert.equal(fs.existsSync(file),true);
    results[1].cleanup();assert.equal(fs.existsSync(file),true);
    results[2].cleanup();assert.equal(fs.existsSync(file),false);assert.equal(c.exportReaders,0);
  });
  await t.test('shared failure rejects every caller, removes scratch and allows a fresh build',async()=>{
    const gate=deferred();let calls=0,target;
    archive.build=async(_c,options)=>{calls++;target=options.target;await gate.promise;throw Error('test-build-failure');};
    const pending=[runtime.downloadCurrent(),runtime.downloadCurrent()];
    const settled=Promise.allSettled(pending);assert.equal(calls,1);gate.resolve();
    for(const result of await settled){assert.equal(result.status,'rejected');assert.match(result.reason.message,/test-build-failure/);}
    assert.equal(fs.existsSync(path.dirname(target)),false);assert.equal(c.exportReaders,0);
    archive.build=async(...args)=>{calls++;return build(...args);};
    const retry=await runtime.downloadCurrent();assert.equal(calls,2);assert.equal(fs.existsSync(retry.files[0].path),true);retry.cleanup();
  });
  await t.test('real HTTP current and alias callers receive successful ZIPs without tokens from one build',async()=>{
    const engine=require('../lib/engine'),groq=require('../lib/groqShadowProducer'),qwen=require('../lib/alibabaShadowProducer');
    const old={start:runtime.start,auto:engine.shouldAutoResume,g:groq.initialize,q:qwen.initialize};
    runtime.start=()=>{};engine.shouldAutoResume=()=>false;groq.initialize=async()=>({});qwen.initialize=async()=>({});
    const {server,startServer}=require('../server');startServer(0);await new Promise(resolve=>server.once('listening',resolve));
    try {
      const gate=deferred(),entered=deferred();let calls=0;
      archive.build=async(...args)=>{calls++;entered.resolve();await gate.promise;return build(...args);};
      const base='http://127.0.0.1:'+server.address().port;
      const first=fetch(base+'/api/capture/current.zip');await entered.promise;
      const second=fetch(base+'/api/capture/export');
      // Wait until both handlers have entered while the actual build remains gated.
      for(let i=0;i<100&&require('../lib/maintenance').current().active.get('archive:http-reader')!==2;i++)await new Promise(resolve=>setTimeout(resolve,5));
      assert.equal(require('../lib/maintenance').current().active.get('archive:http-reader'),2);assert.equal(calls,1);assert.equal(c.exportReaders,1);
      gate.resolve();const responses=await Promise.all([first,second]);
      const bodies=await Promise.all(responses.map(async response=>{assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/zip');assert.match(response.headers.get('content-disposition'),/orayan-current-30h.zip/);return Buffer.from(await response.arrayBuffer());}));
      assert.deepEqual(bodies[0],bodies[1]);assert.equal(bodies[0].readUInt32LE(),0x04034b50);assert.equal(calls,1);
    } finally {
      await new Promise(resolve=>server.close(resolve));runtime.start=old.start;engine.shouldAutoResume=old.auto;groq.initialize=old.g;qwen.initialize=old.q;
    }
  });
});
test('frontend current export skips prompts, suppresses double click and restores state',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../../frontend/app.js'),'utf8');
  const snippet=source.slice(source.indexOf('let currentResearchDownloadPending='),source.indexOf('let v3ExportGeneration='));
  const gate=deferred(),button={disabled:false,textContent:'CURRENT ~30H RESEARCH ZIP'},health={};let requests=0,clicked=0;
  const context={api:()=>{throw Error('unexpected auth/status request');},prompt:()=>{throw Error('unexpected prompt');},
    $:id=>id==='#btnExportV3'?button:health,fetch:async()=>{requests++;await gate.promise;return {ok:true,blob:async()=>Buffer.from('ZIP')};},
    URL:{createObjectURL:()=> 'blob:test',revokeObjectURL(){}},document:{createElement:()=>({click(){clicked++;}})},setTimeout(){}};
  vm.createContext(context);vm.runInContext(snippet,context);
  const first=context.downloadResearchZip('/api/capture/current.zip');await context.downloadResearchZip('/api/capture/current.zip');
  assert.equal(requests,1);assert.equal(button.disabled,true);assert.match(button.textContent,/Building current research ZIP/);
  gate.resolve();await first;assert.equal(clicked,1);assert.equal(button.disabled,false);assert.equal(button.textContent,'CURRENT ~30H RESEARCH ZIP');
  context.fetch=async()=>{throw Error('network failed');};await context.downloadResearchZip('/api/capture/current.zip');
  assert.equal(button.disabled,false);assert.match(health.textContent,/network failed/);
});
