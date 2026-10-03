'use strict';
const fs=require('fs'),{Readable}=require('stream');
// One response pipeline for the complete watermark. Per-file pipelines leave
// response listeners behind and grow with the number of archive blocks.
function fileStream(files){return Readable.from((async function*(){
  for(const item of files){const file=typeof item==='string'?{path:item,size:fs.statSync(item).size}:item;
    if(file.size)yield*fs.createReadStream(file.path,{start:0,end:file.size-1});
  }
})());}
module.exports={fileStream};
