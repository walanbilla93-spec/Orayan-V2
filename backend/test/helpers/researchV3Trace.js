'use strict';
// Qualification recording only. One pending diagnostic write, no sample queue.
const fs=require('node:fs/promises'),path=require('node:path');
const immediate=()=>new Promise(resolve=>setImmediate(resolve));
class Trace {
  static async create(dir,names){const t=new Trace();t.files=new Map();for(const name of names)t.files.set(name,await fs.open(path.join(dir,name),'a'));return t;}
  constructor(){this.pending=null;this.error=null;this.dropped=0;this.written=0;this.maxPending=0;this.maxRecordBytes=0;this.sampleAt=new Map();this.sampleGapMaxMs=0;}
  start(name,row){if(this.pending)throw Error('diagnostic writer busy');const b=Buffer.from(JSON.stringify(row)+'\n');if(b.length>32768)throw Error('diagnostic record cap');const file=this.files.get(name);if(!file)throw Error('unknown diagnostic file');this.maxRecordBytes=Math.max(this.maxRecordBytes,b.length);this.maxPending=1;
    const operation=(async()=>{let off=0;while(off<b.length){const r=await file.write(b,off,b.length-off,null);await immediate();if(!r.bytesWritten)throw Error('short diagnostic write');off+=r.bytesWritten;}this.written++;})();
    const pending=operation.catch(e=>{this.error=e;}).finally(()=>{this.pending=null;});this.pending=pending;return pending;
  }
  sample(name,row){if(this.pending||this.error){this.dropped++;return false;}if(Number.isFinite(row.at)){if(this.sampleAt.has(name))this.sampleGapMaxMs=Math.max(this.sampleGapMaxMs,row.at-this.sampleAt.get(name));this.sampleAt.set(name,row.at);}this.start(name,row);return true;}
  async required(name,row){if(this.pending)await this.pending;if(this.error)throw this.error;await this.start(name,row);if(this.error)throw this.error;}
  stats(){return {written:this.written,droppedSamples:this.dropped,maxPending:this.maxPending,maxRecordBytes:this.maxRecordBytes,sampleGapMaxMs:this.sampleGapMaxMs};}
  async close(){if(this.pending)await this.pending;for(const file of this.files.values()){await file.close();await immediate();}if(this.error)throw this.error;}
}
module.exports={Trace};
