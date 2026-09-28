'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

function ensureParent(file) { fs.mkdirSync(path.dirname(path.resolve(file)), {recursive:true}); }

function appendImmutable(file, record) {
  ensureParent(file);
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, `${JSON.stringify(record)}\n`, null, 'utf8');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

async function readRecords(file, visit) {
  if (!fs.existsSync(file)) return;
  const stream = fs.createReadStream(file, {encoding:'utf8'});
  const lines = readline.createInterface({input:stream, crlfDelay:Infinity});
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); }
    catch (error) { error.message = `Malformed ledger JSON at line ${lineNumber}: ${error.message}`; throw error; }
    await visit(row, lineNumber);
  }
}

async function ledgerState(file, nowMs = Date.now()) {
  const day = new Date(nowMs).toISOString().slice(0,10);
  const minuteCutoff = nowMs - 60000;
  const requestIds = new Set(), inputHashes = new Set(), candidateInputs = new Map();
  let dayRequests = 0, dayTokens = 0, minuteRequests = 0, minuteTokens = 0;
  await readRecords(file, row => {
    if (row.request_id) requestIds.add(row.request_id);
    if (row.input_snapshot_hash) inputHashes.add(row.input_snapshot_hash);
    if (row.candidate_id && row.input_snapshot_hash && !candidateInputs.has(row.candidate_id)) {
      candidateInputs.set(row.candidate_id,row.input_snapshot_hash);
    }
    if (row.record_type !== 'REQUEST_STARTED') return;
    const requestedMs = Date.parse(row.requested_at_utc || '');
    const reserved = Number(row.estimated_tokens_reserved) || 0;
    if (String(row.requested_at_utc || '').startsWith(day)) {
      dayRequests += 1; dayTokens += reserved;
    }
    if (Number.isFinite(requestedMs) && requestedMs >= minuteCutoff) {
      minuteRequests += 1; minuteTokens += reserved;
    }
  });
  return {requestIds,inputHashes,candidateInputs,dayRequests,dayTokens,minuteRequests,minuteTokens};
}

function budgetReason(state, estimatedTokens, config) {
  if (state.dayRequests >= config.maxRequestsDay) return 'DAILY_REQUEST_BUDGET';
  if (state.dayTokens + estimatedTokens > config.maxTokensDay) return 'DAILY_TOKEN_BUDGET';
  if (state.minuteRequests >= config.maxRequestsMinute) return 'MINUTE_REQUEST_BUDGET';
  if (state.minuteTokens + estimatedTokens > config.maxTokensMinute) return 'MINUTE_TOKEN_BUDGET';
  return null;
}

module.exports = {appendImmutable, readRecords, ledgerState, budgetReason};
