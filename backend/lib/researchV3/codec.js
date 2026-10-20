'use strict';
const crypto = require('node:crypto');
const FAMILIES = Object.freeze(['E','D','P','S','N','A','O','X','C','V']);
// Closed wire tags. Changing any tag requires a new codec version and fixtures.
const KINDS = Object.freeze({record:1, child:2, ordinal:3, bucket:4, aggregate:5, membership:6, summary:7});
const MAX_KEY = 64 * 1024, MAX_VALUE = 1024 * 1024;
function fail(message = 'invalid index bytes') {
  const e = new Error(message); e.code = 'INDEX_INTEGRITY_FAILED'; throw e;
}
function integer(n, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(n) || n < 0 || n > max) fail('unsafe integer');
  return n;
}
function u64(n) { const b=Buffer.alloc(8); b.writeBigUInt64LE(BigInt(integer(n))); return b; }
function from64(b, offset=0) {
  const n=b.readBigUInt64LE(offset); if(n>BigInt(Number.MAX_SAFE_INTEGER)) fail('unrepresentable offset'); return Number(n);
}
function sha(...parts) { const h=crypto.createHash('sha256'); for(const p of parts) h.update(p); return h.digest(); }
// Tuple components are original JS UTF-16 code units, including lone surrogates.
// UTF-8 replacement would conflate two distinct legacy keys.
function key(family, kind, components) {
  if(!FAMILIES.includes(family) || !KINDS[kind] || !Array.isArray(components) || components.length>255) fail('key enum');
  let size=4; const encoded=components.map(s=>{
    if(typeof s!=='string') fail('key component must be a string');
    const b=Buffer.from(s,'utf16le'); size+=4+b.length; return b;
  });
  integer(size,MAX_KEY); const b=Buffer.alloc(size); b[0]=1; b[1]=family.charCodeAt(0); b[2]=KINDS[kind]; b[3]=encoded.length;
  let off=4; for(const s of encoded){ b.writeUInt32LE(s.length,off); s.copy(b,off+4); off+=4+s.length; } return b;
}
function validateKey(b, family) {
  if(!Buffer.isBuffer(b)||b.length<4||b.length>MAX_KEY||b[0]!==1||String.fromCharCode(b[1])!==family||!Object.values(KINDS).includes(b[2])) fail('invalid tuple');
  let off=4; for(let i=0;i<b[3];i++){if(off+4>b.length) fail(); const n=b.readUInt32LE(off); off+=4; if(n%2||n>b.length-off)fail(); off+=n;}
  if(off!==b.length)fail(); return b;
}
function compare(a,b) { return Buffer.compare(a.digest,b.digest)||Buffer.compare(a.key,b.key); }
function record(k,value,lsn,flags=0,digest=sha(k)) {
  if(!Buffer.isBuffer(k)||!Buffer.isBuffer(value)||value.length>MAX_VALUE||digest.length!==32||![0,1,2].includes(flags))fail('record bounds');
  validateKey(k,String.fromCharCode(k[1])); integer(lsn);
  return {key:k,value,lsn,flags,digest};
}
module.exports={FAMILIES,KINDS,MAX_KEY,MAX_VALUE,fail,integer,u64,from64,sha,key,validateKey,compare,record};
