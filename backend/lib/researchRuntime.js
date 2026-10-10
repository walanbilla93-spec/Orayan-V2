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
  if (singleton && singleton.dir === path.join(root, "research-canonical-v2"))
    return singleton;
  singleton = new ResearchStore(path.join(root, "research-canonical-v2"), {
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
    if (busy || !enabled()) return;
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
  tick();
  timer = setInterval(tick, 15000);
  timer.unref();
}
async function downloadCurrent(options = {}) {
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day))
    throw Object.assign(Error("INVALID_ARCHIVE_DATE"), { statusCode: 400 });
  const c = current(),
    a = c.state.archives.find(
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
