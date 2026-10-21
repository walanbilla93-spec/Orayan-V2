"use strict";
const fs = require("fs"),
  path = require("path"),
  os = require("os"),
  crypto = require("crypto");
const { ResearchStore, SCHEMA } = require("./researchStore");
let singleton,
  timer,
  busy = false;
function current() {
  const root = require("./store").DATA_DIR;
  if (singleton) return singleton;
  const backend = require('./researchV3Activation').select(root);
  const Store = backend === 'v3' ? require('./researchStoreV3').ResearchStoreV3 : ResearchStore;
  singleton = new Store(path.join(root, 'research-canonical-' + backend), {
    epochId: crypto.randomUUID(),
  });
  const provenance = {
    schemaVersion: SCHEMA,
    baseCommit: "5766e5fc0698c2049615b347ea4a0866ccd2c316",
    implementationCommit:
      process.env.RESEARCH_IMPLEMENTATION_COMMIT || "UNSPECIFIED",
    timezone: singleton.timezone,
    historicalImport: "NOT_AUTOMATIC",
  };
  const provenanceId = require("./researchStore").sha(
    JSON.stringify(provenance),
  );
  singleton.emit(
    "definitions",
    {
      definitionId: provenanceId,
      kind: "CAPTURE_PROVENANCE",
      definition: provenance,
    },
    { key: "capture-provenance:" + provenanceId, signature: provenanceId },
  );
  singleton.writerDefinitionId = provenanceId;
  return singleton;
}
function prepare() {
  const root = require("./store").DATA_DIR;
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, "research-capture-policy.json");
  if (!fs.existsSync(file))
    require("./researchStore").atomic(file, {
      schemaVersion: SCHEMA,
      createdAt: Date.now(),
      baseCommit: "5766e5fc0698c2049615b347ea4a0866ccd2c316",
      historicalImport: "NOT_AUTOMATIC",
    });
}
function enabled() {
  return require("./minimalCapture").researchEnabled();
}
function canAdmit(mode) {
  if (String(mode).toUpperCase() !== 'LIVE' && require('./maintenance').fenced()) return false;
  if (String(mode).toUpperCase() === "LIVE") return true;
  if (!enabled()) return true;
  try {
    return current().canAdmit(mode);
  } catch {
    return false;
  }
}
function start() {
  if (timer) return;
  const tick = async () => {
    if (busy || !enabled() || require('./maintenance').fenced()) return;
    busy = true;
    try {
      await require("./researchArchive").tick(current());
    } catch (e) {
      try {
        current().fail(e, "archives");
      } catch {}
    } finally {
      busy = false;
    }
  };
  // V3 boot opens descriptors and bounded recovery only. The normal archive
  // timer performs bounded traversal after management has initialized.
  if ((process.env.RESEARCH_STORE_BACKEND || 'v2') !== 'v3') tick();
  timer = setInterval(tick, 15000);
  timer.unref();
}
let currentExportFlight = null;
// Share only the combined Current 30h export; provider exports keep their own path.
async function downloadCurrent(options = {}) {
  require('./maintenance').current().assertStart('archive');
  if (Object.keys(options).length) return buildCurrent(options);
  let flight = currentExportFlight;
  if (!flight) {
    flight = { waiters: 0, artifact: null };
    currentExportFlight = flight;
    flight.promise = buildCurrent().then(artifact => {
      flight.artifact = artifact;
      return artifact;
    }).finally(() => {
      if (currentExportFlight === flight) currentExportFlight = null;
    });
  }
  // Reserve a lease before awaiting: the first response may finish before others stream.
  flight.waiters++;
  try {
    const artifact = await flight.promise;
    let released = false;
    return { ...artifact, cleanup: () => {
      if (released) return;
      released = true;
      if (--flight.waiters === 0) artifact.cleanup();
    } };
  } catch (error) {
    flight.waiters--;
    throw error;
  }
}
async function buildCurrent(options = {}) {
  require('./maintenance').current().assertStart('archive');
  const c = current(),
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "orayan-export-")),
    file = path.join(scratch, "current.zip");
  c.exportReaders = (c.exportReaders || 0) + 1;
  try {
    await require("./researchArchive").build(c, {
      ...options,
      sinceAt: Date.now() - 30 * 3600000,
      target: file,
    });
  } catch (e) {
    fs.rmSync(scratch, { recursive: true, force: true });
    throw e;
  } finally {
    c.exportReaders--;
  }
  return {
    __files: true,
    files: [{ path: file, size: fs.statSync(file).size }],
    contentType: "application/zip",
    filename: options.provider
      ? "orayan-" + options.provider.toLowerCase() + "-30h.zip"
      : "orayan-current-30h.zip",
    cleanup: () => fs.rmSync(scratch, { recursive: true, force: true }),
  };
}
function providerExportMetadata(provider) {
  if (current().backend === 'v3') {
    let sizeBytes=0,last=0,requests=0,requestBytes=0,requestLast=0;
    const now=Date.now(),since=now-30*3600000;
    for(const e of current().values('events'))if(e.stream==='ai_calls'&&e.provider===provider&&e.at>=since&&e.at<=now){sizeBytes+=e.bytes;last=Math.max(last,e.at);if(e.aiEvent==='REQUEST_PREPARED'){requests++;requestBytes+=e.bytes;requestLast=Math.max(requestLast,e.at);}}
    return {canonical:true,exportFormat:'zip',available:!!last,sizeBytes,lastUpdatedAt:last?new Date(last).toISOString():null,snapshotAuditAvailable:requests>0,snapshotAuditSizeBytes:requestBytes,snapshotAuditLastUpdatedAt:requestLast?new Date(requestLast).toISOString():null};
  }
  const now = Date.now(), sinceAt = now - 30 * 3600000;
  const events = Object.values(current().state.events).filter(
    (e) => e.stream === 'ai_calls' && e.provider === provider && e.at >= sinceAt && e.at <= now,
  );
  const requests = events.filter((e) => e.aiEvent === 'REQUEST_PREPARED');
  const bytes = (rows) => rows.reduce((total, e) => total + e.bytes, 0);
  const latest = (rows) => rows.length
    ? new Date(rows.reduce((at, e) => Math.max(at, e.at), 0)).toISOString() : null;
  // Logical evidence bytes, not the size of the on-demand ZIP or a legacy ledger.
  return {
    canonical: true, exportFormat: 'zip', available: events.length > 0,
    sizeBytes: bytes(events), lastUpdatedAt: latest(events),
    snapshotAuditAvailable: requests.length > 0,
    snapshotAuditSizeBytes: bytes(requests), snapshotAuditLastUpdatedAt: latest(requests),
  };
}
async function daily(day) {
  require('./maintenance').current().assertStart('archive');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day))
    throw Object.assign(Error("INVALID_ARCHIVE_DATE"), { statusCode: 400 });
  const c = current(),
    a = (c.backend === 'v3' ? c.archiveStatus() : c.state.archives).find(
      (a) => a.day === day && !a.expired && a.published && a.verified,
    );
  if (!a)
    throw Object.assign(Error("ARCHIVE_NOT_PUBLISHED"), { statusCode: 404 });
  const file = path.join(c.dir, "archives", a.filename);
  c.exportReaders = (c.exportReaders || 0) + 1;
  try {
    if ((await require("./researchArchive").fileHash(file)) !== a.sha256)
      throw Error("ARCHIVE_CHECKSUM_FAILED");
  } catch (error) {
    c.exportReaders--;
    throw error;
  }
  return {
    __files: true,
    files: [{ path: file, size: a.bytes }],
    contentType: "application/zip",
    filename: a.filename,
    cleanup: () => {
      c.exportReaders--;
    },
  };
}
async function close() {
  if (timer) clearInterval(timer);
  timer = null;
  if (singleton) await singleton.close();
  singleton = null;
}
function status() {
  try {
    return {
      ...current().status(),
      ...(current().backend === 'v3' ? {startupMemory:current().startupMemory,memory:current().memory()} : {}),
      evidencePreservationEnabled: require("./researchArchive").preservationEnabled(),
      exportAuthorization: {
        groq: !!process.env.GROQ_SHADOW_EXPORT_TOKEN,
        alibaba: !!process.env.ALIBABA_SHADOW_EXPORT_TOKEN,
      },
    };
  } catch (error) {
    return {
      schemaVersion: SCHEMA,
      captureSchema: SCHEMA,
      captureHalted: true,
      health: "RESEARCH CAPTURE HALTED",
      captureReason: error.code || "WRITER_INITIALIZATION_FAILED",
      lastError: {
        code: error.code || "WRITER_INITIALIZATION_FAILED",
        stream: "INITIALIZATION",
      },
      affectedStreams: ["ALL_CRITICAL_STREAMS"],
      populationComplete: false,
      persistedRows: null,
      acceptedRows: null,
      lostRows: null,
      uniqueDecisionEpisodes: null,
      retainedBytes: null,
      retainedRows: null,
      episodeStates: { OPEN: null, COMPLETE: null, CENSORED: null },
      archives: [],
    };
  }
}
module.exports = {
  maintenanceStatus: () => ({ busy }),
  status,
  current,
  enabled,
  canAdmit,
  start,
  prepare,
  downloadCurrent,
  providerExportMetadata,
  daily,
  close,
  SCHEMA,
};
