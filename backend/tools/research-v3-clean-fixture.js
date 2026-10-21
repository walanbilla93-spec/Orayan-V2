'use strict';
const fs=require('fs'),path=require('path');
async function main(){const root=path.resolve(process.argv[2]);if(fs.existsSync(root))throw Error('NEW_FIXTURE_DIRECTORY_REQUIRED');fs.mkdirSync(root,{recursive:true});
 const {ResearchStore}=require('../lib/researchStore'),c=new ResearchStore(path.join(root,'research-canonical-v2'),{reserveBytes:0,admissionHeadroom:0});
 c.emit('decisions',{sourceEpisodeId:'old-completed',admission:'REJECT'});c.emit('decisions',{sourceEpisodeId:'still-open',admission:'ELIGIBLE'});c.emit('lifecycle',{sourceEpisodeId:'still-open',tradeId:'working',status:'OPEN',excursion:{mfeR:2,maeR:-1}});c.flush();
 fs.writeFileSync(path.join(root,'trades.json'),JSON.stringify([{id:'working',episodeId:'still-open',mode:'paper',status:'OPEN',symbol:'TESTUSDT',side:'BUY'}]));
 fs.writeFileSync(path.join(root,'engineControl.json'),JSON.stringify({desiredRunning:false}));fs.writeFileSync(path.join(root,'research-capture-policy.json'),'{}');
 process.env.ORAYAN_V3_OFFLINE='true';try{await require('../lib/researchV3Migration').migrate(root,{afterStep:s=>{if(s==='stage:2')throw Error('FIXTURE_STOP');}});}catch(e){if(e.message!=='FIXTURE_STOP')throw e;}
 require('../lib/researchV3Abandon').audit(root);const clean=require('../lib/researchV3CleanEpoch'),r=await clean.prepare(root);require('../lib/researchV3Abandon').remove(root);clean.publish(root);require('../lib/researchV3Activation').activate(root);console.log(JSON.stringify({epochId:r.epochId,obligations:r.obligations,root}));}
if(require.main===module)main().catch(e=>{console.error(e.stack);process.exitCode=1;});module.exports={main};
