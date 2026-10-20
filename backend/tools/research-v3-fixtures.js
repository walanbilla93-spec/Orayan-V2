'use strict';
// Independent wire fixture generator: does not import implementation modules.
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
const hash=(...xs)=>{const h=crypto.createHash('sha256');for(const x of xs)h.update(x);return h.digest('hex');};
const u=n=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;};
const tag=Buffer.from('RSV3PAGE'),tuple='014401020200000061000200000000d8',k=Buffer.from('01440101020000006100','hex'),s=Buffer.alloc(80);
Buffer.from(hash(k),'hex').copy(s);u(5).copy(s,32);u(k.length).copy(s,40);u(5+k.length).copy(s,48);u(1).copy(s,56);u(19).copy(s,64);
const fixture={version:1,tuple,leaf:hash(tag,Buffer.from([1,1]),u(3),u(3),Buffer.from('abc')),parent:hash(tag,Buffer.from([2]),Buffer.alloc(32,1),Buffer.alloc(32,2)),pad:hash(tag,Buffer.from([3,2]),u(7)),empty:hash(tag,Buffer.from([4,1])),slot:s.toString('hex')};
fs.writeFileSync(path.join(__dirname,'../test/fixtures/researchV3/codec-v1.json'),JSON.stringify(fixture,null,2)+'\n');
