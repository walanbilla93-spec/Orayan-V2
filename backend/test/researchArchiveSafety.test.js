"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs"),
  path = require("path"),
  os = require("os");
const { ResearchStore, dayAt } = require("../lib/researchStore"),
  archive = require("../lib/researchArchive");
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-safety-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}
test("quiet days still close one ZIP per date and compact the index while retaining seven verified archives", async (t) => {
  let at = Date.parse("2026-09-01T01:00:00Z");
  const c = new ResearchStore(temporary(t), { reserveBytes: 0, now: () => at });
  c.emit("decisions", { sourceEpisodeId: "A", admission: "REJECT" });
  at = Date.parse("2026-09-09T01:00:00Z");
  await archive.tick(c, at);
  const active = c.state.archives.filter((a) => !a.expired);
  assert.equal(active.length, 7);
  assert.deepEqual(
    active.map((a) => a.day),
    [
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
      "2026-09-05",
      "2026-09-06",
      "2026-09-07",
      "2026-09-08",
    ],
  );
  for (const a of active)
    await archive.verify(path.join(c.dir, "archives", a.filename));
  assert.equal(c.state.archivedRows, 1);
  assert.ok(Object.keys(c.state.events).length < 2);
  assert.equal(c.state.uniqueDecisionEpisodes, 1);
});
test("provider-filtered archive preserves shared causal endpoints without exporting another provider response", async (t) => {
  const c = new ResearchStore(temporary(t), { reserveBytes: 0 });
  c.emit("decisions", { sourceEpisodeId: "A" });
  c.emit("ai_calls", {
    sourceEpisodeId: "A",
    provider: "Groq",
    rawResponse: "G",
  });
  c.emit("ai_calls", {
    sourceEpisodeId: "A",
    provider: "Alibaba",
    rawResponse: "Q",
  });
  c.emit("outcomes", {
    sourceEpisodeId: "A",
    status: "CLOSED",
    outcomeComplete: true,
  });
  const target = path.join(temporary(t), "groq.zip");
  await archive.build(c, { sinceAt: 0, provider: "Groq", target });
  const m = await archive.verify(target);
  assert.equal(m.events.filter((e) => e.stream === "ai_calls").length, 1);
  assert.equal(m.events.find((e) => e.stream === "ai_calls").provider, "Groq");
  assert.ok(m.events.some((e) => e.stream === "outcomes"));
  assert.ok(m.events.some((e) => e.stream === "decisions"));
});
test("missing funding endpoint is OPEN; explicit path gap is CENSORED", (t) => {
  const c = new ResearchStore(temporary(t), { reserveBytes: 0 });
  c.emit("decisions", { sourceEpisodeId: "A" });
  c.emit("lifecycle", {
    sourceEpisodeId: "A",
    tradeId: "T",
    status: "CLOSED",
    outcomeComplete: false,
    fundingStatus: "AWAITING_FUNDING",
  });
  assert.equal(c.state.episodes[c.state.sourceEpisodes.A].state, "OPEN");
  c.emit("lifecycle", {
    sourceEpisodeId: "A",
    tradeId: "T",
    status: "DATA_GAP",
    outcome: "EMPTY_PATH",
    outcomeComplete: false,
  });
  assert.equal(c.state.episodes[c.state.sourceEpisodes.A].state, "CENSORED");
  assert.equal(c.state.episodes[c.state.sourceEpisodes.A].reason, "EMPTY_PATH");
});
