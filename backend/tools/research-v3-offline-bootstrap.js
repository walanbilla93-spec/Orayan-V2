'use strict';
// This file is packed with only the primitive/test sources for the isolated job.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),zlib=require('node:zlib'),crypto=require('node:crypto');
const root='/tmp/researchstore-v3-qualification';fs.mkdirSync(root);process.chdir(root);
const files=JSON.parse(zlib.gunzipSync(Buffer.from('__BUNDLE__','base64')));
for(const [name,content]of Object.entries(files)){fs.mkdirSync(path.dirname(name),{recursive:true});fs.writeFileSync(name,content);}
fs.mkdirSync('artifacts');fs.writeFileSync('artifacts/source-hashes.json',JSON.stringify(Object.fromEntries(Object.entries(files).map(([name,body])=>[name,crypto.createHash('sha256').update(body).digest('hex')])),null,2));
fs.writeFileSync('artifacts/platform.json',JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,os:fs.readFileSync('/etc/os-release','utf8'),cpu:fs.readFileSync('/sys/fs/cgroup/cpu.max','utf8'),memory:fs.readFileSync('/sys/fs/cgroup/memory.max','utf8')},null,2));
const tests=cp.spawnSync(process.execPath,['--max-old-space-size=352','--test','backend/test/researchV3Primitive.test.js'],{encoding:'utf8'});fs.writeFileSync('artifacts/primitive-tests.txt',tests.stdout+'\n'+tests.stderr);console.log('V3_TEST_EXIT',tests.status);console.log(tests.stdout);
if(tests.status===0){
 const child=cp.spawn(process.execPath,['--max-old-space-size=352','backend/tools/research-v3-benchmark.js','scratch'],{stdio:'inherit'});
 const fd=fs.openSync('artifacts/kernel-samples.jsonl','wx');
 const timer=setInterval(()=>{try{const status=fs.readFileSync('/proc/'+child.pid+'/status','utf8'),memory=fs.readFileSync('/sys/fs/cgroup/memory.current','utf8').trim(),peak=fs.readFileSync('/sys/fs/cgroup/memory.peak','utf8').trim();fs.writeSync(fd,JSON.stringify({at:Date.now(),rssKiB:Number(status.match(/VmRSS:\s+(\d+)/)?.[1]||0),hwmKiB:Number(status.match(/VmHWM:\s+(\d+)/)?.[1]||0),cgroupCurrent:memory,cgroupPeak:peak})+'\n');}catch{}},50);
 child.on('exit',(code,signal)=>{clearInterval(timer);fs.closeSync(fd);fs.writeFileSync('artifacts/exit.json',JSON.stringify({code,signal}));finish();});
}else finish();
function finish(){const out={};for(const name of ['source-hashes.json','platform.json','primitive-tests.txt','kernel-samples.jsonl','exit.json'])if(fs.existsSync('artifacts/'+name))out[name]=fs.readFileSync('artifacts/'+name,'utf8');for(const name of ['results.json','identity.json','memory.jsonl'])if(fs.existsSync('scratch/'+name))out[name]=fs.readFileSync('scratch/'+name,'utf8');const bytes=zlib.gzipSync(Buffer.from(JSON.stringify(out))),base64=bytes.toString('base64');fs.writeFileSync('artifacts-bundle.json.gz',bytes);console.log('V3_BUNDLE_SHA256',crypto.createHash('sha256').update(bytes).digest('hex'));for(let i=0;i<base64.length;i+=500)console.log('V3_BUNDLE_'+String(i/500).padStart(5,'0')+' '+base64.slice(i,i+500));console.log('V3_BUNDLE_COMPLETE',base64.length);}
