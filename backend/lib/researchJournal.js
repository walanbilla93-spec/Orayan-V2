'use strict';
const store = require('./store');
const VERSION = 'CROSS_SECTIONAL_V1';
const MAX_SNAPSHOTS = 2016; // 7 days at 5-minute cadence
const MAX_EVENTS = 10000;
let snapshots = store.read('researchEnvironmentV1', []);
let events = store.read('researchEventsV1', []);
if (!Array.isArray(snapshots)) snapshots = [];
if (!Array.isArray(events)) events = [];
snapshots = snapshots.slice(-MAX_SNAPSHOTS);
events = events.slice(-MAX_EVENTS);
let timer = null, dirty = false;
function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!dirty) return;
  dirty = false;
  store.write('researchEnvironmentV1', snapshots);
  store.write('researchEventsV1', events);
}
function schedule() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(flush, 3000);
  if (timer.unref) timer.unref();
}
function finite(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function project(s) {
  const m = s.marciIndependent || {};
  const l = s.locationResearch || {};
  return {
    id:s.id, symbol:s.symbol, side:s.side, signalSource:s.signalSource || 'ORAYAN',
    score:finite(s.score), rr:finite(s.rr), entry:finite(s.entry),
    sl:finite(s.sl), tp:finite(s.tp), slDistPct:finite(s.slDistPct),
    passed:s.gates?.passed ?? null, failedGates:s.gates?.failed || [],
    btcRegime:s.btcRegime, structureEvent:s.structureEvent,
    structureTrend:s.structureTrend, timeframe:s.timeframe,
    locationBucket:l.locationBucket, retracementDepthEntry:finite(l.retracementDepthEntry),
    bbZ:finite(l.bbZ), trendLegNumber:finite(l.trendLegNumber),
    rizzySequence:l.rizzySequence, marciPatternKey:m.patternKey,
    marciRizzySequence:m.rizzySequence, marciTargetR:finite(m.targetR),
    marciDAtr:finite(m.dAtr), marciEma21SlopePct:finite(m.ema21SlopePct),
    marciBbZ:finite(m.bbZ), marciBbPercentB:finite(m.bbPercentB),
    marciTrendLocation:m.trendLocation,
    turnover24h:finite(s.market?.turnover24h), spreadPct:finite(s.market?.spreadPct),
    fundingRate:finite(s.market?.fundingRate), volRatio:finite(s.market?.volRatio)
  };
}
function record(signals, meta) {
  if (!Array.isArray(signals) || !signals.length) return;
  const at = meta.scanAt;
  const bucket = Math.floor(at / 300000) * 300000;
  // One observation per symbol/side/source per five-minute bucket.
  // This is an evaluation journal, not a trade or execution ledger.
  const latest = new Map();
  for (const s of signals) {
    if (!s || !s.symbol || !s.side) continue;
    const p = project(s);
    latest.set([p.signalSource,p.symbol,p.side].join('|'), p);
  }
  const rows = [...latest.values()];
  const orayan = rows.filter(r => r.signalSource === 'ORAYAN');
  const counts = {BUY:0, SELL:0};
  for (const r of orayan) if (r.side in counts) counts[r.side]++;
  const n = counts.BUY + counts.SELL;
  const previous = snapshots[snapshots.length-1];
  const snapshot = {
    version:VERSION, at:bucket, observedAt:at, scanId:meta.scanId,
    universeCount:new Set(orayan.map(r=>r.symbol)).size,
    candidateCount:n, buyCount:counts.BUY, sellCount:counts.SELL,
    buyPct:n ? counts.BUY/n*100 : null, sellPct:n ? counts.SELL/n*100 : null,
    directionalBreadth:n ? (counts.BUY-counts.SELL)/n*100 : null,
    // Candidate breadth is NOT independently measured market breadth.
    breadthDefinition:'ORAYAN_CANDIDATE_DIRECTION_SHARE',
    // Missing raw market series must remain null, not fabricated.
    breadthMomentum:null, trendCoherence:null, dispersion:null,
    btcAltAlignment:null, marketReversalRate:null, environmentBucket:null,
    btcRegime:orayan[0]?.btcRegime || null
  };
  if (previous && previous.at === bucket) snapshots[snapshots.length-1] = snapshot;
  else snapshots.push(snapshot);
  snapshots = snapshots.filter(x => x.at >= bucket - 7*86400000).slice(-MAX_SNAPSHOTS);
  // Preserve one first-seen event per pattern/side and meaningful state change.
  // Never suppress a passed candidate or a change in gate result.
  const existing = new Map();
  for (let i=0;i<events.length;i++) if (events[i].environmentAt === bucket) existing.set(events[i].key,i);
  for (const r of rows) {
    const key = [r.signalSource,r.symbol,r.side,r.marciPatternKey || '',bucket].join('|');
    const oldIndex = existing.get(key);
    const old = oldIndex === undefined ? null : events[oldIndex];
    const signature = JSON.stringify([r.passed,r.failedGates,r.structureEvent,r.locationBucket]);
    if (old && old.signature === signature && !r.passed) continue;
    const alignment = snapshot.directionalBreadth === null ? null :
      (r.side === 'BUY' ? snapshot.directionalBreadth : -snapshot.directionalBreadth);
    const event = {version:VERSION,key,at,scanId:meta.scanId,environmentAt:bucket,
      tradeBreadthAlignment:alignment,signature,...r};
    if (old && old.signature === signature) events[oldIndex] = event;
    else { events.push(event); existing.set(key,events.length-1); }
  }
  events = events.filter(x => x.at >= at - 7*86400000).slice(-MAX_EVENTS);
  schedule();
}
function getSnapshots() { return snapshots.slice(); }
function getEvents() { return events.slice(); }
module.exports = {record,getSnapshots,getEvents,flush,VERSION};
