#!/usr/bin/env node
'use strict';

const fs = require('fs');
const readline = require('readline');
const {advise,configFromEnv} = require('./src/advisor');

function args(argv) {
  const out={mode:'dry-run'};
  for(let i=2;i<argv.length;i+=1){
    const value=argv[i];
    if(value==='--input')out.input=argv[++i];
    else if(value==='--ledger')out.ledger=argv[++i];
    else if(value==='--dry-run')out.mode='dry-run';
    else if(value==='--mock')out.mode='mock';
    else if(value==='--live')out.mode='live';
    else throw new Error(`Unknown argument: ${value}`);
  }
  if(!out.input)throw new Error('Usage: node cli.js --input <candidate.jsonl> [--ledger <decisions.jsonl>] (--dry-run|--mock|--live)');
  return out;
}

async function main(){
  const parsed=args(process.argv),config=configFromEnv();
  if(parsed.ledger)config.ledger=parsed.ledger;
  const input=fs.createReadStream(parsed.input,{encoding:'utf8'});
  const lines=readline.createInterface({input,crlfDelay:Infinity});
  const counts={};
  for await(const line of lines){
    if(!line.trim())continue;
    const snapshot=JSON.parse(line);
    const result=await advise(snapshot,{config,mode:parsed.mode,mockTransport:async()=>({
      ok:true,status:'OK',httpStatus:200,headers:{},latencyMs:1,
      body:{usage:{prompt_tokens:250,completion_tokens:40,total_tokens:290},choices:[{message:{content:JSON.stringify({
        decision:'RETAIN',risk_level:'LOW',confidence:0.5,reason_codes:['MOCK_ONLY'],
        evidence_keys:['h1.state','h2.state'],missing_or_stale:[],rationale_short:'Mock response for integration testing only.'
      })}}]},
    })});
    counts[result.status]=(counts[result.status]||0)+1;
    if(parsed.mode==='dry-run')process.stdout.write(`${JSON.stringify(result)}\n`);
  }
  process.stderr.write(`${JSON.stringify({mode:parsed.mode,counts,ledger:config.ledger})}\n`);
}

main().catch(error=>{process.stderr.write(`${error.message}\n`);process.exitCode=1;});
