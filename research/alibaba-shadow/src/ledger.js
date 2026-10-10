'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { redact } = require('./security');

const MAX_INDEX_ENTRIES = 50000;
const MAX_OPEN_REQUESTS = 1024;
const caches = new Map();
let scanCount = 0;

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function validateWritePath(file, allowedRoot) {
  const candidate = path.resolve(file);
  if (!allowedRoot) return candidate;
  const root = path.resolve(allowedRoot);
  if (!isInside(root, candidate)) {
    const error = new Error('Alibaba shadow write path is outside the persistent data directory.');
    error.code = 'ALIBABA_SHADOW_WRITE_OUTSIDE_DATA_ROOT';
    throw error;
  }
  fs.mkdirSync(root, {recursive:true});
  const realRoot = fs.realpathSync(root);
  const relativeParent = path.relative(root, path.dirname(candidate));
  let current = root;
  for (const part of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) fs.mkdirSync(current);
    const realCurrent = fs.realpathSync(current);
    if (!isInside(realRoot, realCurrent)) {
      const error = new Error('Alibaba shadow write path escapes the persistent data directory through a symlink.');
      error.code = 'ALIBABA_SHADOW_WRITE_SYMLINK_ESCAPE';
      throw error;
    }
  }
  if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) {
    const realCandidate = fs.realpathSync(candidate);
    if (!isInside(realRoot, realCandidate)) {
      const error = new Error('Alibaba shadow file symlink escapes the persistent data directory.');
      error.code = 'ALIBABA_SHADOW_WRITE_SYMLINK_ESCAPE';
      throw error;
    }
  }
  return candidate;
}

function ensureParent(file, options = {}) {
  const candidate = validateWritePath(file, options.allowedRoot);
  fs.mkdirSync(path.dirname(candidate), {recursive:true});
  return candidate;
}

function appendImmutable(file, record, options = {}) {
  const candidate = ensureParent(file, options);
  const fd = fs.openSync(candidate, 'a');
  try {
    fs.writeSync(fd, `${JSON.stringify(redact(record, options.secrets))}\n`, null, 'utf8');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

async function appendImmutableAsync(file, record, options = {}) {
  const candidate = ensureParent(file, options);
  const handle = await fs.promises.open(candidate, 'a');
  try {
    await handle.writeFile(`${JSON.stringify(redact(record, options.secrets))}\n`, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
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
    catch (_) { throw Object.assign(new Error(`Malformed Alibaba ledger JSON at line ${lineNumber}.`),
      {code:'ALIBABA_LEDGER_CORRUPT'}); }
    await visit(row, lineNumber);
  }
}

function boundedSetAdd(set, value, max = MAX_INDEX_ENTRIES) {
  if (set.has(value)) set.delete(value);
  set.add(value);
  while (set.size > max) set.delete(set.values().next().value);
}

function boundedMapSet(map, key, value, max = MAX_INDEX_ENTRIES) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

class LedgerIndex {
  constructor(file, options = {}) {
    this.file = path.resolve(file);
    this.allowedRoot = options.allowedRoot;
    this.canonical = options.canonical;
    this.initialized = false;
    this.loading = null;
    this.day = null;
    this.requestIds = new Set();
    this.terminalRequestIds = new Set();
    this.startedCandidates = new Set();
    this.candidateInputs = new Map();
    this.openRequests = new Map();
    this.dayRequests = 0;
    this.dayTokens = 0;
    this.dayCostUsd = 0;
    this.recentRequests = [];
    this.summary = this.emptySummary();
  }

  emptySummary() {
    return {successfulModelDecisions:0,localAbstains:0,apiErrors:0,malformedOutputs:0,
      normalizedOutputs:0,budgetDeferred:0,budgetStale:0,
      tokens:{prompt:0,completion:0,total:0},estimatedCostUsd:0,lastHttpError:null};
  }

  clear(day) {
    this.day = day;
    this.requestIds.clear();
    this.terminalRequestIds.clear();
    this.startedCandidates.clear();
    this.candidateInputs.clear();
    this.openRequests.clear();
    this.dayRequests = 0;
    this.dayTokens = 0;
    this.dayCostUsd = 0;
    this.recentRequests = [];
    this.summary = this.emptySummary();
  }

  apply(row, nowMs) {
    if (row.request_id && ['REQUEST_STARTED','SHADOW_DECISION'].includes(row.record_type)) {
      boundedSetAdd(this.requestIds, row.request_id);
    }
    if (row.candidate_id && row.input_snapshot_hash && !this.candidateInputs.has(row.candidate_id)) {
      boundedMapSet(this.candidateInputs, row.candidate_id, row.input_snapshot_hash);
    }
    if (row.record_type === 'REQUEST_STARTED' && row.request_id) {
      if(row.candidate_id)boundedSetAdd(this.startedCandidates,row.candidate_id);
      boundedMapSet(this.openRequests, row.request_id, row, MAX_OPEN_REQUESTS);
      const requestedMs = Date.parse(row.requested_at_utc || '');
      const reserved = Number(row.estimated_tokens_reserved) || 0;
      const reservedCost = Number(row.estimated_cost_usd_reserved) || 0;
      if (String(row.requested_at_utc || '').startsWith(this.day)) {
        this.dayRequests += 1;
        this.dayTokens += reserved;
        this.dayCostUsd += reservedCost;
      }
      if (Number.isFinite(requestedMs)) this.recentRequests.push({requestId:row.request_id,at:requestedMs,tokens:reserved,costUsd:reservedCost});
    }
    if (row.record_type === 'SHADOW_DECISION' && row.request_id) {
      const started = this.openRequests.get(row.request_id);
      const actualTokens = Number(row.tokens?.total);
      const actualCost = Number(row.estimated_cost_usd);
      if (started && Number.isFinite(actualTokens) && actualTokens >= 0) {
        const reserved = Number(started.estimated_tokens_reserved) || 0;
        if (String(started.requested_at_utc || '').startsWith(this.day)) this.dayTokens += actualTokens-reserved;
        const recent = this.recentRequests.find(item=>item.requestId===row.request_id);
        if (recent) recent.tokens=actualTokens;
      }
      if(started&&Number.isFinite(actualCost)&&actualCost>=0){
        const reservedCost=Number(started.estimated_cost_usd_reserved)||0;
        if(String(started.requested_at_utc||'').startsWith(this.day))this.dayCostUsd+=actualCost-reservedCost;
        const recent=this.recentRequests.find(item=>item.requestId===row.request_id);
        if(recent)recent.costUsd=actualCost;
      }
      boundedSetAdd(this.terminalRequestIds, row.request_id);
      if(row.candidate_id)boundedSetAdd(this.startedCandidates,row.candidate_id);
      this.openRequests.delete(row.request_id);
      if (row.status === 'OK') this.summary.successfulModelDecisions += 1;
      if (['LOCAL_ABSTAIN','BUDGET_EXHAUSTED','ABSTAIN_BUDGET_STALE','API_KEY_ABSENT',
        'DUPLICATE_CANDIDATE_CONFLICT','INTERRUPTED_UNKNOWN_OUTCOME'].includes(row.status)) {
        this.summary.localAbstains += 1;
      }
      if (row.status === 'ABSTAIN_BUDGET_STALE') this.summary.budgetStale += 1;
      if (['MALFORMED_JSON','MALFORMED_OUTPUT'].includes(row.status)) this.summary.malformedOutputs += 1;
      if (row.normalization?.applied) this.summary.normalizedOutputs += 1;
      if (Number(row.http_status) >= 400 || /^API_/.test(row.status || '')) {
        this.summary.apiErrors += 1;
        this.summary.lastHttpError = {httpStatus:row.http_status ?? null,status:row.status,
          code:row.api_error?.code || null,message:row.api_error?.message || null,
          at:row.completed_at_utc || row.requested_at_utc || null};
      }
      for (const key of ['prompt','completion','total']) {
        this.summary.tokens[key] += Number(row.tokens?.[key]) || 0;
      }
      this.summary.estimatedCostUsd += Number(row.estimated_cost_usd) || 0;
    }
    if (row.record_type === 'BUDGET_DEFERRED') this.summary.budgetDeferred += 1;
    this.pruneRecent(nowMs);
  }

  pruneRecent(nowMs) {
    const cutoff = nowMs - 60000;
    this.recentRequests = this.recentRequests.filter(item => item.at >= cutoff && item.at <= nowMs);
  }

  async load(nowMs) {
    const recovering = !this.initialized;
    const day = new Date(nowMs).toISOString().slice(0,10);
    this.clear(day);
    scanCount += 1;
    if(this.canonical) await this.canonical.read(row=>this.apply(row,nowMs)); else await readRecords(this.file, row => this.apply(row, nowMs));
    for (const started of recovering ? [...this.openRequests.values()] : []) {
      const completedIso = new Date(nowMs).toISOString();
      const interrupted = {
        ...started,
        record_type:'SHADOW_DECISION',
        status:'INTERRUPTED_UNKNOWN_OUTCOME',
        completed_at_utc:completedIso,
        available_to_system_at_utc:completedIso,
        latency_ms:null,
        http_status:null,
        rate_limit_headers:{},
        tokens:null,
        estimated_cost_usd:Number(started.estimated_cost_usd_reserved)||0,
        decision:{decision:'ABSTAIN',risk_level:'UNKNOWN',confidence:0,
          reason_codes:['INTERRUPTED_UNKNOWN_OUTCOME'],evidence_keys:[],
          missing_or_stale:['Process stopped after request start; the possibly billed request was not retried.'],
          rationale_short:'Request outcome is unknown after process interruption; automatic retry is forbidden.'},
      };
      delete interrupted.estimated_tokens_reserved;
      if(this.canonical) await this.canonical.append(interrupted); else await appendImmutableAsync(this.file, interrupted, {allowedRoot:this.allowedRoot});
      this.apply(interrupted, nowMs);
    }
    this.initialized = true;
  }

  async ensure(nowMs) {
    const day = new Date(nowMs).toISOString().slice(0,10);
    if (this.initialized && this.day === day) { this.pruneRecent(nowMs); return this; }
    if (!this.loading) this.loading = this.load(nowMs).finally(() => { this.loading = null; });
    await this.loading;
    return this;
  }

  state(nowMs) {
    this.pruneRecent(nowMs);
    return {
      requestIds:this.requestIds,
      terminalRequestIds:this.terminalRequestIds,
      startedCandidates:this.startedCandidates,
      candidateInputs:this.candidateInputs,
      dayRequests:this.dayRequests,
      dayTokens:this.dayTokens,
      dayCostUsd:this.dayCostUsd,
      minuteRequests:this.recentRequests.length,
      minuteTokens:this.recentRequests.reduce((sum,item)=>sum+item.tokens,0),
      recentRequests:this.recentRequests.map(item=>({...item})),
      summary:JSON.parse(JSON.stringify(this.summary)),
    };
  }

  async append(record, nowMs = Date.now()) {
    if(this.canonical) await this.canonical.append(record); else await appendImmutableAsync(this.file, record, {allowedRoot:this.allowedRoot});
    this.apply(record, nowMs);
  }
}

async function ledgerIndex(file, nowMs = Date.now(), options = {}) {
  const key = path.resolve(file);
  let index = caches.get(key);
  if (!index) {
    index = new LedgerIndex(key, options);
    caches.set(key, index);
  } else if (options.allowedRoot) index.allowedRoot = options.allowedRoot;
  await index.ensure(nowMs);
  return index;
}

async function ledgerState(file, nowMs = Date.now(), options = {}) {
  const index = await ledgerIndex(file, nowMs, options);
  return index.state(nowMs);
}

function budgetReason(state, estimatedTokens, estimatedCostUsd, config) {
  if (state.dayRequests >= config.maxRequestsDay) return 'DAILY_REQUEST_BUDGET';
  if (state.dayTokens + estimatedTokens > config.maxTokensDay) return 'DAILY_TOKEN_BUDGET';
  if (state.dayCostUsd + estimatedCostUsd > config.maxCostUsdDay) return 'DAILY_COST_BUDGET';
  if (state.minuteRequests >= config.maxRequestsMinute) return 'MINUTE_REQUEST_BUDGET';
  if (state.minuteTokens + estimatedTokens > config.maxTokensMinute) return 'MINUTE_TOKEN_BUDGET';
  return null;
}

function nextMinuteAvailableAt(state, estimatedTokens, config, nowMs) {
  let requests = (state.recentRequests || []).length;
  let tokens = (state.recentRequests || []).reduce((sum,item)=>sum+item.tokens,0);
  if (requests < config.maxRequestsMinute && tokens + estimatedTokens <= config.maxTokensMinute) return nowMs;
  const recent = [...(state.recentRequests || [])].sort((a,b)=>a.at-b.at);
  for (const item of recent) {
    requests -= 1;
    tokens -= item.tokens;
    if (requests < config.maxRequestsMinute && tokens + estimatedTokens <= config.maxTokensMinute) {
      return Math.max(nowMs,item.at + 60025);
    }
  }
  return nowMs + 60025;
}

module.exports = {appendImmutable,appendImmutableAsync,readRecords,ledgerState,ledgerIndex,budgetReason,nextMinuteAvailableAt,validateWritePath,
  _test:{resetCaches:()=>caches.clear(),scanCount:()=>scanCount,resetScanCount:()=>{scanCount=0;},MAX_INDEX_ENTRIES}};
