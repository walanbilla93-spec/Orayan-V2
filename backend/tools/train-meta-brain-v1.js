'use strict';
// Explicit offline development fit. Never imported by the server; no model selection.
const fs=require('fs'),readline=require('readline');
const {FEATURES,CONTRACT,hash,validate}=require('../lib/metaBrainV1');
async function train(file,cutoff,output){
 const end=Date.parse(cutoff);if(!Number.isFinite(end))throw Error('TRAINING_CUTOFF_REQUIRED');
 if(fs.existsSync(output))throw Error('OUTPUT_EXISTS');
 if(fs.statSync(file).size>16*1024*1024)throw Error('CURRICULUM_SIZE_LIMIT');
 const rows=[],seen=new Set();
 for await(const line of readline.createInterface({input:fs.createReadStream(file),crlfDelay:Infinity})){
  if(!line.trim())continue;const r=JSON.parse(line),born=Date.parse(r.birth_cutoff);
  if(r.contract!==CONTRACT||!r.episode_id||seen.has(r.episode_id)||!Number.isFinite(born)||
    !Number.isFinite(r.resolved_at)||!Number.isFinite(r.available_at)||!(born<=r.resolved_at&&r.resolved_at<=r.available_at)||
    r.available_at>=end||!Number.isFinite(r.realized_r)||!FEATURES.every(k=>typeof r.values?.[k]==='number'&&Number.isFinite(r.values[k])))throw Error('INVALID_OR_FUTURE_CURRICULUM_ROW');
  seen.add(r.episode_id);rows.push({x:FEATURES.map(k=>r.values[k]),y:r.realized_r>0?1:0});
  if(rows.length>20000)throw Error('CURRICULUM_ROW_LIMIT');
 }
 if(rows.length<20||!rows.some(x=>x.y===1)||!rows.some(x=>x.y===0))throw Error('INSUFFICIENT_DEVELOPMENT_CURRICULUM');
 const means=FEATURES.map((_,i)=>rows.reduce((n,r)=>n+r.x[i],0)/rows.length);
 const scales=FEATURES.map((_,i)=>Math.sqrt(rows.reduce((n,r)=>n+(r.x[i]-means[i])**2,0)/rows.length)||1);
 const xs=rows.map(r=>({...r,x:r.x.map((v,i)=>(v-means[i])/scales[i])}));
 const weights=FEATURES.map(()=>0);let bias=0;
 for(let epoch=0;epoch<500;epoch++){
  const dw=FEATURES.map(()=>0);let db=0;
  for(const r of xs){const z=bias+r.x.reduce((n,x,i)=>n+x*weights[i],0),e=1/(1+Math.exp(-Math.max(-40,Math.min(40,z))))-r.y;db+=e;r.x.forEach((x,i)=>dw[i]+=e*x);}
  weights.forEach((_,i)=>weights[i]-=0.05*(dw[i]/xs.length+0.01*weights[i]));bias-=0.05*db/xs.length;
 }
 const body={contract:CONTRACT,features:FEATURES,training_status:'DEVELOPMENT_TRAINED',execution_authority:'NONE',training_cutoff:new Date(end).toISOString(),
  curriculum_sha256:require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex'),samples:rows.length,
  procedure:'FIXED_LOGISTIC_GD_500_L2_0.01_LR_0.05_V1',weights,bias,means,scales,retain_threshold:0.6,skip_threshold:0.4};
 const model={...body,model_id:hash(body)};validate(model);fs.writeFileSync(output,JSON.stringify(model,null,2)+'\n',{flag:'wx'});return model;
}
if(require.main===module)train(...process.argv.slice(2)).then(m=>console.log(JSON.stringify({model_id:m.model_id,samples:m.samples,training_status:m.training_status}))).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={train};
