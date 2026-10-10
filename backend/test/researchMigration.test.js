"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs"),
  path = require("path"),
  os = require("os");
const tooling = require("../tools/research-data"),
  { ResearchStore } = require("../lib/researchStore"),
  archive = require("../lib/researchArchive");
function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "research-migration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test("read-only backup hashes all source files and migration is separate, honest and idempotent", async (t) => {
  const root = temp(t),
    source = path.join(root, "source");
  fs.mkdirSync(path.join(source, "groq-shadow"), { recursive: true });
  const file = path.join(source, "groq-shadow", "decisions.jsonl");
  fs.writeFileSync(
    file,
    JSON.stringify({ candidate_id: "C", decision: "RETAIN", status: "OK" }) +
      "\n",
  );
  const original = fs.readFileSync(file);
  const backup = await tooling.backup(source, path.join(root, "backup"));
  assert.equal(backup.complete, true);
  assert.equal(backup.fileCount, 1);
  const plan = await tooling.plan(source);
  assert.equal(plan.mode, "DRY_RUN");
  assert.equal(plan.eligibleFiles.length, 1);
  const target = path.join(root, "canonical");
  assert.equal((await tooling.importLegacy(source, target)).imported, 1);
  assert.equal((await tooling.importLegacy(source, target)).duplicates, 1);
  assert.deepEqual(fs.readFileSync(file), original);
  const c = new ResearchStore(target),
    rows = [];
  await archive.rows(c, (r) => rows.push(r));
  assert.equal(rows[0].completeness, "INCOMPLETE");
  assert.equal(rows[0].legacyRecord.rawResponse, undefined);
  assert.equal(rows[0].rawResponse, undefined);
});
