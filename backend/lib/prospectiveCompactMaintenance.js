'use strict';
const fs=require('fs'),path=require('path'),zlib=require('zlib'),{Readable}=require('stream'),{StringDecoder}=require('string_decoder');
const FILE=/^compact-\d{4}-\d{2}-\d{2}-\d{2}\.jsonl$/;
class CompactMaintenance {
  constructor(dir){this.dir=path.resolve(dir);this.marker=path.join(this.dir,'compact-cohort.json');this.cohort={id:'LEGACY',startedAt:null};
    if(fs.existsSync(this.marker)&&fs.statSync(this.marker).size<4096)try{this.cohort=JSON.parse(fs.readFileSync(this.marker,'utf8'));}catch(_){} }
  files(){if(!fs.existsSync(this.dir))return [];return fs.readdirSync(this.dir).filter(n=>FILE.test(n)).sort().map(n=>{
    const file=path.resolve(this.dir,n),s=fs.lstatSync(file);
    if(path.dirname(file)!==this.dir||!s.isFile()||s.isSymbolicLink())throw Error('UNSAFE_COMPACT_FILE');
    return {path:file,size:s.size};});}
  status(){const files=this.files();return {scope:'prospective_compact_only',cohort:this.cohort,files:files.length,
    sizeBytes:files.reduce((n,f)=>n+f.size,0),retentionHours:48,preserves:['trades','settings','signals','V3 ledgers','episode clocks','pending labels']};}
  reset({scope,expectedCohort},now=Date.now()){
    if(scope!=='prospective_compact_only'||expectedCohort!==this.cohort.id)throw Object.assign(Error('COMPACT_RESET_SCOPE_OR_COHORT_MISMATCH'),{statusCode:409});
    const before=this.status(),files=this.files();
    fs.mkdirSync(this.dir,{recursive:true});
    // Selection is exact and synchronous: only compact hourly archives are retired.
    for(const file of files)fs.unlinkSync(file.path);
    this.cohort={id:'compact-reset-'+now,startedAt:now,removedFiles:before.files,removedBytes:before.sizeBytes};
    const tmp=this.marker+'.tmp';fs.writeFileSync(tmp,JSON.stringify(this.cohort));fs.renameSync(tmp,this.marker);
    return {ok:true,before,after:this.status()};
  }
  download({sinceAt=0,gzip=true},now=Date.now()){
    if(!Number.isFinite(sinceAt)||sinceAt<0||sinceAt>now)throw Object.assign(Error('INVALID_COMPACT_SINCE'),{statusCode:400});
    const files=this.files(),cohort=this.cohort;
    async function* lines(){yield JSON.stringify({recordType:'export_manifest',version:'PROSPECTIVE_COMPACT_V5',captureCohort:cohort,
      sinceAt,watermarkAt:now,selection:'CAPTURE_AT_OR_AT_INCLUSIVE'})+'\n';
      for(const file of files){if(!file.size)continue;const decoder=new StringDecoder('utf8');let carry='';
        for await(const chunk of fs.createReadStream(file.path,{start:0,end:file.size-1,highWaterMark:65536})){
          carry+=decoder.write(chunk);let end;
          while((end=carry.indexOf('\n'))>=0){const line=carry.slice(0,end);carry=carry.slice(end+1);if(!line)continue;
            let row;try{row=JSON.parse(line);}catch(_){yield line+'\n';continue;}
            const at=Number(row.capturedAt??row.at??row.observedAt);if(!Number.isFinite(at)||(at>=sinceAt&&at<=now))yield line+'\n';
          }
          if(carry.length>1048576)throw Error('COMPACT_EXPORT_ROW_TOO_LARGE');
        }
        // Append writes always end in a newline; do not export a concurrent partial row.
      }
    }
    const source=Readable.from(lines());let stream=source;
    if(gzip){stream=zlib.createGzip();source.on('error',e=>stream.destroy(e));stream.on('close',()=>source.destroy());source.pipe(stream);}
    return {__stream:true,stream,contentType:gzip?'application/gzip':'application/x-ndjson',
      filename:`orayan2_prospective_compact_v5_${sinceAt}_${now}.jsonl${gzip?'.gz':''}`,
      headers:{'X-Orayan-Research-Watermark-At':String(now),'X-Orayan-Compact-Cohort':cohort.id}};
  }
}
let instance;
const current=()=>instance||(instance=new CompactMaintenance(path.join(require('./store').DATA_DIR,'research-v2')));
module.exports={CompactMaintenance,current};
