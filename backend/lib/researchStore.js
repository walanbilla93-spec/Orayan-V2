"use strict";
// Canonical research persistence. Execution code has no authority in this module.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const SCHEMA = "ORAYAN_RESEARCH_V2";
const STREAMS = {
  configuration: "definitions",
  decision_episode: "decisions",
  trade_lifecycle: "lifecycle",
  experiment_arm: "experiments",
  management_path: "lifecycle",
  errors_health: "integrity",
  ai_calls: "ai_calls",
  outcomes: "outcomes",
  integrity: "integrity",
  definitions: "definitions",
  telemetry: "telemetry",
  experiment_paths: "experiment_paths",
};
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const CHUNK = 48 * 1024;
function writeAll(fd, buffer, position = null) {
  let offset = 0;
  while (offset < buffer.length) {
    const n = fs.writeSync(
      fd,
      buffer,
      offset,
      buffer.length - offset,
      position === null ? null : position + offset,
    );
    if (!n) throw Object.assign(Error("ZERO_BYTE_WRITE"), { code: "EIO" });
    offset += n;
  }
}
function atomic(file, value) {
  const fd = fs.openSync(file + ".tmp", "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(file + ".tmp", file);
  // Directory fsync is required for rename durability on Linux. Windows has no equivalent.
  if (process.platform !== "win32") {
    const d = fs.openSync(path.dirname(file), "r");
    try {
      fs.fsyncSync(d);
    } finally {
      fs.closeSync(d);
    }
  }
}
function clean(value, secrets = []) {
  if (typeof value === "string") {
    for (const s of secrets)
      if (s) value = value.split(s).join("[REDACTED_SECRET]");
    return value.replace(/Bearer\s+\S+/gi, "[REDACTED_AUTH]");
  }
  if (Array.isArray(value)) return value.map((v) => clean(v, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([k]) =>
            !/(api.?key|secret|password|authorization|credential|export.?token)/i.test(
              k,
            ),
        )
        .map(([k, v]) => [k, clean(v, secrets)]),
    );
  return value;
}
function dayAt(at, timezone = "Asia/Colombo") {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
}
function initial(epochId, startedAt) {
  return {
    schemaVersion: SCHEMA,
    epochId: epochId || crypto.randomUUID(),
    startedAt,
    sequence: 0,
    attemptedRows: 0,
    acceptedRows: 0,
    persistedRows: 0,
    archivedRows: 0,
    lostRows: 0,
    optionalSuppressed: 0,
    acceptedBytes: 0,
    retainedBytes: 0,
    countsByStream: {},
    bytesByStream: {},
    dedupe: {},
    events: {},
    episodes: {},
    episodeMetadata: {},
    nativeEpisodeIndex: {},
    segments: [],
    archives: [],
    populationComplete: true,
  };
}
class ResearchStore {
  constructor(dir, options = {}) {
    this.dir = dir;
    this.options = options;
    this.timezone =
      options.timezone ||
      process.env.RESEARCH_ARCHIVE_TIMEZONE ||
      "Asia/Colombo";
    dayAt(Date.now(), this.timezone);
    this.segmentBytes = options.segmentBytes || 8 * 1024 * 1024;
    this.segmentMs = options.segmentMs || 15 * 60000;
    this.now = options.now || Date.now;
    this.secrets =
      options.secrets ||
      Object.entries(process.env)
        .filter(([k]) => /(API_KEY|SECRET|PASSWORD|EXPORT_TOKEN)$/.test(k))
        .map(([, v]) => v);
    this.file = path.join(dir, "status.json");
    this.journal = path.join(dir, "index-journal.jsonl");
    this.checkpointEvery = options.checkpointEvery || 32;
    this.uncheckpointed = 0;
    this.wal = path.join(dir, "wal");
    this.reserve = path.join(dir, "outcome-reserve.bin");
    this.pendingFailure = null;
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(this.wal, { recursive: true });
    fs.mkdirSync(path.join(dir, "archives"), { recursive: true });
    this.state = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, "utf8"))
      : initial(options.epochId, options.startedAt ?? this.now());
    if (this.state.schemaVersion !== SCHEMA)
      throw Error("RESEARCH_SCHEMA_MISMATCH");
    this.replayIndex();
    this.recover();
    // Allocate protected capacity before admitting research. Optional capture cannot consume it.
    const reserveBytes = options.reserveBytes ?? 128 * 1024 * 1024;
    if (
      reserveBytes &&
      !this.state.captureHalted &&
      !fs.existsSync(this.reserve)
    ) {
      const fd = fs.openSync(this.reserve, "wx", 0o600);
      try {
        const zero = Buffer.alloc(1024 * 1024);
        for (let n = 0; n < reserveBytes; n += zero.length)
          fs.writeSync(fd, zero, 0, Math.min(zero.length, reserveBytes - n));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    this.verifySegments();
    this.recoverAI();
    this.flush();
  }
  flush() {
    atomic(this.file, this.state);
    if (fs.existsSync(this.journal)) {
      const fd = fs.openSync(this.journal, "w");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    this.uncheckpointed = 0;
    return this.status();
  }
  replayIndex() {
    if (!fs.existsSync(this.journal)) return;
    const raw = fs.readFileSync(this.journal);
    let offset = 0;
    while (offset < raw.length) {
      const end = raw.indexOf(10, offset);
      if (end < 0) {
        fs.truncateSync(this.journal, offset);
        break;
      }
      const receipt = JSON.parse(raw.subarray(offset, end).toString());
      if (sha(receipt.data) !== receipt.sha256)
        throw Error("INDEX_JOURNAL_CHECKSUM_FAILED");
      const txn = JSON.parse(receipt.data);
      if (txn.nativeOnly)
        this.state.nativeEpisodeIndex[txn.nativeUpdate.key] =
          txn.nativeUpdate.value;
      else if (txn.meta.sequence > this.state.sequence) this.apply(txn);
      offset = end + 1;
    }
  }
  journalTransaction(txn) {
    const receipt = {
      nativeOnly: txn.nativeOnly,
      meta: txn.meta,
      segments: txn.segments,
      key: txn.key,
      signature: txn.signature,
      bytes: txn.bytes,
      nativeUpdate: txn.nativeUpdate,
    };
    const data = JSON.stringify(receipt),
      line = Buffer.from(JSON.stringify({ sha256: sha(data), data }) + "\n");
    const fd = fs.openSync(this.journal, "a", 0o600);
    try {
      writeAll(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.uncheckpointed++;
    return (
      this.uncheckpointed >= this.checkpointEvery ||
      fs.statSync(this.journal).size >= 8 * 1024 * 1024
    );
  }
  fail(error, stream, sourceEpisodeId = null, recordAttempt = false) {
    const reason = clean(
      error.code || error.message || "WRITER_UNAVAILABLE",
      this.secrets,
    );
    this.pendingFailure = { reason, stream, sourceEpisodeId, at: this.now() };
    this.state.populationComplete = false;
    this.state.captureHalted = true;
    this.state.lastError = { code: reason, at: this.now(), stream };
    if (recordAttempt && !fs.existsSync(path.join(this.wal, "commit.json"))) {
      this.state.attemptedRows++;
      this.state.lostRows++;
      this.state.lostByStream ??= {};
      this.state.lostByStream[stream] =
        (this.state.lostByStream[stream] || 0) + 1;
      this.state.attemptedByStream ??= {};
      this.state.attemptedByStream[stream] =
        (this.state.attemptedByStream[stream] || 0) + 1;
      const episode =
        this.state.episodes[this.state.sourceEpisodes?.[sourceEpisodeId]];
      if (episode) {
        episode.hasCriticalLoss = true;
        episode.state = "CENSORED";
        episode.reason = "CRITICAL_PERSISTENCE_FAILED:" + reason + ":" + stream;
      }
    }
    try {
      this.flush();
    } catch {}
    return false;
  }
  verifySegments() {
    for (const s of this.state.segments) {
      const f = path.join(this.dir, s.name);
      if (!fs.existsSync(f) || fs.statSync(f).size !== s.bytes)
        throw Object.assign(Error("SEGMENT_MISSING_OR_TRUNCATED"), {
          code: "SEGMENT_MISSING_OR_TRUNCATED",
        });
    }
  }
  recover() {
    const meta = path.join(this.wal, "commit.json");
    if (!fs.existsSync(meta)) {
      for (const n of fs.readdirSync(this.wal))
        fs.unlinkSync(path.join(this.wal, n));
      return;
    }
    const txn = JSON.parse(fs.readFileSync(meta, "utf8"));
    for (const part of txn.parts) {
      const f = path.join(this.dir, part.segment),
        b = fs.readFileSync(path.join(this.wal, part.name));
      if (sha(b) !== part.sha256) throw Error("WAL_CHECKSUM_MISMATCH");
      const size = fs.existsSync(f) ? fs.statSync(f).size : 0;
      if (size < part.offset) throw Error("WAL_OFFSET_GAP");
      const fd = fs.openSync(f, fs.existsSync(f) ? "r+" : "w+", 0o600);
      try {
        if (size > part.offset) {
          const old = Buffer.alloc(b.length);
          fs.readSync(fd, old, 0, old.length, part.offset);
          if (size >= part.offset + b.length && old.equals(b)) continue;
          fs.ftruncateSync(fd, part.offset);
        }
        writeAll(fd, b, part.offset);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    if (this.state.sequence < txn.meta.sequence) {
      const checkpoint = this.journalTransaction(txn);
      this.apply(txn);
      if (checkpoint) this.flush();
    }
    if (process.platform !== "win32") {
      const fd = fs.openSync(this.dir, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    fs.unlinkSync(meta);
    for (const n of fs.readdirSync(this.wal))
      fs.unlinkSync(path.join(this.wal, n));
  }
  apply(txn) {
    const { meta, segments, key, signature, bytes, nativeUpdate } = txn;
    this.state.sequence = meta.sequence;
    this.state.attemptedRows++;
    this.state.attemptedByStream ??= {};
    this.state.attemptedByStream[meta.stream] =
      (this.state.attemptedByStream[meta.stream] || 0) + 1;
    this.state.acceptedRows++;
    this.state.persistedRows++;
    this.state.acceptedBytes += bytes;
    this.state.countsByStream[meta.stream] =
      (this.state.countsByStream[meta.stream] || 0) + 1;
    this.state.bytesByStream[meta.stream] =
      (this.state.bytesByStream[meta.stream] || 0) + bytes;
    this.state.segments = segments;
    this.state.retainedBytes = segments.reduce((n, s) => n + s.bytes, 0);
    this.state.events[meta.eventId] = meta;
    if (key) this.state.dedupe[key] = { signature, eventId: meta.eventId };
    if (nativeUpdate)
      this.state.nativeEpisodeIndex[nativeUpdate.key] = nativeUpdate.value;
    if (meta.stream === "integrity" && meta.aiEvent === "EPOCH_OPENED") {
      this.state.openedEpochs ??= {};
      this.state.openedEpochs[meta.epochId] = meta.eventId;
    }
    if (meta.excursion && meta.tradeId) {
      this.state.extremes ??= {};
      this.state.extremes[meta.tradeId] = meta.excursion;
    }
    if (meta.attemptId) {
      this.state.aiAttempts ??= {};
      this.state.aiAttempts[meta.attemptId] = {
        ...(this.state.aiAttempts[meta.attemptId] || {}),
        ...meta,
      };
    }
    if (meta.sourceEpisodeId) {
      this.state.episodeMetadata[meta.sourceEpisodeId] = {
        ...(this.state.episodeMetadata[meta.sourceEpisodeId] || {}),
        ...Object.fromEntries(
          Object.entries(meta.context || {}).filter(([, v]) => v !== undefined),
        ),
      };
      const id = meta.episodeId;
      let e = this.state.episodes[id] || {
        state: "OPEN",
        originEventId: meta.eventId,
        epochId: meta.epochId,
        controlResolved: false,
        hasCriticalLoss: meta.stream !== "decisions",
        reason:
          meta.stream !== "decisions" ? "EPISODE_ORIGIN_NOT_CAPTURED" : null,
      };
      this.state.sourceEpisodes ??= {};
      this.state.sourceEpisodes[meta.sourceEpisodeId] = id;
      if (meta.stream === "decisions" && !e.hasDecision) {
        this.state.uniqueDecisionEpisodes =
          (this.state.uniqueDecisionEpisodes || 0) + 1;
        e.hasDecision = true;
      }
      e.latestEventId = meta.eventId;
      if (meta.stream === "decisions") e.latestDecisionId = meta.eventId;
      e.arms ??= {};
      e.controls ??= {};
      if (meta.armId) e.arms[meta.armId] = meta.armResolved;
      if (meta.stream === "decisions" && meta.admission) {
        if (["REJECT", "REJECTED", "REJECT_SHADOW"].includes(meta.admission))
          e.controlResolved = true;
        else if (meta.boundary === "ADMISSION_ATTEMPT" || !e.controlResolved)
          e.controlResolved = false;
      }
      if (meta.tradeId && ["lifecycle", "outcomes"].includes(meta.stream))
        e.controls[meta.tradeId] = meta.terminal;
      if (meta.terminal && meta.stream !== "experiments")
        e.controlResolved = true;
      if (meta.censored) {
        e.hasCriticalLoss = true;
        e.reason = meta.reason || e.reason || "CRITICAL_CHAIN_CENSORED";
      }
      const resolved =
        e.controlResolved &&
        Object.values(e.arms).every(Boolean) &&
        Object.values(e.controls).every(Boolean);
      e.state = e.hasCriticalLoss ? "CENSORED" : resolved ? "COMPLETE" : "OPEN";
      if (!e.hasCriticalLoss)
        e.reason = resolved
          ? "ALL_KNOWN_ENDPOINTS_RESOLVED"
          : "AWAITING_CONTROL_OR_EXPERIMENT_ENDPOINT";
      this.state.episodes[id] = e;
    }
    this.state.latestEventId = meta.eventId;
    this.state.latestAt = meta.at;
    this.state.earliestAt ??= meta.at;
  }
  emit(stream, record, options = {}) {
    const canonical = STREAMS[stream] || stream,
      optional = canonical === "telemetry";
    if (
      options.key &&
      this.state.dedupe[options.key]?.signature === options.signature
    )
      return false;
    if (optional && (this.state.captureHalted || this.pressured())) {
      this.state.optionalSuppressed++;
      return false;
    }
    try {
      this.recover();
      const at = record.at ?? this.now(),
        sequence = this.state.sequence + 1,
        sourceEpisodeId =
          record.sourceEpisodeId ??
          record.episodeId ??
          record.candidate_episode_id ??
          (["lifecycle", "outcomes"].includes(canonical) && record.tradeId
            ? "INHERITED_UNLINKED_TRADE:" + record.tradeId
            : null);
      this.state.sourceEpisodes ??= {};
      const episodeId = sourceEpisodeId
        ? this.state.sourceEpisodes[sourceEpisodeId] ||
          this.state.epochId + ":" + sourceEpisodeId
        : null;
      const row = clean(
        {
          ...record,
          stream: canonical,
          sourceStream: stream,
          schemaVersion: SCHEMA,
          writerDefinitionId: this.writerDefinitionId || null,
          epochId: this.state.epochId,
          sourceEpisodeId,
          episodeId,
          eventId: this.state.epochId + ":" + sequence,
          sequence,
          at,
          utc: new Date(at).toISOString(),
          receivedAt: this.now(),
          persistedAt: this.now(),
        },
        this.secrets,
      );
      const buffer = Buffer.from(JSON.stringify(row)),
        chunks = Math.ceil(buffer.length / CHUNK),
        hash = sha(buffer);
      const meta = {
        eventId: row.eventId,
        sequence,
        at,
        day: dayAt(row.persistedAt, this.timezone),
        stream: canonical,
        sourceStream: stream,
        epochId: row.epochId,
        episodeId,
        sourceEpisodeId,
        boundary: row.boundary,
        excursion: row.excursion,
        tradeId: row.tradeId,
        admission: row.admission,
        armId:
          canonical === "experiments"
            ? [row.controlTradeId || row.tradeId, row.policy].join(":")
            : null,
        armResolved:
          canonical === "experiments" &&
          (row.complete === true ||
            row.endpoint?.outcomeComplete === true ||
            [
              "SUPPRESSED",
              "INELIGIBLE",
              "DORMANT",
              "REJECTED_BY_BUFFER_GEOMETRY",
              "REJECTED_BY_REPLACEMENT_GEOMETRY",
            ].includes(row.status)),
        sha256: hash,
        chunks,
        bytes: buffer.length,
        attemptId: row.attemptId,
        evaluationId: row.evaluationId,
        provider: row.provider,
        aiEvent: row.event,
        definitionId:
          canonical === "definitions"
            ? row.definitionId || row.configHash
            : null,
        dependencyIds: [
          ...new Set([
            ...(row.dependencyIds || []),
            ...(canonical !== "definitions" && this.writerDefinitionId
              ? [this.writerDefinitionId]
              : []),
            ...(canonical !== "definitions" && row.configHash
              ? [row.configHash]
              : []),
          ]),
        ],
        terminal:
          row.completeness === "CENSORED" ||
          row.event === "LEGACY_EVIDENCE" ||
          row.status === "DATA_GAP" ||
          row.outcomeComplete === true ||
          (row.outcomeComplete !== false &&
            ["CLOSED", "CANCELLED", "EXPIRED", "NO_ORDER"].includes(
              row.status,
            )) ||
          row.transitions?.includes("NO_ORDER"),
        censored:
          row.completeness === "CENSORED" ||
          row.event === "LEGACY_EVIDENCE" ||
          row.status === "DATA_GAP",
        reason:
          row.censorReason ||
          row.reasonCode ||
          row.reason ||
          row.closeReason ||
          row.outcome,
        context: {
          symbol: row.symbol,
          side: row.side,
          configHash: row.configHash,
        },
      };
      const segments = this.state.segments.map((s) => ({ ...s })),
        parts = [];
      for (let i = 0; i < chunks; i++) {
        const line = Buffer.from(
          JSON.stringify({
            meta,
            index: i,
            data: buffer
              .subarray(i * CHUNK, (i + 1) * CHUNK)
              .toString("base64"),
          }) + "\n",
        );
        let s = segments.at(-1);
        if (
          !s ||
          s.day !== meta.day ||
          s.bytes + line.length > this.segmentBytes ||
          row.persistedAt - s.startedAt >= this.segmentMs
        ) {
          s = {
            name: "segment-" + meta.day + "-" + sequence + "-" + i + ".jsonl",
            day: meta.day,
            bytes: 0,
            startedAt: row.persistedAt,
          };
          segments.push(s);
        }
        const name = "part-" + i + ".jsonl",
          fd = fs.openSync(path.join(this.wal, name), "w", 0o600);
        try {
          writeAll(fd, line);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        parts.push({
          name,
          segment: s.name,
          offset: s.bytes,
          sha256: sha(line),
        });
        s.bytes += line.length;
      }
      atomic(path.join(this.wal, "commit.json"), {
        meta,
        parts,
        segments,
        key: options.key,
        signature: options.signature,
        bytes: buffer.length,
        nativeUpdate: options.nativeUpdate,
      });
      this.recover();
      return true;
    } catch (error) {
      // Only existing-episode transitions/outcomes may consume protected reserve.
      if (
        !options.reserveRetry &&
        record.event !== "REQUEST_PREPARED" &&
        record.ledgerRecord?.record_type !== "REQUEST_STARTED" &&
        [
          "lifecycle",
          "outcomes",
          "experiments",
          "ai_calls",
          "integrity",
        ].includes(canonical) &&
        fs.existsSync(this.reserve)
      ) {
        try {
          fs.unlinkSync(this.reserve);
          this.state.captureHalted = true;
          this.state.lastError = {
            code: error.code || "PROTECTED_CAPACITY_IN_USE",
            stream: canonical,
            at: this.now(),
          };
          this.flush();
          if (fs.existsSync(path.join(this.wal, "commit.json"))) {
            this.recover();
            return true;
          }
          return this.emit(stream, record, { ...options, reserveRetry: true });
        } catch {}
      }
      return this.fail(
        error,
        canonical,
        record.sourceEpisodeId || record.episodeId || null,
        true,
      );
    }
  }
  pressured() {
    if (this.options.freeBytes)
      return (
        this.options.freeBytes() <
        (this.options.admissionHeadroom ?? 128 * 1024 * 1024)
      );
    if (typeof fs.statfsSync === "function") {
      const s = fs.statfsSync(this.dir);
      return (
        s.bavail * s.bsize <
        (this.options.admissionHeadroom ?? 128 * 1024 * 1024)
      );
    }
    return false;
  }
  canAdmit(mode) {
    if (String(mode).toUpperCase() === "LIVE") return true;
    return !this.state.captureHalted && !this.pressured();
  }
  canDispatch() {
    return this.canAdmit("SHADOW");
  }
  nativeState(key, value) {
    if (
      JSON.stringify(this.state.nativeEpisodeIndex[key]) ===
      JSON.stringify(value)
    )
      return true;
    try {
      const checkpoint = this.journalTransaction({
        nativeOnly: true,
        nativeUpdate: { key, value },
      });
      this.state.nativeEpisodeIndex[key] = value;
      if (checkpoint) this.flush();
      return true;
    } catch (e) {
      return this.fail(e, "integrity");
    }
  }
  health(error, context = {}) {
    return this.emit("integrity", {
      at: context.at ?? this.now(),
      errorCode: error.code || error.message || String(error),
      ...clean(context, this.secrets),
    });
  }
  status() {
    return {
      schemaVersion: SCHEMA,
      epochId: this.state.epochId,
      startedAt: this.state.startedAt,
      sequence: this.state.sequence,
      attemptedRows: this.state.attemptedRows,
      acceptedRows: this.state.acceptedRows,
      persistedRows: this.state.persistedRows,
      archivedRows: this.state.archivedRows,
      lostRows: this.state.lostRows,
      optionalSuppressed: this.state.optionalSuppressed,
      acceptedBytes: this.state.acceptedBytes,
      retainedBytes: this.state.retainedBytes,
      retainedRows: Object.keys(this.state.events).length,
      countsByStream: this.state.countsByStream,
      bytesByStream: this.state.bytesByStream,
      populationComplete: this.state.populationComplete,
      captureHalted: !!this.state.captureHalted,
      health: this.state.captureHalted
        ? "RESEARCH CAPTURE HALTED"
        : this.pressured()
          ? "RESEARCH CAPTURE DEGRADED"
          : "HEALTHY",
      captureReason: this.state.captureHalted
        ? this.state.lastError?.code || "PROTECTED_CAPACITY_IN_USE"
        : this.pressured()
          ? "CAPACITY_HEADROOM"
          : null,
      affectedStreams: this.state.captureHalted
        ? [this.state.lastError?.stream || "CRITICAL_PERSISTENCE"]
        : this.pressured()
          ? ["NEW_RESEARCH_ADMISSIONS", "NEW_AI_DISPATCHES"]
          : [],
      lastError: this.state.lastError,
      pendingFailure: this.pendingFailure,
      pendingRows: fs.existsSync(path.join(this.wal, "commit.json")) ? 1 : 0,
      pendingBytes: fs
        .readdirSync(this.wal)
        .filter((n) => n.startsWith("part-"))
        .reduce((n, f) => n + fs.statSync(path.join(this.wal, f)).size, 0),
      segments: this.state.segments,
      archives: this.state.archives,
      timezone: this.timezone,
      uniqueDecisionEpisodes: this.state.uniqueDecisionEpisodes || 0,
      indexJournalBytes: fs.existsSync(this.journal)
        ? fs.statSync(this.journal).size
        : 0,
      episodeStates: Object.values(this.state.episodes).reduce(
        (a, e) => ((a[e.state] = (a[e.state] || 0) + 1), a),
        {},
      ),
      reconciliation: {
        attempted: this.state.attemptedRows,
        accepted: this.state.acceptedRows,
        persisted: this.state.persistedRows,
        archived: this.state.archivedRows,
      },
      reconciliationByStream: Object.fromEntries(
        [
          ...new Set([
            ...Object.keys(this.state.countsByStream),
            ...Object.keys(this.state.lostByStream || {}),
          ]),
        ].map((stream) => [
          stream,
          {
            critical: stream !== "telemetry",
            attempted: this.state.attemptedByStream?.[stream] || 0,
            accepted: this.state.countsByStream[stream] || 0,
            persisted: this.state.countsByStream[stream] || 0,
            archived: this.state.archivedByStream?.[stream] || 0,
            lost: this.state.lostByStream?.[stream] || 0,
          },
        ]),
      ),
      limits: {
        segmentBytes: this.segmentBytes,
        segmentMs: this.segmentMs,
        walChunkBytes: CHUNK,
        criticalDailyCap: null,
        indexCheckpointEvery: this.checkpointEvery,
        indexJournalBytes: 8 * 1024 * 1024,
      },
    };
  }
  epoch(id = crypto.randomUUID()) {
    if (this.state.epochId === id) {
      if (
        !this.state.openedEpochs?.[id] &&
        !this.emit("integrity", { event: "EPOCH_OPENED", at: this.now() })
      )
        throw Error("EPOCH_OPEN_NOT_PERSISTED");
      return id;
    }
    if (
      !this.emit("integrity", {
        event: "EPOCH_CLOSED",
        at: this.now(),
        nextEpochId: id,
      })
    )
      throw Error("EPOCH_CLOSE_NOT_PERSISTED");
    this.state.epochId = id;
    this.state.startedAt = this.now();
    this.flush();
    if (!this.emit("integrity", { event: "EPOCH_OPENED", at: this.now() }))
      throw Error("EPOCH_OPEN_NOT_PERSISTED");
    return id;
  }
  recoverAI() {
    for (const a of Object.values(this.state.aiAttempts || {}))
      if (
        ![
          "PARSED_RESPONSE",
          "TRANSPORT_ERROR",
          "INTERRUPTED_UNCERTAIN",
        ].includes(a.aiEvent)
      ) {
        if (
          !this.emit("ai_calls", {
            sourceEpisodeId: a.sourceEpisodeId,
            evaluationId: a.evaluationId,
            attemptId: a.attemptId,
            provider: a.provider,
            event: "INTERRUPTED_UNCERTAIN",
            disposition: "ERROR",
            completionUncertain: true,
            reason: "PROCESS_INTERRUPTED_BEFORE_FINAL_DISPOSITION",
            at: this.now(),
          })
        )
          throw Error("AI_INTERRUPTION_NOT_PERSISTED");
      }
  }
  async close() {
    this.flush();
  }
  async export() {
    return {
      status: this.status(),
      files: this.state.segments.map((s) => ({
        path: path.join(this.dir, s.name),
        size: s.bytes,
      })),
      watermark: this.state.latestEventId,
    };
  }
}
module.exports = { ResearchStore, SCHEMA, sha, atomic, clean, dayAt, CHUNK };
