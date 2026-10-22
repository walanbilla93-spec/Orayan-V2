'use strict';

function recoverySummary(provider, result, durationMs) {
  const summary = { provider, durationMs, status: result?.initialized === false ? 'NOT_INITIALIZED' : 'READY' };
  for (const key of ['requestIds', 'terminalRequestIds', 'candidateInputs', 'startedCandidates', 'openRequests']) {
    if (result?.[key] instanceof Set || result?.[key] instanceof Map) summary[key + 'Count'] = result[key].size;
  }
  return Object.freeze(summary);
}

// Presentation only: never mutate the canonical manifest or any nested metadata.
function compactCapture(status) {
  if (!status || !['ORAYAN_RESEARCH_V2','ORAYAN_RESEARCH_V3'].includes(status.schemaVersion)) return status;
  const { archives = [], segments = [], liveStructures, startupMemory, memory, ...rest } = status;
  let archiveBytes = 0, activeArchives = 0, latest = null;
  const summaries = archives.map(a => {
    if (!a.expired) { archiveBytes += a.bytes || 0; activeArchives++; }
    if (!latest || a.day > latest.day) latest = a;
    return { day:a.day, bytes:a.bytes, filename:a.filename, sha256:a.sha256,
      expired:a.expired, published:a.published, verified:a.verified };
  });
  return { ...rest, ...(status.backend!=='v3'?{...(memory?{memory}:{}),...(startupMemory?{startupMemory}:{}),...(liveStructures?{liveStructures}:{})}:{}), ...(status.backend==='v3'?{captureSchema:status.schemaVersion,downloadAvailable:!!status.epochId,exportScope:status.cleanProspectiveExperiment?'ACTIVE_CLEAN_EPOCH':'CURRENT_30H',memory:memory?{rss:memory.rss,heapUsed:memory.heapUsed,external:memory.external,cgroupPeak:memory.cgroupPeak}:undefined}:{}), archives:summaries,
    segments:segments.map(s => ({ name:s.name, bytes:s.bytes, rows:s.rows, day:s.day, sealed:s.sealed })),
    archiveSummary:{ count:archives.length, activeCount:activeArchives, bytes:archiveBytes,
      latestDay:latest?.day ?? null, latestId:latest?.filename ?? null, segmentCount:segments.length,
      detailAvailable:true, detailUrl:'/api/capture/status/details' } };
}
function compactStatus(status) {
  if (!status) return status;
  const result = compactCapture(status);
  const out = { ...result };
  if (out.researchCapture) out.researchCapture = compactCapture(out.researchCapture);
  if (out.archive) out.archive = compactStatus(out.archive);
  if (out.telemetry?.researchCapture) out.telemetry = { ...out.telemetry, researchCapture:compactCapture(out.telemetry.researchCapture) };
  return out;
}
module.exports = { recoverySummary, compactCapture, compactStatus };
