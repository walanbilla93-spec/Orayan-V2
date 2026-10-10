"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs"),
  os = require("os"),
  path = require("path");
const { ResearchStore, sha } = require("../lib/researchStore"),
  archive = require("../lib/researchArchive"),
  ai = require("../lib/researchAI"),
  minimal = require("../lib/minimalCapture");
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "research-ai-chain-")),
    c = new ResearchStore(dir, { epochId: "E", reserveBytes: 0 });
  const old = {
    researchEnabled: minimal.researchEnabled,
    current: minimal.current,
  };
  minimal.researchEnabled = () => true;
  minimal.current = () => c;
  t.after(() => {
    Object.assign(minimal, old);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return c;
}
for (const provider of ["Groq", "Alibaba"])
  test(
    provider +
      " preserves durable request, raw, normalization, retries and terminal causal linkage",
    async (t) => {
      const c = setup(t),
        snapshot = { candidate_episode_id: "EP", candidate_id: "C" },
        request = {
          model: "test-model",
          messages: [
            { role: "system", content: "immutable prompt" },
            { role: "user", content: "exact decision context" },
          ],
          response_format: { type: "json_object" },
        };
      c.emit("decisions", { sourceEpisodeId: "EP", boundary: "BIRTH" });
      const first = ai.begin(provider, snapshot, request, "LOGICAL", [
        "fake-key",
      ]);
      let records = [];
      await archive.rows(c, (r) => records.push(r));
      assert.equal(records.at(-1).event, "REQUEST_PREPARED");
      assert.equal(
        records.at(-1).exactRequestSha256,
        sha(JSON.stringify(request)),
      );
      ai.raw(first, '{"raw":"response"}', {
        providerCallId: "CALL1",
        httpStatus: 200,
      });
      ai.finish(first, {
        status: "OK",
        decision: { decision: "RETAIN" },
        tokens: { total: 12 },
        latency_ms: 3,
      });
      const retry = ai.begin(provider, snapshot, request, "LOGICAL");
      assert.equal(retry.evaluationId, first.evaluationId);
      assert.notEqual(retry.attemptId, first.attemptId);
      ai.transportError(
        retry,
        Object.assign(Error("timeout"), { code: "ETIMEDOUT" }),
      );
      c.emit("outcomes", {
        sourceEpisodeId: "EP",
        status: "CLOSED",
        outcomeComplete: true,
        realizedR: 1.2,
      });
      records = [];
      await archive.rows(c, (r) => records.push(r));
      assert.equal(
        records.filter((r) => r.kind === "AI_SHARED_REQUEST").length,
        1,
      );
      assert.equal(
        records.find((r) => r.event === "RAW_RESPONSE").rawResponse,
        '{"raw":"response"}',
      );
      assert.equal(
        records.find((r) => r.event === "PARSED_RESPONSE").disposition,
        "SHADOW_ONLY",
      );
      assert.equal(c.state.episodes["E:EP"].state, "COMPLETE");
      const chosen = archive.closure(c, [
        records.find((r) => r.event === "RAW_RESPONSE").eventId,
      ]);
      assert.ok(chosen.has(records.at(-1).eventId));
      assert.ok(
        chosen.has(records.find((r) => r.kind === "AI_SHARED_REQUEST").eventId),
      );
    },
  );
test("AI persistence failure blocks dispatch and never exposes credential material", async (t) => {
  const c = setup(t);
  const ctx = ai.begin(
    "Groq",
    { candidate_episode_id: "EP" },
    { model: "m", messages: [{ role: "user", content: "x" }] },
    "R",
    ["fake-key"],
  );
  ai.raw(ctx, "model echoed fake-key");
  let records = [];
  await archive.rows(c, (r) => records.push(r));
  assert.ok(!JSON.stringify(records).includes("fake-key"));
  c.state.captureHalted = true;
  assert.throws(() => ai.begin("Groq", {}, {}, "NEW"), /HALTED/);
});
test("restart records interrupted AI uncertainty once without inventing a response", async (t) => {
  const c = setup(t);
  ai.begin(
    "Alibaba",
    { candidate_episode_id: "EP" },
    { model: "m", messages: [] },
    "R",
  );
  new ResearchStore(c.dir, { reserveBytes: 0 });
  const again = new ResearchStore(c.dir, { reserveBytes: 0 });
  const records = [];
  await archive.rows(again, (r) => records.push(r));
  assert.equal(
    records.filter((r) => r.event === "INTERRUPTED_UNCERTAIN").length,
    1,
  );
  assert.equal(records.filter((r) => r.event === "RAW_RESPONSE").length, 0);
  assert.equal(
    records.find((r) => r.event === "INTERRUPTED_UNCERTAIN")
      .completionUncertain,
    true,
  );
});
for (const [provider, client, call] of [
  ["Groq", "../../../research/groq-shadow/src/client", "postGroq"],
  ["Alibaba", "../../../research/alibaba-shadow/src/client", "postAlibaba"],
])
  test(
    provider +
      " captures response before parsing and propagates persistence halt",
    async () => {
      const module = require(client.replace("../../../", "../../")),
        raw = "{invalid json",
        events = [];
      const opts = {
        apiKey: "test",
        baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        timeoutMs: 1000,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => raw,
        }),
        onRaw: async (text) => {
          events.push(text);
        },
      };
      await module[call]({}, opts);
      assert.deepEqual(events, [raw]);
      opts.onRaw = async () => {
        throw Object.assign(Error("halt"), { code: "RESEARCH_CAPTURE_HALTED" });
      };
      await assert.rejects(module[call]({}, opts), {
        code: "RESEARCH_CAPTURE_HALTED",
      });
    },
  );
