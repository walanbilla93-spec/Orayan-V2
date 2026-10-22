'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),vm=require('vm');
const {execFileSync}=require('child_process');
test('clean V3 HTTP status and epoch download preserve all evidence without reading V2',async t=>{
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'v3-download-test-')),root=path.join(parent,'data');
  execFileSync(process.execPath,[path.join(__dirname,'../tools/research-v3-clean-fixture.js'),root]);
  const store=require('../lib/store');store.DATA_DIR=root;
  process.env.GROQ_SHADOW_EXPORT_TOKEN='fixture-export-token';process.env.RESEARCH_STORE_BACKEND='v3';process.env.GROQ_SHADOW_ENABLED='false';process.env.ALIBABA_SHADOW_ENABLED='false';
  const runtime=require('../lib/researchRuntime'),c=runtime.current(),epoch=c.state.epochId;
  // Births older than 30h must still be available in the active clean epoch.
  c.emit('decisions',{sourceEpisodeId:'new-native',boundary:'BIRTH',mode:'PAPER',admission:'ELIGIBLE',meta_lite:{result:'PASS'},at:Date.now()-40*3600000});
  c.emit('lifecycle',{sourceEpisodeId:'new-native',tradeId:'paper',status:'OPEN',mode:'PAPER',excursion:{mfeR:1.2,maeR:-0.2}});
  for(const provider of ['Groq','Alibaba'])c.emit('ai_calls',{sourceEpisodeId:'new-native',provider,event:'PARSED_RESPONSE',assignment:provider==='Groq'?'BASE':'FEEDBACK',decision:'REJECT'});
  c.emit('outcomes',{sourceEpisodeId:'new-native',tradeId:'paper',status:'CLOSED',mode:'PAPER',outcomeComplete:true});
  const supplemental={
    'feedback-memory/feedback-test.json':JSON.stringify({source_epoch:epoch,lesson:'EPOCH_LESSON'}),
    'prospective-native/native.jsonl':'{"birth":"EPOCH_NATIVE"}\n',
    'shadow-operational/shadow.jsonl':'{"shadow":"EPOCH_SHADOW"}\n'
  };
  for(const [name,body]of Object.entries(supplemental)){fs.mkdirSync(path.dirname(path.join(c.dir,name)),{recursive:true});fs.writeFileSync(path.join(c.dir,name),body);}
  fs.mkdirSync(path.join(root,'meta-brain-v1-evidence'),{recursive:true});fs.writeFileSync(path.join(root,'meta-brain-v1-evidence','old.json'),'OLD_V2_SECRET');
  const open=fs.openSync;let oldReads=0;
  fs.openSync=function(file,...args){if(typeof file==='string'&&['research-canonical-v2','meta-brain-v1-evidence','research-v2','v3-shadow-compact-v1'].some(n=>file.startsWith(path.join(root,n)+path.sep))){oldReads++;throw Error('OLD_HISTORY_FORBIDDEN');}return open.call(this,file,...args);};
  const {server,startServer}=require('../server');startServer(0);await new Promise(r=>server.once('listening',r));
  t.after(async()=>{fs.openSync=open;await new Promise(r=>server.close(r));await runtime.close();fs.rmSync(parent,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+server.address().port;
  const status=await (await fetch(base+'/api/capture/status')).json();
  assert.equal(status.epochId,epoch);assert.equal(status.captureSchema,'ORAYAN_RESEARCH_V3');assert.equal(status.downloadAvailable,true);
  assert.equal(status.liveStructures,undefined);assert.equal(status.startupMemory,undefined);assert.equal(status.memory.structures,undefined);
  assert.equal((await (await fetch(base+'/api/v3/status')).json()).archive.epochId,epoch);
  assert.ok(Array.isArray(await (await fetch(base+'/api/capture/archives')).json()));
  assert.equal((await fetch(base+'/api/capture/current.zip')).status,401);
  const response=await fetch(base+'/api/capture/current.zip',{headers:{'X-Groq-Shadow-Export-Token':'fixture-export-token'}});assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),new RegExp(epoch));
  const file=path.join(parent,'download.zip');await require('stream/promises').pipeline(require('stream').Readable.fromWeb(response.body),fs.createWriteStream(file));
  const archive=require('../lib/researchArchive'),m=await archive.verify(file);
  assert.equal(m.epoch.epochId,epoch);assert.equal(m.epoch.cleanProspectiveExperiment,true);assert.ok(m.counts.decisions>=1);assert.ok(m.counts.ai_calls>=2);assert.ok(m.counts.outcomes>=1);
  const recovered={};let current;
  await archive.zipEntries(file,async(name,s)=>{if(name!=='epoch-evidence.jsonl'){s.resume();return;}for await(const row of archive.lines(s)){
    if(row.type==='file'){current=row.path;recovered[current]='';}
    if(row.type==='chunk')recovered[current]+=Buffer.from(row.data,'base64').toString();
  }});
  for(const [name,body]of Object.entries(supplemental))assert.equal(recovered[name],body);
  assert.ok(!JSON.stringify(recovered).includes('OLD_V2_SECRET'));assert.equal(oldReads,0);assert.equal(c.enumerationAttempts,0);assert.equal(c.memory().structures.historyDictionaries.count,0);
  assert.equal(c.state.epochId,epoch);assert.equal(c.status().health,'HEALTHY');
  console.log(JSON.stringify({downloadBytes:fs.statSync(file).size,rss:process.memoryUsage().rss,heapUsed:process.memoryUsage().heapUsed}));
});
test('frontend V3 status bypasses incompatible shadow status and routes download to canonical ZIP',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../../frontend/app.js'),'utf8'),nodes=new Map();
  const $=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',hidden:false,disabled:false});return nodes.get(id);};
  const calls=[],cap={schemaVersion:'ORAYAN_RESEARCH_V3',epochId:'clean',populationComplete:true,health:'HEALTHY',downloadAvailable:true,archives:[]};
  const context=vm.createContext({$,api:async url=>{calls.push(url);if(url==='/api/capture/status')return cap;throw Error('LEGACY_API_FORBIDDEN');},document:{getElementById:()=>({})},fmtDate:String,fmtBytes:String,esc:String,fmt:String,currentResearchDownloadPending:false,v3FrozenStatus:null,downloadResearchZip:async url=>calls.push(url)});
  vm.runInContext(source.slice(source.indexOf('function hideDormantResearch'),source.indexOf('\nfunction toast')),context);
  await context.loadV3Status();assert.equal($('#captureHealth').textContent,'Capture healthy');assert.equal($('#btnExportV3').disabled,false);assert.equal($('#btnExportV3').textContent,'DOWNLOAD RESEARCH DATA');assert.deepEqual(calls,['/api/capture/status']);
  vm.runInContext(source.slice(source.indexOf('async function downloadV3('),source.indexOf('function hideDormantResearch')),context);await context.downloadV3();assert.equal(calls.at(-1),'/api/capture/current.zip');
});
