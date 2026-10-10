"use strict";
const fs=require('fs'),payload=require('../lib/researchPayload');
const report={method:'Exact serialized UTF-8 request bytes; estimated input tokens = ceil(bytes/3.5), same pre-existing budget proxy. Not provider billing or a calibrated tokenizer.',providerBilledTokenReduction:null,fixtures:[]};
for(const provider of ['groq','alibaba']) {
 const a=require('../../research/'+provider+'-shadow/src/advisor'),schema=require('../../research/'+provider+'-shadow/src/constants').RESPONSE_SCHEMA;
 const s=require('../test/fixtures/'+provider+'Candidate')(),config=a.configFromEnv({});
 const before=a.buildLegacyRequest(s,config),after=payload.build(before,s,schema);
 const oldBytes=Buffer.byteLength(JSON.stringify(before)),newBytes=Buffer.byteLength(JSON.stringify(after));
 report.fixtures.push({provider,model:config.model,oldBytes,newBytes,byteReductionPercent:100*(oldBytes-newBytes)/oldBytes,oldEstimatedInputTokens:Math.ceil(oldBytes/3.5),newEstimatedInputTokens:Math.ceil(newBytes/3.5),estimatedInputTokenReductionPercent:100*(Math.ceil(oldBytes/3.5)-Math.ceil(newBytes/3.5))/Math.ceil(oldBytes/3.5)});
}
fs.writeFileSync(process.argv[2],JSON.stringify(report,null,2));
