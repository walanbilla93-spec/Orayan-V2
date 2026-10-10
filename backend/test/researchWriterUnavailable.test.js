"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs"),
  path = require("path"),
  os = require("os");
test("unavailable canonical writer shows HALTED and restores existing shadow working state", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "writer-unavailable-")),
    store = require("../lib/store"),
    old = store.DATA_DIR;
  store.DATA_DIR = root;
  t.after(() => {
    store.DATA_DIR = old;
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, "research-capture-policy.json"), "{}");
  fs.mkdirSync(path.join(root, "research-canonical-v2"));
  fs.writeFileSync(
    path.join(root, "research-canonical-v2", "status.json"),
    "broken",
  );
  const runtime = require("../lib/researchRuntime"),
    status = runtime.status();
  assert.equal(status.captureHalted, true);
  assert.equal(status.persistedRows, null);
  assert.equal(runtime.canAdmit("PAPER"), false);
  assert.equal(runtime.canAdmit("LIVE"), true);
  const dir = path.join(root, "working");
  fs.mkdirSync(dir);
  fs.writeFileSync(
    path.join(dir, "checkpoint.json"),
    JSON.stringify({
      activeTrades: [
        ["T", { tradeId: "T", status: "OPEN", symbol: "TESTUSDT" }],
      ],
      archive: { definitions: [], summaryHours: {} },
    }),
  );
  const journal = new (require("../lib/v3Shadow").ShadowJournal)(dir);
  assert.equal(journal.activeTrades.get("T").status, "OPEN");
  assert.ok(journal.captureInitializationError);
});
test("combined ZIP authorization preserves both existing provider token checks", () => {
  const auth = require("../routes/api")._test.requireResearchExportAuth,
    env = { GROQ_SHADOW_EXPORT_TOKEN: "G", ALIBABA_SHADOW_EXPORT_TOKEN: "Q" };
  assert.throws(
    () => auth({ headers: { "x-groq-shadow-export-token": "G" } }, env),
    { code: "ALIBABA_SHADOW_EXPORT_UNAUTHORIZED" },
  );
  assert.throws(
    () => auth({ headers: { "x-alibaba-shadow-export-token": "Q" } }, env),
    { code: "GROQ_SHADOW_EXPORT_UNAUTHORIZED" },
  );
  assert.doesNotThrow(() =>
    auth(
      {
        headers: {
          "x-groq-shadow-export-token": "G",
          "x-alibaba-shadow-export-token": "Q",
        },
      },
      env,
    ),
  );
});
