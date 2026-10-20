# Additive, restartable v2 → v3 migration

Design only. The source preservation and publication rules are mandatory. See [architecture](researchstore_hot_cold_architecture.md), [schema](researchstore_checkpoint_v3_schema.md) and [tests](researchstore_acceptance_tests.md).

## 1. Preconditions and source boundary

Use an offline consistent snapshot, or an existing fully fenced maintenance boundary with no active writers, exports or provider callbacks. Never run migration through the normal ResearchStore constructor: it performs replay, recoverAI and flush and would mutate the source. Do not change production flags/services to obtain this review's evidence. A later implementation task needs explicit operational rollout authorization.

Source inventory must cover `status.json`, index-journal, WAL commit and every referenced part, active/sealed segments, original archives, capture policy, reserve status, provider journals/snapshots, native unresolved state and any retirement/maintenance receipts affecting obligation accounting. Include metadata for other startup consumers (environment, holdout, native/Marci history); they are not silently imported into canonical research. Record exclusions and missing files. A ZIP export alone is not a consistent recovery-volume snapshot.

Pin source epoch, checkpoint byte hash/size, sequence, counters, capture completeness flags, timezone, ordered journal byte boundary/hash, WAL commit hash, file inventory root and tool/codec version. Inventory is itself paged and hash-rooted, not a giant JSON manifest. Use a streaming directory iterator and external sort, never readdir(...).sort() over unlimited files. Compute file hashes as streams. Capture source hashes before and after migration; a moving boundary invalidates the result.

Create `research-canonical-v3/migration/<source-root>.<tool-version>.building/`. The source is read-only. Source arrays/objects, event rows, ZIPs and WAL files remain byte-identical. Any required recovery of committed source WAL is simulated into the **destination/staging view**, not replayed against source files. If the source has orphan uncommitted parts, inventory and preserve them; do not count them as accepted.

## 2. Deterministic streaming extraction

1. Token-stream the legacy checkpoint. For each root dictionary entry, write tagged records to bounded spool files by family/bucket. For huge nested `archives[].eventIds`, episode arms/controls, dependencies or extension values, use nested visitors/blob spools. Preserve property/key types, undefined-versus-absent metadata where relevant, original insertion order and raw value digests. No whole-checkpoint object is built.
2. Retain legacy reader `582d905` as grammar/backward support; add visitor mode, rather than calling its existing object-returning function. Test escaped/split UTF-8, duplicate properties, numeric property ordering and prototype-named properties against native JSON semantics. Do not assume every legacy JSON root field was initialized in `initial()`.
3. Replay source journal records in original order into the staged view. Old event transactions use their recorded sequence guard; old `nativeOnly` records apply in file order despite no event sequence. Assign deterministic new LSNs for the import representation; record the mapping from checkpoint boundary/journal ordinal/WAL hash to LSN. Do not invent historical LSNs for already-folded old native-only operations; they are checkpoint state at the import base.
4. Reconcile a committed source WAL once in staging: validate each part hash, offsets and existing bytes. Missing final bytes can be supplied from the committed part into destination evidence files. A gap, conflicting committed bytes, missing part or contradictory journal/WAL blocks publication. Preserve both source and staged recovery receipt.
5. Import all available physical canonical chunk records, including ones referenced by preserved archives but absent from an already-compacted old event map. External sort by event/chunk identity; equal copies collapse only after comparing exact bytes/hashes; conflicting copies are an integrity failure. Historical event metadata outside the old resident map is added to E as **recovered available evidence**, with separate count/provenance. Preserve original accepted/persisted counters rather than incrementing them for import.
6. Derive lookup/obligation/provider projections by ordered replay of available canonical records, then reconcile against checkpoint state at the pinned boundary. Checkpoint current views take precedence where older raw history is incomplete or native-only/context state exists only in the checkpoint. Every discrepancy needs a classified receipt; never replace conflicting state just because a replay result seems plausible. Existing lostRows/populationComplete/censor flags cannot become healthier through migration.
7. Rebuild dedupe **only from exact legacy dedupe entries and journal/WAL keys/signatures**. Canonical rows do not generally contain caller options.key/signature, so old dedupe keys already removed by historical compaction cannot reliably be reconstructed from export metadata. Record that coverage honestly. There is no regression in the preserved current dedupe domain; v3 retains every known/new key thereafter. Do not claim exact dedupe for irretrievably absent historical keys. Do not infer synthetic keys from event hashes.

The bounded-memory contract applies to all available evidence. An incomplete source can be preserved and flagged; it cannot be certified as complete. If current safety relies on missing identities/obligations, migration is blocked rather than silently weakening the gate. The provided stress fixture's complete key domain is an acceptance fixture, not evidence that production's older keys still exist.

## 3. Sort, materialize and reconcile

Use bounded external runs (≤16 MiB sort working allocation, ≤16-way merge with 64 KiB buffers) and deterministic byte comparisons. Build one current version of every exact key in each shard. Normalize episode arms/controls and membership arrays; derive compact counts and disk O entries using unchanged predicates. Values whose logical JSON exceeds normal workspace are blob-spooled, never truncated. Build checksum trees with bounded buffers; stream-read every output file once to verify its whole-file digest and all record/order/offset invariants before accepting it.

Determinism means the same source boundary, tool/codec version and supplied audit clock produce the same logical keyed values, record ordering, counts, partition bytes, hashes and root. Do not include wall-clock timestamps, random UUIDs or temporary absolute paths in content-addressed partition/root bodies. Operational run timestamps can live in a separate non-content-addressed log. The comparison clock affects provider day/minute projections and must be pinned in the receipt. A fresh boot may derive a new bounded current-day view without rewriting history.

Receipt reconciliation includes:

- source byte hashes unchanged; exact epoch/sequence/counter/loss/health parity at boundary;
- legacy current event/key/episode/source/native/AI/extrema counts and logical digests;
- separate available physical event counts, recovered additional historical events, unknown/missing coverage;
- per-stream counts, event payload bytes/hashes, unique decisions, episode state and unresolved predicate counts;
- every known dedupe key and latest typed signature/event ID;
- original episode projection digests, including `arms`/`controls` order used by existing audits;
- attempt count/first-seen order, retryOf/attemptNumber parity, current first parsed-response reference;
- provider summaries, UTC-day reservations/actual-token adjustments, open requests, first candidate-input identity;
- segment/archive hashes, sizes, publication flags and exact membership counts/digests;
- each dependency resolved to an exact event/definition or an explicitly preserved pre-existing gap;
- source checkpoint/journal/WAL boundary → new root/LSN mapping.

Recovered additional events must not masquerade as increased runtime acceptedRows. Ordinary status retains legacy scalar meanings and exposes additional import coverage separately. If `retainedRows` changes because previously paged-out but available evidence is now addressable, record both values and the exact delta. No fake equality claim.

## 4. Resume and idempotence

An immutable stage receipt records input-root hash, tool version, stage, spool input/output offsets and stream hashes, completed shard hashes, counts and last fully committed replay ordinal. Publish it by fsync/rename/directory fsync. A resume validates the input root first, then validates each completed stage receipt/output before reuse. A torn/mismatched output is rebuilt only in the destination staging namespace; source remains untouched. Do not attempt to serialize an incremental crypto object as a resume token: rehash the bounded/resumable input prefix or use completed hashed chunks.

Sort input can be resumed at token-safe boundaries recorded with the parser state/entry start. If a safe byte boundary is unavailable, rescan that source file as a stream and skip already-committed tagged ordinals by comparison. Re-reading disk is allowed offline; rebuilding a whole JS map is not. Last complete records win according to original replay order, not filesystem modification time. Running migration twice produces one equivalent verified root and no duplicate logical events/counters.

## 5. Publish and read-only qualification

After full reconciliation, write a receipt with state `VERIFIED_NOT_ACTIVE`. It binds source epoch/checkpoint hash/inventory root, last committed source boundary, tool/format, output root/counts/digests, coverage limitations and interruption-recovery disposition plans. It does **not** emit new AI interruption evidence during offline import.

Boot v3 against the destination in an isolated scratch copy, with provider transports mocked and all feedback/model activation absent. Verify cold dedupe, late updates, obligation/AI/provider recovery, status and full exports. Boot recovery will append the existing interruption dispositions; distinguish these new runtime rows from the frozen import boundary. Run twice to prove they occur once.

Before activating a real destination, reconfirm that production source epoch/hash/journal/WAL boundary still matches the receipt. If writes have continued, migrate a new snapshot or apply a fully fenced, hash-chained tail with complete reconciliation; do not reuse a stale receipt. Publish active CURRENT only after its checkpoint/root/receipts/files and directories are durable. A separate store-selector setting chooses v3 explicitly. No auto epoch initialization, auto migration or automatic fall-through to v2 writes is allowed.

## 6. Rollback rules

| State | Safe action |
|---|---|
| Migration incomplete, v3 never active | Keep source selected. Staging is ignored. Old reader can inspect the unchanged source; its known memory problem remains. |
| Destination verified, no v3 production writes | Revert selector to original source and original code if required. This is a storage fallback, not proof of a healthy service. |
| V3 has accepted new writes | Fence first. Preserve destination, source and all tail/WAL evidence. **Do not select stale v2 and resume trading/capture.** Export an additive v2-compatible reconstruction offline, including all v3 committed canonical rows and native-only/scalar updates, or fix forward with v3. Verify through latest acknowledged LSN/sequence before selecting it. |
| New published v3 generation damaged | Use an older root only with continuous authenticated tail/WAL through acknowledged high-watermark. Otherwise stay fenced and rebuild derived indexes from preserved evidence and receipts. |

An original raw v2 reader cannot understand normalized v3 files. Backward support means reading unchanged old evidence; it is not permission to lose post-cutover commits. The known unhealthy c66f1d7 baseline is not a healthy rollback target. No source/destination/obsolete index generation is deleted in this implementation phase.

## 7. Production qualification boundary

This review did not obtain a current production recovery snapshot. Full migration reconciliation and Node 20 Alpine startup/export tests against that snapshot (or a documented conservative physical equivalent) remain mandatory before canary. Missing bytes, previously removed dedupe keys or unpublished/partial archives must be visible in the receipt and status. Do not convert “all available evidence preserved” into “all historical evidence ever produced is present.”
