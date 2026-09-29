'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {pathExists}=require('../src/snapshot');
const {RESPONSE_SCHEMA,RESPONSE_SCHEMA_VERSION}=require('../src/constants');

test('V3 transport schema is shape-strict but semantic enums are local',()=>{
  assert.equal(RESPONSE_SCHEMA_VERSION,'ORAYAN_GROQ_SHADOW_RESPONSE_V3');
  assert.equal(RESPONSE_SCHEMA.additionalProperties,false);
  assert.equal(Object.prototype.hasOwnProperty.call(RESPONSE_SCHEMA.properties.reason_codes.items,'enum'),false);
  assert.equal(Object.prototype.hasOwnProperty.call(RESPONSE_SCHEMA.properties.decision,'enum'),false);
  assert.equal(Object.prototype.hasOwnProperty.call(RESPONSE_SCHEMA.properties.risk_level,'enum'),false);
});

test('evidence path validator supports safe array indexes',()=>{
  const row={h2:{alerts:[{name:'a'},{name:'b'}]},sources:[{status:'OK'}]};
  assert.equal(pathExists(row,'h2.alerts[0]'),true);
  assert.equal(pathExists(row,'h2.alerts[1].name'),true);
  assert.equal(pathExists(row,'sources[0].status'),true);
  assert.equal(pathExists(row,'h2.alerts[9]'),false);
  assert.equal(pathExists(row,'h2.alerts[-1]'),false);
  assert.equal(pathExists(row,'__proto__.polluted'),false);
});
