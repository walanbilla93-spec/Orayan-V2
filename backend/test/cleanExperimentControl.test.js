'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('node:vm');
const root=path.resolve(__dirname,'../..'),app=fs.readFileSync(path.join(root,'frontend/app.js'),'utf8'),html=fs.readFileSync(path.join(root,'frontend/index.html'),'utf8');
function ui({confirmValue=true,response={ok:true,epochId:'NEW',historicalResearchPreserved:true},pending}={}) {
 const button={disabled:false},state={signals:['S'],funnel:{count:1},trades:['T'],shadowTrades:['M']},calls=[],messages=[];let handler;
 const context={$:()=>({...button,addEventListener:(_,h)=>handler=h}),state,confirm:message=>{messages.push(message);return confirmValue;},api:async(url,options)=>{calls.push({url,...options});return pending?pending:response;},toast:message=>messages.push(message),refresh:async()=>{},loadV3Status:async()=>{}};
 context.$=()=>Object.assign(button,{addEventListener:(_,h)=>handler=h});
 const start=app.indexOf("  $('#btnResetResearch').addEventListener('click'");const end=app.indexOf("  $('#btnClearSignals')",start);
 vm.runInNewContext(app.slice(start,end),context);return {handler,button,state,calls,messages};
}
test('one control is in the canonical Research panel and is not hidden as dormant',()=>{
 assert.equal((html.match(/id="btnResetResearch"/g)||[]).length,1);
 const panel=html.slice(html.indexOf('<div id="minimalCapturePanel"'),html.indexOf('<div id="legacyResearchPanel"'));
 assert.match(panel,/id="btnResetResearch"/);
 const dormant=app.slice(app.indexOf('function hideDormantResearch'),app.indexOf('async function initializeCaptureView'));
 assert.doesNotMatch(dormant,/btnResetResearch/);assert.doesNotMatch(panel,/Clear signal log/);
});
test('confirmed action calls only the existing epoch endpoint and preserves displayed history',async()=>{
 const x=ui(),before=JSON.stringify(x.state);await x.handler();assert.deepEqual(x.calls,[{url:'/api/research/reset-all',method:'POST'}]);assert.equal(JSON.stringify(x.state),before);assert.match(x.messages[0],/records, archives and trades are preserved/);assert.match(x.messages[1],/history preserved/);assert.equal(x.button.disabled,false);
});
test('cancel leaves the epoch and history untouched',async()=>{const x=ui({confirmValue:false});await x.handler();assert.equal(x.calls.length,0);});
test('pending action blocks duplicate requests',async()=>{let resolve;const pending=new Promise(r=>resolve=r),x=ui({pending});const first=x.handler();await x.handler();assert.equal(x.calls.length,1);assert.equal(x.button.disabled,true);resolve({ok:true,epochId:'NEW',historicalResearchPreserved:true});await first;assert.equal(x.button.disabled,false);});
test('unverified response never reports a successful clean experiment',async()=>{const x=ui({response:{ok:true}});await x.handler();assert.match(x.messages[1],/Could not verify/);assert.equal(x.button.disabled,false);});
test('existing backend action delegates only to epoch and remains maintenance fenced',()=>{
 const routes=fs.readFileSync(path.join(root,'backend/routes/api.js'),'utf8'),start=routes.indexOf("  'POST /api/research/reset-all'");const action=routes.slice(start,routes.indexOf("  'POST /api/control/clear-cache'",start));
 assert.match(action,/researchRuntime.*current\(\)\.epoch\(\)/);assert.match(action,/historicalResearchPreserved:true/);assert.doesNotMatch(action,/unlink|rmSync|resetTrades|resetShadow|clearSignal|settings|budget/);assert.match(routes,/maintenance\.current\(\)\.assertStart\('operator mutation'\)/);
});
