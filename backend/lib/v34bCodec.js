'use strict';
const crypto=require('crypto');
const SCHEMA='V3_LOSSLESS_REFERENCES_V2';
const clone=x=>JSON.parse(JSON.stringify(x));
const digest=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const logicalDigest=x=>digest(canonical(x));
// Each reference is a complete immutable JSON value. Clocks, prices and floating
// point values are kept exactly as serialized; no rounding or lossy MARK projection.
function encode(input,context) {
  const row=clone(input),definitions=[];
  const visit=(value)=>{
    if(typeof value==='string'&&Buffer.byteLength(value)>16000){
      const parts=[];for(let i=0;i<value.length;i+=4000)parts.push(value.slice(i,i+4000));
      return {$v34bStringParts:parts.map(payload=>{const referenceId=digest(payload);
        definitions.push({outputType:'V3_IMMUTABLE_PAYLOAD',referenceId,payload,capturedAt:row.capturedAt,captureSchema:SCHEMA});
        return {$v34bRef:referenceId};})};
    }
    if(!value||typeof value!=='object')return value;
    const nested=Array.isArray(value)?value.map(visit):Object.fromEntries(Object.entries(value).map(([k,v])=>[k,visit(v)]));
    if(Array.isArray(nested)&&Buffer.byteLength(JSON.stringify(nested))>24000){
      const parts=[];for(let i=0;i<nested.length;i+=32)parts.push(visit(nested.slice(i,i+32)));
      return {$v34bArray:parts};
    }
    if(Buffer.byteLength(JSON.stringify(nested))>=512) {
      const referenceId=digest(nested);
      definitions.push({outputType:'V3_IMMUTABLE_PAYLOAD',referenceId,payload:nested,
        capturedAt:row.capturedAt,captureSchema:SCHEMA});
      return {$v34bRef:referenceId};
    }
    return nested;
  };
  if(context){
    const original=clone(row),referenceId=logicalDigest(original),prior=context.previous;
    if(prior&&referenceId!==prior.referenceId){
      const changes=[],removed=[];
      const diff=(before,after,keys=[])=>{
        if(JSON.stringify(before)===JSON.stringify(after))return;
        if(before&&after&&typeof before==='object'&&typeof after==='object'&&Array.isArray(before)===Array.isArray(after)&&
          (!Array.isArray(after)||before.length===after.length)){
          for(const key of Object.keys(before))if(!Object.hasOwn(after,key))removed.push([...keys,key]);
          for(const key of Object.keys(after))if(Object.hasOwn(before,key))diff(before[key],after[key],[...keys,key]);
            else changes.push([[...keys,key],visit(after[key])]);
        }else changes.push([keys,visit(after)]);
      };
      diff(prior.row,original);
      definitions.push({outputType:'V3_IMMUTABLE_PAYLOAD',referenceId,logicalDigest:true,
        delta:{base:prior.referenceId,changes,removed},capturedAt:row.capturedAt,captureSchema:SCHEMA});
    }else if(!prior){
      const full=encode(original);definitions.push(...full.definitions);
      const payload={...full.row};if(!Object.hasOwn(original,'captureSchema'))delete payload.captureSchema;
      definitions.push({outputType:'V3_IMMUTABLE_PAYLOAD',referenceId,logicalDigest:true,payload,
        capturedAt:row.capturedAt,captureSchema:SCHEMA});
    }
    context.next={row:original,referenceId};
    const root=definitions.at(-1)?.referenceId===referenceId?definitions.pop():null;
    const payload=root&&(root.delta?{delta:root.delta}:{payload:root.payload});
    if(payload&&Buffer.byteLength(JSON.stringify(payload))>6000){
      if(root.delta){delete payload.delta;payload.deltaRef=visit(root.delta);}
      else{delete payload.payload;payload.payloadRef=visit(root.payload);}
    }
    const record=root?{$v34bRecord:{referenceId,...payload}}:{$v34bRowRef:referenceId};
    return {row:{outputType:original.outputType,capturedAt:original.capturedAt,captureSchema:SCHEMA,...record},
      definitions:[...new Map(definitions.map(d=>[d.referenceId,d])).values()]};
  }
  for(const key of Object.keys(row).filter(k=>!['captureSchema','outputType','kind'].includes(k)))
    if(row[key]!==undefined)row[key]=visit(row[key]);
  row.captureSchema=SCHEMA;
  return {row,definitions:[...new Map(definitions.map(d=>[d.referenceId,d])).values()]};
}
class Decoder {
  constructor(){this.refs=new Map();this.cache=new Map();}
  resolve(id){
    if(this.cache.has(id))return clone(this.cache.get(id));
    const d=this.refs.get(id);if(!d)throw Error('UNRESOLVED_REFERENCE');
    let value;
    const delta=d.deltaRef?this.visit(d.deltaRef):d.delta;
    if(delta){value=this.resolve(delta.base);
      for(const keys of delta.removed){const parent=keys.slice(0,-1).reduce((v,k)=>v[k],value);delete parent[keys.at(-1)];}
      for(const [keys,patch] of delta.changes){const next=this.visit(patch);
        if(!keys.length)value=next;
        else{const parent=keys.slice(0,-1).reduce((v,k)=>v[k],value);Object.defineProperty(parent,keys.at(-1),{value:next,writable:true,enumerable:true,configurable:true});}
      }
    }else value=d.payloadRef?this.visit(d.payloadRef):this.visit(clone(d.payload));
    if(d.logicalDigest&&logicalDigest(value)!==id)throw Error('REFERENCE_HASH_MISMATCH');
    this.cache.set(id,value);while(this.cache.size>512)this.cache.delete(this.cache.keys().next().value);
    return clone(value);
  }
  visit(v){
    if(!v||typeof v!=='object')return v;
    if(v.$v34bStringParts)return v.$v34bStringParts.map(x=>this.visit(x)).join('');
    if(v.$v34bArray)return v.$v34bArray.flatMap(x=>this.visit(x));
    if(v.$v34bRef)return this.resolve(v.$v34bRef);
    if(v.$v34bRecord){const d=v.$v34bRecord;this.refs.set(d.referenceId,{...d,logicalDigest:true});
      const metadata={...v};delete metadata.$v34bRecord;return {...this.resolve(d.referenceId),...metadata};}
    if(v.$v34bRowRef){const metadata={...v};delete metadata.$v34bRowRef;return {...this.resolve(v.$v34bRowRef),...metadata};}
    return Array.isArray(v)?v.map(x=>this.visit(x)):Object.fromEntries(Object.entries(v).map(([k,x])=>[k,this.visit(x)]));
  }
  row(r){if(r.outputType==='V3_IMMUTABLE_PAYLOAD'){
    if(!r.logicalDigest&&digest(r.payload)!==r.referenceId)throw Error('REFERENCE_HASH_MISMATCH');
    this.refs.set(r.referenceId,r);return null;
  }return this.visit(r);}
}
function decode(rows) {
  const decoder=new Decoder(),out=[];
  for(const r of rows){const row=decoder.row(r);if(row)out.push(row);}
  return out;
}
module.exports={SCHEMA,encode,decode,digest,Decoder};
