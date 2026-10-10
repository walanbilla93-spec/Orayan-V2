"use strict";
const fs = require("fs"),
  path = require("path"),
  readline = require("readline");
const { Readable, Transform } = require("stream");
const { pipeline } = require("stream/promises");
const yazl = require("yazl"),
  yauzl = require("yauzl");
const { sha, atomic, dayAt, SCHEMA } = require("./researchStore");
const crypto = require("crypto");
async function zipEntries(file, visit) {
  const zip = await new Promise((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (e, z) =>
      e ? reject(e) : resolve(z),
    ),
  );
  try {
    await new Promise((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry) => {
        if (entry.fileName.endsWith("/")) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (e, s) => {
          if (e) {
            reject(e);
            return;
          }
          Promise.resolve(visit(entry.fileName, s)).then(
            () => zip.readEntry(),
            reject,
          );
        });
      });
      zip.readEntry();
    });
  } finally {
    // close() is asynchronous: retention and callers must not race an open ZIP fd.
    await new Promise((resolve) => {
      zip.once("close", resolve);
      zip.close();
    });
  }
}
async function* lines(stream) {
  const reader = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });
  try {
    for await (const line of reader) if (line) yield JSON.parse(line);
  } finally {
    reader.close();
    stream.destroy();
  }
}
async function visitPhysical(store, visit) {
  for (const archive of store.state.archives.filter((a) => !a.expired))
    await zipEntries(
      path.join(store.dir, "archives", archive.filename),
      async (name, s) => {
        if (!name.startsWith("records/")) {
          s.resume();
          return;
        }
        for await (const piece of lines(s)) await visit(piece);
      },
    );
  for (const segment of store.state.segments)
    for await (const piece of lines(
      fs.createReadStream(path.join(store.dir, segment.name), {
        end: segment.bytes - 1,
      }),
    ))
      await visit(piece);
}
async function rows(store, visit) {
  const chunks = new Map(),
    seen = new Set();
  await visitPhysical(store, (p) => {
    if (seen.has(p.meta.eventId)) return;
    let c = chunks.get(p.meta.eventId);
    if (!c) {
      c = [];
      chunks.set(p.meta.eventId, c);
    }
    c[p.index] = Buffer.from(p.data, "base64");
    if (c.filter(Boolean).length === p.meta.chunks) {
      const b = Buffer.concat(c);
      if (sha(b) !== p.meta.sha256) throw Error("EVENT_CHECKSUM_MISMATCH");
      seen.add(p.meta.eventId);
      chunks.delete(p.meta.eventId);
      return visit(JSON.parse(b.toString()));
    }
  });
  if (chunks.size) throw Error("INCOMPLETE_CRITICAL_CHUNKS");
}
function closure(store, selected, provider = null) {
  const all = Object.values(store.state.events),
    chosen = new Set(selected),
    episodes = new Set(),
    definitions = new Map(
      all.filter((e) => e.definitionId).map((e) => [e.definitionId, e.eventId]),
    );
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...chosen]) {
      const m = store.state.events[id];
      if (!m) throw Error("MISSING_EVENT_DEPENDENCY:" + id);
      if (m.episodeId) episodes.add(m.episodeId);
      for (const ref of m.dependencyIds || []) {
        const event = definitions.get(ref) || ref;
        if (!store.state.events[event])
          throw Error("MISSING_IMMUTABLE_DEPENDENCY:" + ref);
        if (!chosen.has(event)) {
          chosen.add(event);
          changed = true;
        }
      }
    }
    // Include causal history up to watermark. This includes independent experiment arms,
    // AI requests/responses, outcomes and original episode admissions outside the window.
    for (const m of all)
      if (
        m.episodeId &&
        episodes.has(m.episodeId) &&
        !chosen.has(m.eventId) &&
        (!provider || m.stream !== "ai_calls" || m.provider === provider)
      ) {
        chosen.add(m.eventId);
        changed = true;
      }
  }
  return chosen;
}
async function build(
  store,
  {
    day = null,
    sinceAt = null,
    untilAt = Date.now(),
    target = null,
    provider = null,
  } = {},
) {
  const watermark = store.state.sequence;
  const selected = Object.values(store.state.events)
    .filter(
      (e) =>
        e.sequence <= watermark &&
        (day ? e.day === day : e.at >= sinceAt && e.at <= untilAt) &&
        (!provider || e.provider === provider),
    )
    .map((e) => e.eventId);
  const openOrigins = day
    ? Object.values(store.state.episodes)
        .filter(
          (e) =>
            e.state === "OPEN" ||
            !e.controlResolved ||
            Object.values(e.arms || {}).some((v) => !v) ||
            Object.values(e.controls || {}).some((v) => !v),
        )
        .map((e) => e.originEventId)
    : [];
  const chosen = closure(store, [...selected, ...openOrigins], provider);
  const zip = new yazl.ZipFile(),
    temporary = target ? target + ".building" : null;
  const output = temporary
    ? fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 })
    : null;
  let pumping = output ? pipeline(zip.outputStream, output) : null;
  // Current downloads are generated in scratch space, never in the canonical volume.
  if (!output) throw Error("EXPORT_SCRATCH_TARGET_REQUIRED");
  zip.on("error", (e) => zip.outputStream.destroy(e));
  pumping.catch(() => {});
  const manifest = {
    schemaVersion: SCHEMA,
    timezone: store.timezone,
    day,
    window: { sinceAt, untilAt, provider },
    watermark,
    complete: false,
    windowEventIds: selected,
    dependencyEventIds: [...chosen].filter((x) => !selected.includes(x)),
    counts: {},
    entries: [],
    events: [...chosen].map((id) => store.state.events[id]),
    integrity: {
      reconciliation: store.status().reconciliation,
      episodeStates: store.status().episodeStates,
      criticalLoss: store.state.lostRows,
      optionalSuppression: store.state.optionalSuppressed,
      populationComplete: store.state.populationComplete,
    },
  };
  try {
    const source = {
      ...store,
      state: {
        ...store.state,
        segments: store.state.segments.map((x) => ({ ...x })),
        archives: store.state.archives.map((x) => ({ ...x })),
      },
    };
    const seen = new Set(),
      seenParts = new Set();
    for (const stream of new Set(manifest.events.map((e) => e.stream))) {
      const name = "records/" + stream + ".jsonl";
      zip.addReadStreamLazy(name, (cb) => {
        const hash = crypto.createHash("sha256");
        let bytes = 0;
        const pipe = new Transform({
          transform(b, encoding, done) {
            hash.update(b);
            bytes += b.length;
            done(null, b);
          },
          flush(done) {
            manifest.entries.push({ name, bytes, sha256: hash.digest("hex") });
            done();
          },
        });
        // Lazy ZIP visitation pushes one bounded physical row at a time with backpressure.
        async function* selectedPieces() {
          for (const archive of source.state.archives.filter(
            (a) => !a.expired,
          )) {
            const z = await new Promise((resolve, reject) =>
              yauzl.open(
                path.join(store.dir, "archives", archive.filename),
                { lazyEntries: true, autoClose: false },
                (e, x) => (e ? reject(e) : resolve(x)),
              ),
            );
            try {
              let next = () =>
                new Promise((resolve, reject) => {
                  const clear = () => {
                    z.removeListener("entry", entry);
                    z.removeListener("end", end);
                    z.removeListener("error", error);
                  };
                  const entry = (e) => {
                      clear();
                      resolve(e);
                    },
                    end = () => {
                      clear();
                      resolve(null);
                    },
                    error = (e) => {
                      clear();
                      reject(e);
                    };
                  z.once("entry", entry);
                  z.once("end", end);
                  z.once("error", error);
                  z.readEntry();
                });
              let e;
              while ((e = await next())) {
                if (e.fileName !== "records/" + stream + ".jsonl") continue;
                const s = await new Promise((resolve, reject) =>
                  z.openReadStream(e, (err, x) =>
                    err ? reject(err) : resolve(x),
                  ),
                );
                for await (const p of lines(s)) {
                  const key = p.meta.eventId + ":" + p.index;
                  if (chosen.has(p.meta.eventId) && !seenParts.has(key)) {
                    seenParts.add(key);
                    if (!seen.has(p.meta.eventId)) {
                      seen.add(p.meta.eventId);
                      manifest.counts[stream] =
                        (manifest.counts[stream] || 0) + 1;
                    }
                    yield Buffer.from(JSON.stringify(p) + "\n");
                  }
                }
              }
            } finally {
              z.close();
            }
          }
          for (const s of source.state.segments)
            for await (const p of lines(
              fs.createReadStream(path.join(store.dir, s.name), {
                end: s.bytes - 1,
              }),
            )) {
              const key = p.meta.eventId + ":" + p.index;
              if (
                p.meta.stream === stream &&
                chosen.has(p.meta.eventId) &&
                !seenParts.has(key)
              ) {
                seenParts.add(key);
                if (!seen.has(p.meta.eventId)) {
                  seen.add(p.meta.eventId);
                  manifest.counts[stream] = (manifest.counts[stream] || 0) + 1;
                }
                yield Buffer.from(JSON.stringify(p) + "\n");
              }
            }
        }
        pipeline(Readable.from(selectedPieces()), pipe).catch((e) =>
          pipe.destroy(e),
        );
        cb(null, pipe);
      });
    }
    const schemaBytes = Buffer.from(
      JSON.stringify({
        schemaVersion: SCHEMA,
        encoding: "lossless-base64-chunks",
        chunkChecksum: "sha256",
        streams: [
          "definitions",
          "decisions",
          "lifecycle",
          "outcomes",
          "experiments",
          "ai_calls",
          "integrity",
          "telemetry",
          "experiment_paths",
        ],
      }),
    );
    manifest.entries.push({
      name: "schema.json",
      bytes: schemaBytes.length,
      sha256: sha(schemaBytes),
    });
    zip.addBuffer(schemaBytes, "schema.json");
    zip.addReadStreamLazy("manifest.json", (cb) => {
      try {
        for (const id of chosen) {
          const m = store.state.events[id];
          for (let i = 0; i < m.chunks; i++)
            if (!seenParts.has(id + ":" + i))
              throw Error("ARCHIVE_MISSING_CHUNK:" + id);
        }
        manifest.complete = true;
        cb(null, Readable.from([Buffer.from(JSON.stringify(manifest))]));
      } catch (e) {
        cb(e);
      }
    });
    zip.end();
    await pumping;
    const fd = fs.openSync(temporary, "r+");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    await verify(temporary);
    fs.renameSync(temporary, target);
    return {
      manifest,
      sha256: await fileHash(target),
      bytes: fs.statSync(target).size,
    };
  } catch (e) {
    zip.outputStream.destroy(e);
    await pumping.catch(() => {});
    throw e;
  }
}
async function fileHash(file) {
  const h = crypto.createHash("sha256");
  for await (const b of fs.createReadStream(file)) h.update(b);
  return h.digest("hex");
}
async function verifyEntries(file) {
  let manifest,
    entries = new Map();
  await zipEntries(file, async (name, s) => {
    const h = crypto.createHash("sha256");
    let bytes = 0,
      data = [];
    for await (const b of s) {
      h.update(b);
      bytes += b.length;
      if (name === "manifest.json") data.push(b);
    }
    if (name === "manifest.json")
      manifest = JSON.parse(Buffer.concat(data).toString());
    else entries.set(name, { sha256: h.digest("hex"), bytes });
  });
  if (!manifest?.complete) throw Error("ARCHIVE_NOT_COMPLETE");
  for (const e of manifest.entries) {
    const actual = entries.get(e.name);
    if (!actual || actual.bytes !== e.bytes || actual.sha256 !== e.sha256)
      throw Error("ARCHIVE_CHECKSUM_FAILED");
  }
  return manifest;
}
async function verify(file) {
  const manifest = await verifyEntries(file),
    chunks = new Map(),
    seen = new Set(),
    counts = {};
  await zipEntries(file, async (name, s) => {
    if (!name.startsWith("records/")) {
      s.resume();
      return;
    }
    for await (const piece of lines(s)) {
      const { meta, index, data } = piece;
      let list = chunks.get(meta.eventId);
      if (!list) {
        list = [];
        chunks.set(meta.eventId, list);
      }
      if (seen.has(meta.eventId) || list[index])
        throw Error("ARCHIVE_DUPLICATE_CHUNK");
      list[index] = Buffer.from(data, "base64");
      if (list.filter(Boolean).length === meta.chunks) {
        const b = Buffer.concat(list);
        if (sha(b) !== meta.sha256)
          throw Error("ARCHIVE_EVENT_CHECKSUM_FAILED");
        const row = JSON.parse(b);
        if (row.eventId !== meta.eventId)
          throw Error("ARCHIVE_EVENT_ID_MISMATCH");
        seen.add(meta.eventId);
        chunks.delete(meta.eventId);
        counts[meta.stream] = (counts[meta.stream] || 0) + 1;
      }
    }
  });
  if (
    chunks.size ||
    seen.size !== manifest.events.length ||
    manifest.events.some((e) => !seen.has(e.eventId))
  )
    throw Error("ARCHIVE_EVENT_RECONCILIATION_FAILED");
  for (const [stream, count] of Object.entries(manifest.counts))
    if (counts[stream] !== count) throw Error("ARCHIVE_STREAM_COUNT_MISMATCH");
  const ids = new Set(manifest.events.map((e) => e.eventId)),
    definitions = new Set(
      manifest.events.filter((e) => e.definitionId).map((e) => e.definitionId),
    );
  for (const e of manifest.events)
    for (const d of e.dependencyIds || [])
      if (!ids.has(d) && !definitions.has(d))
        throw Error("ARCHIVE_DEPENDENCY_MISSING");
  return manifest;
}
// Qualification keeps published evidence and its source/index addressable.
function preservationEnabled() {
  return process.env.RESEARCH_PRESERVE_EVIDENCE === "true";
}
async function closeDay(store, day) {
  if (store.state.archives.some((a) => a.day === day && !a.expired))
    return store.state.archives.find((a) => a.day === day && !a.expired);
  if (day >= dayAt(Date.now(), store.timezone))
    throw Error("DAY_NOT_COMPLETED");
  const filename = "orayan-research-" + day + ".zip",
    target = path.join(store.dir, "archives", filename);
  // Failed/interrupted builds never have a published ZIP name. Rebuild on restart.
  if (fs.existsSync(target + ".building")) fs.unlinkSync(target + ".building");
  let result;
  if (fs.existsSync(target)) {
    const manifest = await verify(target);
    result = {
      manifest,
      sha256: await fileHash(target),
      bytes: fs.statSync(target).size,
    };
  } else result = await build(store, { day, target });
  const archived = new Set(result.manifest.windowEventIds),
    receipt = {
      day,
      filename,
      sha256: result.sha256,
      bytes: result.bytes,
      verified: true,
      published: true,
      eventIds: [...archived],
    };
  store.state.archives.push(receipt);
  store.state.lastClosedDay = day;
  store.state.archivedRows += archived.size;
  store.state.archivedByStream ??= {};
  for (const id of archived) {
    const stream = store.state.events[id].stream;
    store.state.archivedByStream[stream] =
      (store.state.archivedByStream[stream] || 0) + 1;
  }
  store.flush();
  if (preservationEnabled()) return receipt;
  // Publication is addressable by the backend's download route; only now release
  // redundant sealed source segments. New writes always enter the current date.
  const releasable = store.state.segments.filter((s) => s.day === day);
  store.state.segments = store.state.segments.filter((s) => s.day !== day);
  store.flush();
  store.state.garbageSegments ??= [];
  store.state.garbageSegments.push(...releasable.map((s) => s.name));
  store.flush();
  await collectGarbage(store);
  return receipt;
}
async function retention(store) {
  if (preservationEnabled()) return;
  if (store.exportReaders) return;
  const active = store.state.archives
    .filter((a) => !a.expired)
    .sort((a, b) => a.day.localeCompare(b.day));
  if (active.length <= 7) return;
  for (const old of active.slice(0, -7)) {
    if (!old.verified || !old.published)
      throw Error("RETENTION_PUBLICATION_GATE");
    const file = path.join(store.dir, "archives", old.filename);
    await verify(file);
    if ((await fileHash(file)) !== old.sha256)
      throw Error("RETENTION_CHECKSUM_GATE");
    // Newer canonical archives carry dependency closure before older data expires.
    const survivors = new Set();
    for (const a of active.filter((a) => a.day > old.day)) {
      const m = await verify(path.join(store.dir, "archives", a.filename));
      for (const e of m.events) survivors.add(e.eventId);
    }
    for (const [id, e] of Object.entries(store.state.events))
      if (
        e.day === old.day &&
        !survivors.has(id) &&
        store.state.episodes[e.episodeId]?.state === "OPEN"
      )
        throw Error("RETENTION_OPEN_EPISODE_DEPENDENCY");
    old.expired = true;
    store.flush();
    fs.unlinkSync(file);
    for (const [id, e] of Object.entries(store.state.events))
      if (
        e.day <= old.day &&
        !survivors.has(id) &&
        !store.state.segments.some((s) => s.day === e.day)
      ) {
        delete store.state.events[id];
        for (const [key, d] of Object.entries(store.state.dedupe))
          if (d.eventId === id) delete store.state.dedupe[key];
      }
    const retainedEpisodes = new Set(
      Object.values(store.state.events).map((e) => e.episodeId),
    );
    for (const [id, e] of Object.entries(store.state.episodes))
      if (e.state !== "OPEN" && !retainedEpisodes.has(id)) {
        delete store.state.episodes[id];
        for (const [source, mapped] of Object.entries(
          store.state.sourceEpisodes || {},
        ))
          if (mapped === id) {
            delete store.state.sourceEpisodes[source];
            delete store.state.episodeMetadata[source];
          }
        for (const [key, value] of Object.entries(
          store.state.nativeEpisodeIndex,
        ))
          if (value.episodeId && id.endsWith(":" + value.episodeId))
            delete store.state.nativeEpisodeIndex[key];
      }
    for (const [id, a] of Object.entries(store.state.aiAttempts || {}))
      if (!store.state.events[a.eventId]) delete store.state.aiAttempts[id];
    const retainedTrades = new Set(
      Object.values(store.state.events).map((e) => e.tradeId),
    );
    for (const id of Object.keys(store.state.extremes || {}))
      if (!retainedTrades.has(id)) delete store.state.extremes[id];
    store.flush();
  }
}
async function collectGarbage(store) {
  if (preservationEnabled()) return;
  if (store.exportReaders || !store.state.garbageSegments?.length) return;
  for (const name of store.state.garbageSegments || []) {
    const file = path.join(store.dir, name);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  store.state.garbageSegments = [];
  store.flush();
}
function compactIndex(store) {
  if (preservationEnabled()) return;
  if (
    !store.state.lastClosedDay ||
    store.state.indexCompactedThroughDay === store.state.lastClosedDay
  )
    return;
  const cutoff = new Date(
    Date.parse(store.state.lastClosedDay + "T12:00:00Z") - 2 * 86400000,
  )
    .toISOString()
    .slice(0, 10);
  const roots = Object.values(store.state.events)
    .filter(
      (e) => e.day >= cutoff || e.definitionId === store.writerDefinitionId,
    )
    .map((e) => e.eventId);
  for (const e of Object.values(store.state.episodes))
    if (
      e.state === "OPEN" ||
      !e.controlResolved ||
      Object.values(e.arms || {}).some((v) => !v) ||
      Object.values(e.controls || {}).some((v) => !v)
    )
      roots.push(e.originEventId);
  const keep = closure(store, roots);
  let changed = false;
  for (const [id, e] of Object.entries(store.state.events))
    if (!keep.has(id) && !store.state.segments.some((s) => s.day === e.day)) {
      delete store.state.events[id];
      changed = true;
      for (const [key, value] of Object.entries(store.state.dedupe))
        if (value.eventId === id) delete store.state.dedupe[key];
    }
  const episodes = new Set(
    Object.values(store.state.events).map((e) => e.episodeId),
  );
  for (const [id, e] of Object.entries(store.state.episodes))
    if (!episodes.has(id) && e.state !== "OPEN") {
      delete store.state.episodes[id];
      for (const [source, mapped] of Object.entries(
        store.state.sourceEpisodes || {},
      ))
        if (mapped === id) {
          delete store.state.sourceEpisodes[source];
          delete store.state.episodeMetadata[source];
        }
      for (const [key, value] of Object.entries(store.state.nativeEpisodeIndex))
        if (value.episodeId && id.endsWith(":" + value.episodeId))
          delete store.state.nativeEpisodeIndex[key];
    }
  for (const [id, a] of Object.entries(store.state.aiAttempts || {}))
    if (!store.state.events[a.eventId]) delete store.state.aiAttempts[id];
  const trades = new Set(
    Object.values(store.state.events).map((e) => e.tradeId),
  );
  for (const id of Object.keys(store.state.extremes || {}))
    if (!trades.has(id)) delete store.state.extremes[id];
  store.state.indexCompactedThroughDay = store.state.lastClosedDay;
  store.flush();
}
async function tick(store, now = Date.now()) {
  const today = dayAt(now, store.timezone),
    next = (day) =>
      new Date(Date.parse(day + "T12:00:00Z") + 86400000)
        .toISOString()
        .slice(0, 10);
  let day = store.state.lastClosedDay
    ? next(store.state.lastClosedDay)
    : dayAt(store.state.startedAt, store.timezone);
  for (const old of [...new Set(store.state.segments.map((s) => s.day))].sort())
    if (old < day && old < today) await closeDay(store, old);
  while (day < today) {
    await closeDay(store, day);
    day = next(day);
  }
  await retention(store);
  compactIndex(store);
  await collectGarbage(store);
}
module.exports = {
  preservationEnabled,
  build,
  verify,
  closeDay,
  retention,
  tick,
  rows,
  visitPhysical,
  fileHash,
  closure,
  collectGarbage,
  compactIndex,
};
