'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const root=path.resolve(__dirname,'../..');
const hash=source=>crypto.createHash('sha256').update(source.replace(/\r\n/g,'\n')).digest('hex');

// Captured from deployed main 506a729. This proves the strategy/execution and Groq source
// remain byte-identical; existing Groq behavioral tests exercise that retained code.
test('execution, gates and all Groq production modules match deployed main',()=>{
  const expected={
    'backend/lib/executor.js':'15c579d2e8de6a147038fd6d7d9bc465523f87dcb6421766543199007bcd63c8',
    'backend/lib/gates.js':'30316c24a2b52c96a4f4d1d612dbe688c2759038260d69bca39cc07fa8171048',
    'backend/lib/groqShadowProducer.js':'1a9a71584170e5440a3279d3341c731fb30e61b3f613bd6fb89089a51df06307',
    'research/groq-shadow/src/advisor.js':'7055c480632f1bbc7b451ef2a5e8a89362e74f1a59c35c06a14e731ed4976a56',
    'research/groq-shadow/src/client.js':'bab798f8a6877af2482aac3a008e24c36ed5eb20769678792b26508d51a379d6',
    'research/groq-shadow/src/ledger.js':'bb8487813246c4d20c94d44244b920f6efa02b4cb026720455b66011c0a0f82b',
    'research/groq-shadow/src/snapshot.js':'1bfb10606e22a392792a6cd4068ad200f0fa5f8830564bd0986cadfaa1aebf10',
    'research/groq-shadow/src/constants.js':'ebe4ba62cc3df639fdf27560a79d7c81f2e33d59ee164334af4efb9906aef168',
  };
  for(const [file,digest] of Object.entries(expected))assert.equal(hash(fs.readFileSync(path.join(root,file),'utf8')),digest,file);
});

test('engine is identical to deployed main after removing the two observational Alibaba calls',()=>{
  let source=fs.readFileSync(path.join(root,'backend/lib/engine.js'),'utf8').replace(/\r\n/g,'\n');
  source=source.replace("const alibabaShadowProducer = require('./alibabaShadowProducer');\n",'')
    .replace(/    try \{ alibabaShadowProducer\.observeEnvironment[^\n]+\n    catch[^\n]+\n/,'')
    .replace(/      \/\/ Independent one-way Alibaba research handoff[^\n]+\n      \/\/ gate[^\n]+\n      try \{ alibabaShadowProducer\.observeBirth[\s\S]*?\n      catch[^\n]+\n/,'');
  assert.equal(hash(source),'7d5a393b7e075234d342f779ae7acfee6e336ab06e8aec6eb17d439ef5cd5083');
});
