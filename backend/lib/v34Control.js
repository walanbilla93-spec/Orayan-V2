'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const files=['v3Contracts.js','v3Levels.js','v3Geometry.js','v3Trades.js','signals_trend_v30.js','v3Benchmark.json'];
const digest=files=>crypto.createHash('sha256').update(files.map(f=>f+'\n'+fs.readFileSync(path.join(__dirname,f),'utf8').replace(/\r\n/g,'\n')).join('\n')).digest('hex');
const shadow=fs.readFileSync(path.join(__dirname,'v3Shadow.js'),'utf8').replace(/\r\n/g,'\n');
const decisionSource=shadow.slice(shadow.indexOf('function evaluate('),shadow.indexOf('\n\nclass ShadowJournal'));
const decisionFingerprint=crypto.createHash('sha256').update(decisionSource).digest('hex');
module.exports={version:'V3.3_STRUCTURAL_MARKET_NEXT_MINUTE_V1',baselineCommit:'1b15cc5bebd48e4dc739e051254e36ed6dc7469e',
  fingerprint:crypto.createHash('sha256').update(digest(files)+decisionFingerprint).digest('hex'),coreFingerprint:digest(files),decisionFingerprint,
  files,executionAllowed:false,v2Benchmark:require('./v3Benchmark.json').benchmarkCommit,
  measurementVersion:'V3.4A_MEASUREMENT_V1'};
