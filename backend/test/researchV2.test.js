"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs"),
  path = require("path"),
  os = require("os");
const { ResearchStore, sha, dayAt } = require("../lib/researchStore"),
  archive = require("../lib/researchArchive");
function temporary(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "research-v2-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
function store(t, o = {}) {
  return new ResearchStore(temporary(t), {
    epochId: "E",
    reserveBytes: 0,
    ...o,
  });
}
test("decision denominator and identity survive restart and epoch without losing history", async (t) => {
  const c = store(t);
  assert.equal(
    c.emit(
      "decision_episode",
      { sourceEpisodeId: "A", boundary: "BIRTH" },
      { key: "birth:A", signature: "A" },
    ),
    true,
  );
  c.nativeState("native", { episodeId: "A", at: 1 });
  let d = new ResearchStore(c.dir, { reserveBytes: 0 });
  assert.equal(
    d.emit(
      "decision_episode",
      { sourceEpisodeId: "A" },
      { key: "birth:A", signature: "A" },
    ),
    false,
  );
  assert.equal(d.state.nativeEpisodeIndex.native.episodeId, "A");
  d.epoch("NEW");
  d.emit("trade_lifecycle", {
    sourceEpisodeId: "A",
    status: "CLOSED",
    outcomeComplete: true,
  });
  assert.equal(d.state.episodes["E:A"].state, "COMPLETE");
  assert.equal(d.state.acceptedRows, 4);
});
test("more than 20 MiB critical data reconstructs with bounded segments and WAL chunks", async (t) => {
  const c = store(t),
    payload = "日本🌈".repeat(2200000);
  assert.ok(Buffer.byteLength(payload) > 20 * 1024 * 1024);
  assert.equal(c.emit("ai_calls", { sourceEpisodeId: "A", payload }), true);
  assert.ok(c.state.segments.every((s) => s.bytes <= 8 * 1024 * 1024));
  assert.equal(fs.readdirSync(c.wal).length, 0);
  let actual;
  await archive.rows(c, (row) => {
    actual = row.payload;
  });
  assert.equal(actual, payload);
  assert.equal(c.state.lostRows, 0);
  assert.equal(c.state.acceptedRows, c.state.persistedRows);
});
test("critical burst does not use an asynchronous queue cap", (t) => {
  const c = store(t);
  for (let i = 0; i < 1100; i++)
    assert.equal(
      c.emit("trade_lifecycle", {
        sourceEpisodeId: "A",
        tradeId: "T",
        index: i,
      }),
      true,
    );
  assert.equal(c.status().pendingRows, 0);
  assert.equal(c.state.lostRows, 0);
  assert.equal(c.state.persistedRows, 1100);
});
test("WAL recovers an interrupted committed append exactly once", (t) => {
  const c = store(t),
    original = c.recover;
  c.recover = function () {
    if (fs.existsSync(path.join(c.wal, "commit.json")))
      throw Object.assign(Error("crash"), { code: "EIO" });
    return original.call(c);
  };
  assert.equal(c.emit("decisions", { sourceEpisodeId: "A" }), false);
  const next = new ResearchStore(c.dir, { reserveBytes: 0 });
  assert.equal(next.state.persistedRows, 1);
  assert.equal(fs.readdirSync(next.wal).length, 0);
  const again = new ResearchStore(c.dir, { reserveBytes: 0 });
  assert.equal(again.state.persistedRows, 1);
});
for (const code of ["ENOSPC", "EIO", "EACCES"])
  test(
    code + " stops research intake and leaves LIVE behavior available",
    (t) => {
      const c = store(t),
        write = fs.openSync;
      fs.openSync = function (f, ...a) {
        if (String(f).startsWith(c.wal))
          throw Object.assign(Error(code), { code });
        return write.call(fs, f, ...a);
      };
      try {
        assert.equal(c.emit("decisions", { sourceEpisodeId: "A" }), false);
      } finally {
        fs.openSync = write;
      }
      assert.equal(c.canAdmit("PAPER"), false);
      assert.equal(c.canAdmit("SHADOW"), false);
      assert.equal(c.canAdmit("LIVE"), true);
      assert.equal(c.canDispatch(), false);
      assert.equal(c.status().lastError.code, code);
      assert.equal(
        c.emit("outcomes", {
          sourceEpisodeId: "EXISTING",
          status: "CLOSED",
          outcomeComplete: true,
        }),
        true,
      );
    },
  );
test("optional telemetry yields before critical outcomes under capacity pressure", (t) => {
  const c = store(t, { freeBytes: () => 1 });
  assert.equal(c.emit("telemetry", { data: "optional" }), false);
  assert.equal(c.emit("outcomes", { data: "critical" }), true);
  assert.equal(c.status().optionalSuppressed, 1);
  assert.equal(c.state.lostRows, 0);
  assert.equal(c.canAdmit("LIVE"), true);
});
test("midnight Asia/Colombo boundary retains UTC event clock", () => {
  assert.equal(dayAt(Date.parse("2026-10-08T18:29:59Z")), "2026-10-08");
  assert.equal(dayAt(Date.parse("2026-10-08T18:30:00Z")), "2026-10-09");
  assert.equal(dayAt(Date.parse("2026-10-08T18:30:00Z"), "UTC"), "2026-10-08");
});
test("current ZIP closes dependencies outside window and verifies all checksums", async (t) => {
  let at = Date.parse("2026-10-01T01:00:00Z");
  const c = store(t, { now: () => at });
  c.emit("definitions", { definitionId: "PROMPT", definition: "p" });
  c.emit("decisions", { sourceEpisodeId: "A", at, dependencyIds: ["PROMPT"] });
  at += 3 * 86400000;
  c.emit("ai_calls", {
    sourceEpisodeId: "A",
    at,
    event: "RAW_RESPONSE",
    rawResponse: "exact",
  });
  const file = path.join(temporary(t), "current.zip");
  await archive.build(c, {
    sinceAt: at - 30 * 3600000,
    untilAt: at,
    target: file,
  });
  const m = await archive.verify(file);
  assert.equal(m.windowEventIds.length, 1);
  assert.equal(m.dependencyEventIds.length, 2);
  assert.equal(m.events.length, 3);
  assert.equal(fs.existsSync(file + ".building"), false);
});
test("interrupted archive is not published; missing dependency blocks close", async (t) => {
  const c = store(t);
  c.emit("decisions", { sourceEpisodeId: "A", dependencyIds: ["ABSENT"] });
  const file = path.join(temporary(t), "fail.zip");
  await assert.rejects(
    archive.build(c, { sinceAt: 0, target: file }),
    /MISSING_IMMUTABLE_DEPENDENCY/,
  );
  assert.equal(fs.existsSync(file), false);
});
test("seven completed archives survive gated expiration; epoch preserves archive and AI hashes", async (t) => {
  let at = Date.parse("2026-09-01T01:00:00Z");
  const c = store(t, { now: () => at });
  for (let i = 0; i < 8; i++) {
    const day = dayAt(at);
    c.emit("ai_calls", {
      sourceEpisodeId: "A" + i,
      at,
      rawResponse: "provider-" + i,
      status: "CLOSED",
      outcomeComplete: true,
    });
    await archive.closeDay(c, day);
    at += 86400000;
  }
  assert.equal(c.state.archivedRows, 8);
  const first = c.state.archives[0];
  first.published = false;
  await assert.rejects(archive.retention(c), /RETENTION_PUBLICATION_GATE/);
  assert.equal(
    fs.existsSync(path.join(c.dir, "archives", first.filename)),
    true,
  );
  first.published = true;
  await archive.retention(c);
  assert.equal(c.state.archives.filter((a) => !a.expired).length, 7);
  const hashes = await Promise.all(
    c.state.archives
      .filter((a) => !a.expired)
      .map((a) => archive.fileHash(path.join(c.dir, "archives", a.filename))),
  );
  c.epoch();
  const after = await Promise.all(
    c.state.archives
      .filter((a) => !a.expired)
      .map((a) => archive.fileHash(path.join(c.dir, "archives", a.filename))),
  );
  assert.deepEqual(after, hashes);
});
test("secret exclusion retains token usage and raw provider content otherwise", async (t) => {
  const c = store(t, { secrets: ["fake-credential"] });
  c.emit("ai_calls", {
    apiKey: "fake-credential",
    rawResponse: "value fake-credential",
    tokens: { prompt: 4, total: 8 },
    authorization: "Bearer fake-credential",
  });
  let row;
  await archive.rows(c, (x) => {
    row = x;
  });
  assert.equal(row.apiKey, undefined);
  assert.equal(row.authorization, undefined);
  assert.equal(row.rawResponse, "value [REDACTED_SECRET]");
  assert.equal(row.tokens.total, 8);
});
test("legacy destructive reset is rejected without touching history", (t) => {
  const d = temporary(t),
    file = path.join(d, "capture-reset-request.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ schemaVersion: "ORAYAN_MINIMAL_CAPTURE_V1" }),
  );
  fs.writeFileSync(path.join(d, "AI.jsonl"), "legacy");
  assert.throws(
    () => require("../lib/startupCaptureReset").run(d),
    /DESTRUCTIVE_LEGACY_RESET_DISABLED/,
  );
  assert.equal(fs.readFileSync(path.join(d, "AI.jsonl"), "utf8"), "legacy");
});

test("actual writer process death after WAL commit recovers a critical event exactly once", async (t) => {
  const dir = temporary(t),
    module = path.resolve(__dirname, "../lib/researchStore.js");
  const script = `const fs=require('fs');const {ResearchStore}=require(${JSON.stringify(module)});const c=new ResearchStore(${JSON.stringify(dir)},{reserveBytes:0});const rename=fs.renameSync;fs.renameSync=(a,b)=>{rename(a,b);if(String(b).endsWith('commit.json'))process.exit(23);};c.emit('ai_calls',{sourceEpisodeId:'EP',rawResponse:'exact response'});`;
  const result = require("child_process").spawnSync(
    process.execPath,
    ["-e", script],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 23, result.stderr);
  const c = new ResearchStore(dir, { reserveBytes: 0 }),
    rows = [];
  await archive.rows(c, (r) => rows.push(r));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rawResponse, "exact response");
  assert.equal(c.state.persistedRows, 1);
  new ResearchStore(dir, { reserveBytes: 0 });
  assert.equal(c.state.lostRows, 0);
});
test("short disk writes reconstruct critical bytes without truncation", async (t) => {
  const c = store(t),
    write = fs.writeSync;
  fs.writeSync = (fd, b, offset, length, position) =>
    typeof b === "string"
      ? write(fd, b, offset, length)
      : write(fd, b, offset ?? 0, Math.min(length ?? b.length, 17), position);
  try {
    assert.equal(c.emit("ai_calls", { payload: "日本🌈".repeat(100) }), true);
  } finally {
    fs.writeSync = write;
  }
  const rows = [];
  await archive.rows(c, (r) => rows.push(r));
  assert.equal(rows[0].payload, "日本🌈".repeat(100));
});
test("daily close keeps source files pinned until concurrent current export finishes", async (t) => {
  const c = store(t, { now: () => Date.parse("2026-09-01T01:00:00Z") });
  c.emit("decisions", { sourceEpisodeId: "A", transitions: ["NO_ORDER"] });
  const segment = path.join(c.dir, c.state.segments[0].name);
  c.exportReaders = 1;
  await archive.closeDay(c, "2026-09-01");
  assert.equal(fs.existsSync(segment), true);
  c.exportReaders = 0;
  await archive.collectGarbage(c);
  assert.equal(fs.existsSync(segment), false);
});
test("episode stays OPEN after control endpoint until independent treatment horizon resolves", (t) => {
  const c = store(t);
  c.emit("decisions", { sourceEpisodeId: "A", admission: "ACCEPT_SHADOW" });
  c.emit("lifecycle", { sourceEpisodeId: "A", tradeId: "T", status: "OPEN" });
  c.emit("experiments", {
    sourceEpisodeId: "A",
    controlTradeId: "T",
    policy: "ATR1M_1P5_REPLACEMENT",
    status: "PENDING",
    complete: false,
  });
  c.emit("lifecycle", {
    sourceEpisodeId: "A",
    tradeId: "T",
    status: "CLOSED",
    outcomeComplete: true,
  });
  assert.equal(c.state.episodes["E:A"].state, "OPEN");
  c.emit("experiments", {
    sourceEpisodeId: "A",
    controlTradeId: "T",
    policy: "ATR1M_1P5_REPLACEMENT",
    status: "CLOSED",
    complete: true,
  });
  assert.equal(c.state.episodes["E:A"].state, "COMPLETE");
  assert.equal(c.status().uniqueDecisionEpisodes, 1);
});
test("bounded index journal survives restart and replays native identity without duplicate decisions", (t) => {
  const c = store(t);
  c.emit("decisions", { sourceEpisodeId: "A" });
  for (let i = 0; i < 100; i++)
    c.nativeState("native", { episodeId: "A", at: i });
  assert.ok(fs.statSync(c.journal).size < 8 * 1024 * 1024);
  const d = new ResearchStore(c.dir, { reserveBytes: 0 });
  assert.equal(d.state.nativeEpisodeIndex.native.at, 99);
  assert.equal(d.state.persistedRows, 1);
  assert.equal(d.status().uniqueDecisionEpisodes, 1);
});
