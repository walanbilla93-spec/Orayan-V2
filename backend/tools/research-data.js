#!/usr/bin/env node
"use strict";
// Offline tools only. No remote requests, engine imports, migration at startup or deletion.
const fs = require("fs"),
  path = require("path"),
  crypto = require("crypto"),
  readline = require("readline"),
  zlib = require("zlib");
const { pipeline } = require("stream/promises");
const { ResearchStore, atomic, sha } = require("../lib/researchStore");
async function digest(file) {
  const h = crypto.createHash("sha256");
  for await (const b of fs.createReadStream(file)) h.update(b);
  return h.digest("hex");
}
async function inventory(root) {
  root = path.resolve(root);
  const entries = [];
  async function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name),
        stat = fs.lstatSync(file);
      if (stat.isSymbolicLink())
        throw Error("SYMLINK_NOT_ALLOWED:" + path.relative(root, file));
      if (stat.isDirectory()) await walk(file);
      else if (stat.isFile()) {
        const checksum = await digest(file),
          after = fs.statSync(file);
        entries.push({
          path: path.relative(root, file).split(path.sep).join("/"),
          bytes: stat.size,
          sha256: checksum,
          mtime: stat.mtime.toISOString(),
          stable: stat.size === after.size && stat.mtimeMs === after.mtimeMs,
        });
      }
    }
  }
  await walk(root);
  return {
    schemaVersion: "ORAYAN_READ_ONLY_INVENTORY_V1",
    createdAt: new Date().toISOString(),
    sourceRoot: root,
    complete: entries.every((e) => e.stable),
    files: entries,
    bytes: entries.reduce((a, e) => a + e.bytes, 0),
    fileCount: entries.length,
  };
}
async function backup(root, target) {
  root = path.resolve(root);
  target = path.resolve(target);
  const rel = path.relative(root, target);
  if (!rel || (!rel.startsWith("..") && !path.isAbsolute(rel)))
    throw Error("BACKUP_TARGET_MUST_BE_OUTSIDE_SOURCE");
  if (fs.existsSync(target)) throw Error("BACKUP_TARGET_ALREADY_EXISTS");
  fs.mkdirSync(target, { recursive: true });
  const before = await inventory(root);
  for (const e of before.files) {
    const output = path.join(target, e.path);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    await pipeline(
      fs.createReadStream(path.join(root, e.path)),
      fs.createWriteStream(output, { flags: "wx", mode: 0o600 }),
    );
    if ((await digest(output)) !== e.sha256) e.stable = false;
  }
  before.complete = before.files.every((e) => e.stable);
  atomic(path.join(target, "backup-inventory.json"), before);
  return before;
}
function eligible(name) {
  return /^(capture-minimal-v1\/segment[^/]*\.jsonl|(?:groq-shadow|alibaba-shadow)\/(?:candidate-snapshots|decisions)\.jsonl|(?:research-v2|research-events-v1|research-supplement-v1|v3-shadow|v3-shadow-compact-v1)\/.+\.jsonl(?:\.gz)?)$/.test(
    name,
  );
}
async function plan(root) {
  const inv = await inventory(root);
  return {
    ...inv,
    mode: "DRY_RUN",
    classification: "LEGACY/INCOMPLETE/CENSORED",
    eligibleFiles: inv.files.filter((f) => eligible(f.path)),
    deletedHistory: "UNRECOVERABLE; NOT INFERRED",
    automaticImport: false,
  };
}
async function importLegacy(root, target) {
  root = path.resolve(root);
  target = path.resolve(target);
  if (target === root || target.startsWith(root + path.sep))
    throw Error("IMPORT_TARGET_MUST_BE_SEPARATE");
  const report = await plan(root);
  if (!report.complete) throw Error("SOURCE_CHANGED_DURING_INVENTORY");
  const store = new ResearchStore(target),
    counts = { imported: 0, duplicates: 0, malformed: 0 };
  for (const file of report.eligibleFiles) {
    if ((await digest(path.join(root, file.path))) !== file.sha256)
      throw Error("SOURCE_CHECKSUM_CHANGED");
    let input = fs.createReadStream(path.join(root, file.path));
    if (file.path.endsWith(".gz")) input = input.pipe(zlib.createGunzip());
    let lineNumber = 0;
    for await (const line of readline.createInterface({
      input,
      crlfDelay: Infinity,
    })) {
      lineNumber++;
      if (!line.trim()) continue;
      let legacy;
      try {
        legacy = JSON.parse(line);
      } catch {
        legacy = { unparsedLegacyLine: line };
        counts.malformed++;
      }
      const key = sha(JSON.stringify([file.sha256, lineNumber]));
      if (store.state.dedupe["legacy:" + key]) {
        counts.duplicates++;
        continue;
      }
      const oldId =
        legacy.sourceEpisodeId ||
        legacy.episodeId ||
        legacy.candidate_episode_id ||
        legacy.candidate_id;
      const classification = /shadow\/(candidate-snapshots|decisions)/.test(
        file.path,
      )
        ? "INCOMPLETE"
        : "CENSORED";
      if (
        !store.emit(
          "integrity",
          {
            event: "LEGACY_EVIDENCE",
            sourceEpisodeId: oldId
              ? "LEGACY:" +
                String(legacy.epochId || "UNKNOWN_EPOCH") +
                ":" +
                oldId
              : null,
            completeness: classification,
            censorReason: "LEGACY_CHAIN_NOT_RECONSTRUCTABLE",
            legacyOrigin: {
              file: file.path,
              sha256: file.sha256,
              line: lineNumber,
              classification: "LEGACY",
            },
            missingEvidence: [
              "EXACT_PROVIDER_REQUEST_NOT_INFERRED",
              "RAW_RESPONSE_NOT_INFERRED",
              "DELETED_OUTCOME_NOT_INFERRED",
            ],
            legacyRecord: legacy,
          },
          { key: "legacy:" + key, signature: key },
        )
      )
        throw Error("LEGACY_IMPORT_PERSISTENCE_FAILED");
      counts.imported++;
    }
    if ((await digest(path.join(root, file.path))) !== file.sha256)
      throw Error("SOURCE_CHANGED_DURING_IMPORT");
  }
  store.flush();
  return {
    mode: "OFFLINE_IMPORT",
    ...counts,
    sourceInventory: report,
    outputSchema: store.state.schemaVersion,
  };
}
async function main() {
  const [mode, root, target] = process.argv.slice(2);
  if (!root || !["inventory", "backup", "plan", "import"].includes(mode))
    throw Error(
      "Usage: research-data.js inventory|backup|plan|import SOURCE [NEW_TARGET]",
    );
  if (["backup", "import"].includes(mode) && !target)
    throw Error("NEW_TARGET_REQUIRED");
  const result =
    mode === "inventory"
      ? await inventory(root)
      : mode === "backup"
        ? await backup(root, target)
        : mode === "plan"
          ? await plan(root)
          : await importLegacy(root, target);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
if (require.main === module)
  main().catch((e) => {
    process.stderr.write((e.code || e.message) + "\n");
    process.exitCode = 1;
  });
module.exports = { inventory, backup, plan, importLegacy, eligible };
