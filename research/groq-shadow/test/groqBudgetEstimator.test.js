'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {configFromEnv,buildRequest,estimateTokens}=require('../src/advisor');

test('generation ceiling and budget reservation are separate',()=>{
  const cfg=configFromEnv({});
  assert.equal(cfg.maxOutputTokens,1024);
  assert.equal(cfg.budgetCompletionTokens,450);
  const req=buildRequest({candidate_id:'x'},cfg);
  assert.equal(req.max_completion_tokens,1024);
  const newEstimate=estimateTokens(req,cfg.budgetCompletionTokens);
  const oldEstimate=estimateTokens(req,cfg.maxOutputTokens);
  assert.ok(newEstimate < oldEstimate);
  assert.equal(oldEstimate-newEstimate,574);
});

test('budget completion reserve is configurable but bounded',()=>{
  assert.equal(configFromEnv({GROQ_SHADOW_BUDGET_COMPLETION_TOKENS:'500'}).budgetCompletionTokens,500);
  assert.equal(configFromEnv({GROQ_SHADOW_BUDGET_COMPLETION_TOKENS:'50'}).budgetCompletionTokens,450);
  assert.equal(configFromEnv({GROQ_SHADOW_BUDGET_COMPLETION_TOKENS:'5000'}).budgetCompletionTokens,450);
});
