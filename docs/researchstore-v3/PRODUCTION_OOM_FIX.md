CURRENT PRODUCTION PROCEDURE: See CLEAN_EPOCH_RUNBOOK.md. Historical bulk migration below is superseded and permanently abandoned.

# Production V3 OOM fix

This candidate starts from `db2b71f8c52a5840ed9a0fe1dd198cca499a456b` on branch `fix/orayan-oom-v3-production`. It implements the service backend, additive migration, archive traversal and activation. Production deployment has not been performed.

## Architecture and invariants

`ResearchStoreV3` shares the real `ResearchStore.apply()` reducer through exact disk reads and writes. It does not instantiate the V2 store or import a test publisher. Events, exact dedupe, episodes, source/native mappings, provider attempts/evaluations, provider budget/request projections, extrema, epoch records and archive descriptors live in authenticated V3 shards. The existing V2 row/export schema remains compatible.

CURRENT holds ten families of 256 descriptors plus compact counters. A shared byte-capped overlay covers the uncheckpointed WAL. Transactions fsync before acknowledgement; CURRENT publishes before WAL truncation or shard garbage collection. A torn WAL tail is discarded only after every complete transaction is published. Ambiguous write failures fence the authority until reopen. Open obligations and provider recovery have separate disk indexes; completed provider request IDs are exact disk lookups.

Historical state access supports individual keys. Enumeration throws `V3_HISTORY_ENUMERATION_FORBIDDEN`; there is no whole-history compatibility API. Archive closure uses an external exact set and disk FIFO. Manifests stream their arrays. Verification, retention, reachability and chronological explicit exports use disk traversal or bounded external sorting. Seven verified daily ZIPs remain available under the existing retention policy. Explicit evidence preservation continues to override deletion.

Store bounds: 2,560 descriptors; 4 MiB page cache; 16 read handles; 2 MiB admitted overlay accounting plus at most one 2 MiB transaction; eight cursors with at most 32 MiB of overlay snapshots in aggregate; 128 reducer operations and 2 MiB encoded transaction cap; 128 KiB scalar descriptor; 1,024 recent provider reservations per provider. Provider overflow conservatively fences dispatch for that minute while preserving open requests and endpoints on disk. Exact request/candidate/dedupe keys are never evicted from RAM caches because they reside on disk. A single event is processed independently; its payload size does not multiply by retained event count.

The existing resource-reset behavior is inherited unchanged. Marci acquisition, simulation and background discovery remain off. Historical evidence stays read-only. Maintenance Marci accounting streams the historical ledger. This task creates no Marci retirement receipt and changes no PAPER/native execution logic.

## Paths

`DATA_DIR` below means the service's actual persistent backend data directory. The current service resolves it as `backend/data`; use the volume's corresponding absolute directory when running tools. Setting a shell variable named DATA_DIR does not relocate the service's `store.js` directory.

- V2 source: `<DATA_DIR>/research-canonical-v2` (strictly read-only).
- V3 destination: `<DATA_DIR>/research-canonical-v3`.
- V3 root: `research-canonical-v3/index/CURRENT`.
- WAL: `research-canonical-v3/index/transactions.jsonl`.
- Physical rows: `research-canonical-v3/records/<prefix>/<sha256>.json`.
- Daily evidence: `research-canonical-v3/archives/`.
- Migration stages, source hash inventory and receipt: `migration-stage.json`, `source-hashes.jsonl`, `migration-receipt.json` inside V3.
- Backend activation: `<DATA_DIR>/research-backend-activation.json`.
- Exclusive writer lease: `research-canonical-v3/WRITER.lock/owner.json`.

## Offline migration and activation

Stop every service replica and all independent writers first. Use one migration process. Preserve the current volume and V2 namespace. The operation needs space for the additive destination, temporary traversal/sort files and the normal 128 MiB outcome reserve. No synthetic capacity campaign is required. An interrupted or out-of-space migration leaves V2 unchanged and resumes in the same destination.

From the repository root, on the service host:

```sh
export DATA_DIR=/absolute/path/to/backend/data
export ORAYAN_V3_OFFLINE=true
node backend/tools/research-v3-migrate.js migrate "$DATA_DIR"
node backend/tools/research-v3-migrate.js verify "$DATA_DIR"
node backend/tools/research-v3-migrate.js activate "$DATA_DIR"
```

The migration command streams checkpoint entries, journal receipts, committed WAL pieces, archives and segment rows. It never calls the V2 constructor or repairs V2 in place. It migrates only exact keys present in source state or committed transactions. Stages and transaction cursors resume after interruption. Physical row import is idempotent and restarts its streaming pass. Projection rebuild is idempotent. Reconciliation checks exact keys, counters, event sequence, native/scalar state, extrema, episode obligations and provider projections. Source hashes are checked before and after. Only full success produces `VERIFIED_NOT_ACTIVE`.

The receipt explicitly preserves prior compaction/dedupe coverage gaps. It does not claim to reconstruct keys or history absent from the source index. Retained bytes in V3 count logical row bytes; V2's physical JSONL size differs. V2 has no global storage LSN; its event sequence and native journal are reconciled separately. V3 accepted/acknowledged storage LSNs identify its durable transaction boundary.

Checkpoint import groups at most 64 entries and 128 KiB of serialized input, except that an individual entry retains the existing transaction cap. Each group and its resume cursor commit together. This avoids a filesystem flush for every key or ignored archive member while preserving restartability. Existing per-entry migration cursors remain compatible.

Only the stopped migration uses a fixed 32 MiB accounted index overlay and 64 MiB maximum recovery journal (32 MiB journal fold threshold). This amortizes immutable shard rewrites on the small service plan. Migration resumes with those same explicit limits, flushes every completed stage and flushes before publishing its receipt. Normal runtime and offline health retain the 2 MiB overlay admission limit and 8 MiB recovery journal limit; no environment flag expands runtime limits.

Activation rechecks every V2 source file against the migration inventory before publishing `V3_SELECTED`. If V2 changed after migration, activation fails; V2 remains selectable. Keep the service stopped between migration and activation. A pre-write selected namespace requires explicit rollback before V2 may resume.

For the service restart, set:

```sh
RESEARCH_STORE_BACKEND=v3
META_BRAIN_V1_SHADOW=false
QWEN_FEEDBACK_ENABLED=false
GROQ_FEEDBACK_ENABLED=false
```

`RESEARCH_STORE_BACKEND` accepts exactly `v2` or `v3` and defaults to `v2` before activation. `ORAYAN_V3_OFFLINE=true` is an assertion for operator tools, not a runtime backend selector. Leave other reviewed resource-reset flags as configured. `RESEARCH_PRESERVE_EVIDENCE=true` still preserves evidence if explicitly required; archival is never disabled by V3.

Boot opens CURRENT, fixed descriptors, bounded WAL/cache state, recent native mappings and open provider obligations. It does not run archive closure synchronously. The normal 15-second archive worker continues with bounded traversal. The first production provenance/recovery/event write durably publishes `V3_WRITE_INTENT` before accepting the transaction and records `activationWriteStarted` in V3 state. This conservative marker also covers a crash during the first write attempt.

## Rollback and fix forward

Before write intent, with all writers stopped:

```sh
ORAYAN_V3_OFFLINE=true node backend/tools/research-v3-migrate.js rollback-before-write "$DATA_DIR"
# Then restart with RESEARCH_STORE_BACKEND=v2.
```

After `V3_WRITE_INTENT` or V3's durable write flag, stale V2 fallback is prohibited. An explicit `v2` flag, missing/corrupt activation evidence or conflicting state fences admission. Preserve the entire V3 namespace and activation marker, repair the candidate and restart on V3. Do not delete CURRENT, marker or WAL, recopy V2 over V3, reset the epoch or fabricate a retention/retirement receipt.

The writer lease can automatically reclaim a demonstrably dead PID on the same host. A different container hostname, live PID or incomplete owner remains fenced. After stopping all replicas and confirming no writer remains, release only the stale lease:

```sh
ORAYAN_V3_OFFLINE=true node backend/tools/research-v3-migrate.js release-offline-lease "$DATA_DIR"
```

This command removes lock metadata only. It never removes research data. Do not run it against an active writer.

## Startup checks

Use the existing `GET /api/capture/status/details` after service start. Check `backend: v3`, `health: HEALTHY`, `captureHalted: false`, no pending failure, accepted = persisted, and attempted = accepted + lost. Confirm sequence advances on an admitted event and remains consistent across restart. Verify `liveStructures.historyDictionaries.count` is zero and every cache, overlay, handle and cursor count stays within its reported cap. Confirm existing PAPER positions continue management, provider queues recover without redispatching uncertain requests, and current/daily exports verify.

For an offline inspection only, with the service stopped:

```sh
ORAYAN_V3_OFFLINE=true node backend/tools/research-v3-migrate.js health "$DATA_DIR"
```

The offline health command acquires the exclusive lease. It must not run alongside the service. The migration `verify` command refers to the pre-activation root and intentionally ceases to match after V3 advances; use runtime health after activation.

`research-v3-startup-probe.js` is a local fixture tool that invokes the real server, forbids the legacy constructor and V2 file access, and asserts zero retained-event cursor reads at boot. It requires an explicit stopped fixture and does not deploy production.

## Validation and practical limits

Targeted tests cover realistic migration, checkpoint and physical-stage resume, native-only journal and unapplied WAL, exact dedupe, episodes/outcomes, provider budget/recovery, extrema/native/scalars, bounded archive closure/verification/compaction/retention, selector ambiguity and fix-forward, PAPER management and resource-reset behavior. The production authority also has a real process-exit/WAL-tail recovery test.

The actual server booted from a migrated 259-event fixture under `--max-old-space-size=192`: first startup RSS 62,758,912 bytes, heap used 14,340,792 bytes, external 2,654,370 bytes; restart RSS 62,259,200 bytes, heap used 14,233,048 bytes, external 2,654,242 bytes. Boot read no event-history cursor, constructed no V2 store and held zero historical dictionaries. Measurements were on Windows, Node 24.19.0; cgroup peak was unavailable. This is fixture evidence and architectural validation, not a claim of measurement on the production volume or Linux cgroup.

Foreground append/fold follows the existing synchronous caller contract, with bounded shard merge memory. Large shards can still cause I/O latency during folding. This candidate fixes retained-history RAM residency; production latency and volume headroom should be observed during the authorized rollout without changing the retention contract.

