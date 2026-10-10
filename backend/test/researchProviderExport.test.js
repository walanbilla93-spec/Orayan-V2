"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), os = require("os");
const yauzl = require("yauzl");
const data = require("../lib/store"), runtime = require("../lib/researchRuntime");
const archive = require("../lib/researchArchive");
const { dayAt, sha } = require("../lib/researchStore");

// Inspect actual ZIP payloads, including definitions, rather than trusting the manifest filter.
async function readRows(file) {
  const zip = await new Promise((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (error, z) => error ? reject(error) : resolve(z)));
  const pieces = new Map();
  try { await new Promise((resolve, reject) => {
    zip.on("error", reject); zip.on("end", resolve);
    zip.on("entry", entry => {
      if (!entry.fileName.startsWith("records/")) { zip.readEntry(); return; }
      zip.openReadStream(entry, (error, stream) => {
        if (error) { reject(error); return; }
        (async () => {
          let text = "";
          for await (const chunk of stream) text += chunk;
          for (const line of text.trim().split("\n").filter(Boolean)) {
            const piece = JSON.parse(line);
            const parts = pieces.get(piece.meta.eventId) || [];
            parts[piece.index] = Buffer.from(piece.data, "base64");
            pieces.set(piece.meta.eventId, parts);
          }
          zip.readEntry();
        })().catch(reject);
      });
    });
    zip.readEntry();
  }); } finally {
    await new Promise(resolve => { zip.once("close", resolve); zip.close(); });
  }
  return [...pieces.values()].map(parts => JSON.parse(Buffer.concat(parts).toString()));
}

test("provider download routes export canonical chains without legacy ledgers", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-download-"));
  const oldRoot = data.DATA_DIR;
  const names = ["GROQ_SHADOW_EXPORT_TOKEN", "ALIBABA_SHADOW_EXPORT_TOKEN",
    "GROQ_SHADOW_LEDGER", "ALIBABA_SHADOW_LEDGER", "GROQ_SHADOW_SNAPSHOT_LOG", "ALIBABA_SHADOW_SNAPSHOTS"];
  const oldEnv = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(async () => {
    await runtime.close(); data.DATA_DIR = oldRoot;
    for (const name of names) {
      if (oldEnv[name] === undefined) delete process.env[name]; else process.env[name] = oldEnv[name];
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  for (const name of names) delete process.env[name];
  process.env.GROQ_SHADOW_EXPORT_TOKEN = "test-groq-export";
  process.env.ALIBABA_SHADOW_EXPORT_TOKEN = "test-alibaba-export";
  data.DATA_DIR = root; runtime.prepare();
  const c = runtime.current(), oldAt = Date.now() - 48 * 3600000;
  c.now = () => oldAt;
  c.emit("definitions", { definitionId: "SHARED_CONFIG", definition: { kind: "shared-causal-policy" }, at: oldAt });
  c.emit("decisions", { sourceEpisodeId: "SHARED_EPISODE", boundary: "BIRTH", at: oldAt,
    dependencyIds: ["SHARED_CONFIG"] });
  c.now = Date.now;
  let calls = 0;
  const markers = { Groq: "GROQ_RESPONSE_ONLY", Alibaba: "QWEN_RESPONSE_ONLY" };
  for (const [name, provider] of [["groq", "Groq"], ["alibaba", "Alibaba"]]) {
    const advisor = require("../../research/" + name + "-shadow/src/advisor");
    const ledger = require("../../research/" + name + "-shadow/src/ledger");
    ledger._test.resetCaches();
    const candidate = require("./fixtures/" + name + "Candidate")();
    candidate.candidate_episode_id = "SHARED_EPISODE";
    const result = await advisor.advise(candidate, {
      config: { ...advisor.configFromEnv({}), ledger: path.join(root, name + "-shadow", "decisions.jsonl"),
        allowedRoot: root, apiKey: "mock-provider-key", allowLive: true },
      mode: "mock", nowMs: Date.parse("2026-09-28T10:00:05Z"),
      completedMs: Date.parse("2026-09-28T10:00:06Z"),
      mockTransport: async () => {
        calls++;
        return { ok: true, status: "OK", httpStatus: 200, headers: { request_id: provider + "-CALL" },
          body: { usage: { prompt_tokens: 300, completion_tokens: 40, total_tokens: 340 },
            choices: [{ message: { content: JSON.stringify({ decision: "RETAIN", risk_level: "LOW", confidence: 0.7,
              reason_codes: ["EVIDENCE_COMPLETE"], reason_notes: [], evidence_keys: ["h1.state"], missing_or_stale: [],
              rationale_short: markers[provider] }) } }] } };
      },
    });
    assert.equal(result.status, "OK");
  }
  c.emit("outcomes", { sourceEpisodeId: "SHARED_EPISODE", status: "CLOSED", outcomeComplete: true });
  // The origin/configuration now live in a completed archive, outside the current 30h window.
  await archive.closeDay(c, dayAt(oldAt, c.timezone));
  const { routes } = require("../routes/api");
  const both = { "x-groq-shadow-export-token": "test-groq-export", "x-alibaba-shadow-export-token": "test-alibaba-export" };
  const noLegacy = () => {
    for (const provider of ["groq", "alibaba"])
      for (const file of ["decisions.jsonl", "candidate-snapshots.jsonl"])
        assert.equal(fs.existsSync(path.join(root, provider + "-shadow", file)), false);
  };
  noLegacy();

  async function inspect(result) {
    assert.equal(result.__files, true); assert.equal(result.contentType, "application/zip");
    try {
      const manifest = await archive.verify(result.files[0].path);
      const rows = await readRows(result.files[0].path);
      return { manifest, rows };
    } finally { result.cleanup(); }
  }
  async function selected(result, provider) {
    assert.equal(result.filename, "orayan-" + provider.toLowerCase() + "-30h.zip");
    const { manifest, rows } = await inspect(result);
    assert.equal(manifest.window.provider, provider);
    const ai = rows.filter(row => row.stream === "ai_calls");
    assert.ok(ai.length > 0); assert.ok(ai.every(row => row.provider === provider));
    for (const event of ["REQUEST_PREPARED", "RAW_RESPONSE", "PARSED_RESPONSE", "PROVIDER_LEDGER"])
      assert.ok(ai.some(row => row.event === event), event);
    const serialized = JSON.stringify(rows);
    assert.ok(serialized.includes(markers[provider]));
    assert.ok(!serialized.includes(markers[provider === "Groq" ? "Alibaba" : "Groq"]));
    assert.ok(rows.some(row => row.stream === "decisions"));
    assert.ok(rows.some(row => row.stream === "outcomes"));
    assert.ok(rows.some(row => row.definitionId === "SHARED_CONFIG"));
    const request = ai.find(row => row.event === "REQUEST_PREPARED");
    const definitions = new Map(rows.filter(row => row.definitionId).map(row => [row.definitionId, row]));
    const rebuilt = require("../lib/researchRequest").reconstruct(request, definitions);
    assert.equal(sha(JSON.stringify(rebuilt)), request.exactRequestSha256);
    assert.ok(manifest.dependencyEventIds.length > 0);
    noLegacy();
  }

  for (const [route, provider, header, token] of [
    ["GET /api/journal/research/groq-shadow/export", "Groq", "x-groq-shadow-export-token", "GROQ_SHADOW_EXPORT_TOKEN"],
    ["GET /api/journal/research/alibaba-shadow/export", "Alibaba", "x-alibaba-shadow-export-token", "ALIBABA_SHADOW_EXPORT_TOKEN"],
    ["GET /api/journal/research/alibaba-shadow/snapshots/export", "Alibaba", "x-alibaba-shadow-export-token", "ALIBABA_SHADOW_EXPORT_TOKEN"],
  ]) await t.test(route + " preserves provider authorization and ZIP isolation", async () => {
    const handler = routes[route], own = both[header];
    await assert.rejects(handler({ req: { headers: {} } }), { statusCode: 401 });
    await assert.rejects(handler({ req: { headers: { [header]: "wrong" } } }), { statusCode: 401 });
    // Both tokens are configured, but each provider endpoint requires only its own token.
    await selected(await handler({ req: { headers: { [header]: own } } }), provider);
    await selected(await handler({ req: { headers: { authorization: "Bearer " + own } } }), provider);
    delete process.env[token];
    try { await selected(await handler({ req: { headers: {} } }), provider); }
    finally { process.env[token] = own; }
  });

  await t.test("provider status enables canonical downloads without legacy files", async () => {
    for (const name of ["groq", "alibaba"]) {
      const status = await routes["GET /api/journal/research/" + name + "-shadow"]();
      assert.equal(status.available, true); assert.equal(status.snapshotAuditAvailable, true);
      assert.equal(status.canonical, true); assert.equal(status.exportFormat, "zip");
      assert.equal(status.exportProtected, true); assert.ok(status.sizeBytes > 0);
    }
    noLegacy();
  });
  await t.test("metadata availability uses the same current window as provider downloads", () => {
    const empty = runtime.providerExportMetadata("UnusedProvider");
    assert.equal(empty.available, false); assert.equal(empty.snapshotAuditAvailable, false);
    c.emit("ai_calls", { provider: "OldOnly", event: "REQUEST_PREPARED", at: oldAt });
    assert.equal(runtime.providerExportMetadata("OldOnly").available, false);
  });
  await t.test("combined current and alias downloads retain both providers and both token checks", async () => {
    for (const route of ["GET /api/capture/current.zip", "GET /api/capture/export"]) {
      const handler = routes[route];
      await assert.rejects(handler({ req: { headers: { "x-groq-shadow-export-token": both["x-groq-shadow-export-token"] } } }), { code: "ALIBABA_SHADOW_EXPORT_UNAUTHORIZED" });
      await assert.rejects(handler({ req: { headers: { "x-alibaba-shadow-export-token": both["x-alibaba-shadow-export-token"] } } }), { code: "GROQ_SHADOW_EXPORT_UNAUTHORIZED" });
      const { manifest, rows } = await inspect(await handler({ req: { headers: both } }));
      assert.equal(manifest.window.provider, null);
      for (const marker of Object.values(markers)) assert.ok(JSON.stringify(rows).includes(marker));
    }
  });
  await t.test("completed daily download retains its existing authorization and checksum", async () => {
    const handler = routes["GET /api/capture/daily.zip"], day = dayAt(oldAt, c.timezone);
    await assert.rejects(handler({ query: { day }, req: { headers: {} } }), { statusCode: 401 });
    const result = await handler({ query: { day }, req: { headers: both } });
    const record = c.state.archives.find(a => a.day === day);
    try {
      assert.equal(await archive.fileHash(result.files[0].path), record.sha256);
      assert.equal((await archive.verify(result.files[0].path)).window.provider, null);
    } finally { result.cleanup(); }
    assert.equal(c.exportReaders, 0); noLegacy();
  });
  assert.equal(calls, 2);
});
