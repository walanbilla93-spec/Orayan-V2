'use strict';
// Remove only reviewed capture-policy plumbing. All decision/execution text still has
// to match the existing frozen baseline, and behavior is separately tested below.
module.exports=function(source,file){let s=source.replace(/\r\n/g,'\n');
 if(file==='snapshot.js')s=s.replace(/  if\(decision\.missing_useful_data!==undefined.*?errors\.push\('missing_useful_data:invalid'\);\n/,'');
 if(file==='executor.js')s=s.replace('async function stepPaperTrade(trade, settings, observeMinute) {','async function stepPaperTrade(trade, settings) {').replace('    try { if(observeMinute)observeMinute(trade,c); } catch (_) { /* Observation cannot alter execution. */ }\n','');
 if(['groqShadowProducer.js','alibabaShadowProducer.js'].includes(file))s=s.replace("const minimal=require('./minimalCapture');\n\n",'').replace('  if(minimal.enabled())return null;\n','');
 if(file==='engine.js'){
  s=s.replaceAll(", require('./researchExcursions').observeMinute",'');
  s=s.replace("        if (!require('./researchRuntime').canAdmit(settings.mode)) break;\n",'')
    .replace("        if (!require('./researchRuntime').canAdmit(settings.mode)) break;\n",'')
    .replaceAll("        if (!require('./researchRuntime').canAdmit('SHADOW')) break;\n",'')
    .replace("    researchCapture: require('./minimalCapture').enabled() ? require('./researchRuntime').status() : {enabled:false},\n",'');
  s=s.replace("const captureSafety=store.read('captureSafetyClosed', {total:0,closed:[]});\nfunction closedForSafety(){return [...captureSafety.closed.map(x=>({closedAt:x.closedAt,netPnl:x.netPnl})),...closedTrades()];}\n",'');
  s=s.replace("  if(captureSafety.total){const keep=Math.max(0,5000-trades.length),cutoff=Math.max(0,captureSafety.total-keep);\n    store.write('captureSafetyClosed',{total:Math.min(captureSafety.total,keep),closed:captureSafety.closed.filter(x=>x.index>=cutoff).map(x=>({...x,index:x.index-cutoff}))},false);}\n",'');
  s=s.replace('closedTrades: closedForSafety()','closedTrades: closedTrades()');
 }return s;
};
