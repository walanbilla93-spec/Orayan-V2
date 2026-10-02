'use strict';
const crypto=require('crypto');
const SCHEMA='V3_LOSSLESS_REFERENCES_V2';
const clone=x=>JSON.parse(JSON.stringify(x));
const digest=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
// Each reference is a complete immutable JSON value. Clocks, prices and floating
// point values are kept exactly as serialized; no rounding or lossy MARK projection.
function encode(input) {
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
  for(const key of Object.keys(row).filter(k=>!['captureSchema','outputType','kind'].includes(k)))
    if(row[key]!==undefined)row[key]=visit(row[key]);
  row.captureSchema=SCHEMA;
  return {row,definitions:[...new Map(definitions.map(d=>[d.referenceId,d])).values()]};
}
function decode(rows) {
  const refs=new Map(),out=[];
  const visit=v=>{
    if(!v||typeof v!=='object')return v;
    if(v.$v34bStringParts)return v.$v34bStringParts.map(visit).join('');
    if(v.$v34bArray)return v.$v34bArray.flatMap(visit);
    if(v.$v34bRef){if(!refs.has(v.$v34bRef))throw Error('UNRESOLVED_REFERENCE');return visit(clone(refs.get(v.$v34bRef)));}
    return Array.isArray(v)?v.map(visit):Object.fromEntries(Object.entries(v).map(([k,x])=>[k,visit(x)]));
  };
  for(const r of rows)if(r.outputType==='V3_IMMUTABLE_PAYLOAD'){
    if(digest(r.payload)!==r.referenceId)throw Error('REFERENCE_HASH_MISMATCH');refs.set(r.referenceId,r.payload);
  }else out.push(visit(r));
  return out;
}
module.exports={SCHEMA,encode,decode,digest};
