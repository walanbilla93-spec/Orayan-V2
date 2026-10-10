'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const root=path.resolve(__dirname,'../..');
const hash=source=>crypto.createHash('sha256').update(source.replace(/\r\n/g,'\n')).digest('hex');

// Captured from deployed main 506a729. Only exact observation hooks are stripped.
// Strategy, risk, execution logic and unchanged input/prompt contracts must still match.
test('execution, gates and Groq input/prompt contracts match deployed main',()=>{
  const expected={
    'backend/lib/executor.js':'15c579d2e8de6a147038fd6d7d9bc465523f87dcb6421766543199007bcd63c8',
    'backend/lib/gates.js':'30316c24a2b52c96a4f4d1d612dbe688c2759038260d69bca39cc07fa8171048',
    'research/groq-shadow/src/snapshot.js':'1bfb10606e22a392792a6cd4068ad200f0fa5f8830564bd0986cadfaa1aebf10',
    'research/groq-shadow/src/constants.js':'ebe4ba62cc3df639fdf27560a79d7c81f2e33d59ee164334af4efb9906aef168',
  };
  for(const [file,digest] of Object.entries(expected))assert.equal(hash(require('./captureBaseline')(fs.readFileSync(path.join(root,file),'utf8'),path.basename(file))),digest,file);
});

test('engine is identical to deployed main after removing the two observational Alibaba calls',()=>{
  let source=require('./captureBaseline')(fs.readFileSync(path.join(root,'backend/lib/engine.js'),'utf8'),'engine.js');
  // Remove only the explicitly delimited, one-way V3 observer addition. A dedicated
  // V3 parity test also compares the remaining engine to the exact frozen V2 commit.
  source=source.replace("const v3Shadow = require('./v3Shadow');\n",'')
    .replace(/    \/\/ V3_BEGIN:[\s\S]*?    \/\/ V3_END:[^\n]*\n/,'');
  source=source.replace("const alibabaShadowProducer = require('./alibabaShadowProducer');\n",'')
    .replace(/    try \{ alibabaShadowProducer\.observeEnvironment[^\n]+\n    catch[^\n]+\n/,'')
    .replace(/      \/\/ Independent one-way Alibaba research handoff[^\n]+\n      \/\/ gate[^\n]+\n      try \{ alibabaShadowProducer\.observeBirth[\s\S]*?\n      catch[^\n]+\n/,'');
  assert.equal(hash(source),'7d5a393b7e075234d342f779ae7acfee6e336ab06e8aec6eb17d439ef5cd5083');
});
