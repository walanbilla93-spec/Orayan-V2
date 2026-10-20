# Exact disk indexes: frozen design

Status: approved design; no production implementation or benchmark claimed. Source/commit and non-negotiables are in [the architecture](researchstore_hot_cold_architecture.md).

## 1. Alternatives and decision

| Option | Benefit | Risk / rejection |
|---|---|---|
| Append-only epoch/day/hash files alone | Reuses filesystem/journal; cheap writes | Global source/dedupe keys do not necessarily contain epoch/day. Exact misses require scanning all old partitions; a growing run directory/Map defeats startup bounds. Rejected alone. |
| Sorted immutable key shards + bounded overlay | Node built-ins; exact binary lookup; stream merge; current root is fixed size; reuses fsync/rename protocol | New small static format, checksum-page reader and external merge must be tested. Rewrites touched shard; disk/latency cost acknowledged. **Selected.** |
| SQLite embedded index | Mature transactional indexes and disk spilling; attractive if later workload needs complex queries | New native runtime/build dependency; current dependencies are only ws 8.22.0, yauzl 3.2.0, yazl 3.3.1. Need image/ABI qualification and an explicit immutable generation/integrity publication contract. Not selected for this minimum change. |
| LMDB / LevelDB-like store | Existing paged engines | Native dependency, operational tuning, additional recovery/compaction model; no existing repo integration. No demonstrated advantage sufficient for this phase. |
| Existing archive manifests as the index | No new identity store | Present manifests contain large arrays, duplicate dependencies and incomplete coverage possibilities. Cannot establish exact negative lookups safely. Reuse as migration evidence, not lookup authority. |

The selected format is a static sorted table with copy-on-write generations, not a new general database. No mutable tree balancing, probabilistic filter, unlimited LSM levels, distributed writer, worker pool, or online source deletion is included.

Official sources checked 2026-10-20: [better-sqlite3 installation policy](https://github.com/WiseLibs/better-sqlite3), [v12.4.1 package manifest](https://raw.githubusercontent.com/WiseLibs/better-sqlite3/v12.4.1/package.json), [SQLite PRAGMAs](https://sqlite.org/pragma.html), [SQLite atomic commit](https://www.sqlite.org/atomiccommit.html). The pinned package declares Node 20 support, so SQLite is technically plausible; this review did not build it on Alpine. SQLite cache_size is not a total-process hard cap, mmap can be disabled, and quick_check does not verify all index/UNIQUE consistency. These are reasons to budget and qualify it, not claims that SQLite is unsafe. No package is installed or selected by this design.

## 2. Directory and fixed families

`research-canonical-v3/CURRENT` points to an immutable checkpoint plus a generation root. Source `research-canonical-v2` files are preserved. New files are created exclusively under content-derived names; a generation never edits an old shard in place. Relative references stay inside approved source/v3 roots and reject traversal/symlink escapes.

Ten fixed families, each exactly 256 shard descriptors; empty shards use a canonical empty descriptor:

| Family | Keys / values |
|---|---|
| E | Event ID → original metadata; tagged dependency children and optional physical-location references. |
| D | Original dedupe key → latest typed signature + event ID. |
| P | Canonical episode ID → scalar summary; tagged arm/control children and original insertion ordinals. |
| S | Original source ID → canonical episode ID + merged episodeMetadata. |
| N | Original native key → latest native value; insertion ordinal; exact hour-bucket heads/pages of `(key,versionLSN,at)` references for continuity query. |
| A | Attempt ID → latest merged metadata; evaluation aggregate → count/last attempt/first parsed reference; stable first-seen ordinals. |
| O | Open/unresolved episode, arm/control, AI attempt and provider-request obligations; reason flags and lookup references. |
| X | Trade ID → latest extrema. |
| C | Segment/archive/epoch/retirement catalogue records; archive membership chunks; scalar historical summaries. |
| V | Provider ledger projections: request IDs, terminal IDs, first candidate input, open requests, day/token/minute summaries. |

Family and record-kind tags are closed enums, versioned in the root. Keys are length-prefixed binary tuples, not concatenated delimiters. Source IDs and dedupe keys preserve their original strings exactly. Native source IDs are not assumed to be canonical episode IDs. Context merging and key insertion order remain compatible with existing audit projections.

Shard = first byte of SHA-256(encoded full key). Do not add an epoch/day component to keys that did not have one. Hashes route and order; **full encoded key equality decides identity**. Forced digest-collision tests must work correctly.

The ten family manifests have fixed 256-entry directories; their combined serialized size must be ≤4 MiB. Root is ≤16 KiB and references each family manifest by path, size and SHA-256. A descriptor is ≤1 KiB. No per-history sparse offsets, filenames, archive IDs or Bloom bits live in the root. Root metadata has a fixed set of scalar counts. Empty descriptors are explicit authenticated absence, not a missing-file fallback.

## 3. Immutable shard format

Each nonempty shard has `slots`, `values`, and checksum-tree files plus a bounded descriptor. Record count, format, byte lengths, whole-file hashes and page roots are authenticated by the family manifest/root/checkpoint chain.

Slots are 80-byte little-endian records, sorted by `(32-byte digest, full key bytes)`, one current version per exact key:

| Offset | Bytes | Field |
|---:|---:|---|
| 0 | 32 | Key digest |
| 32 | 8 | Key offset in values file |
| 40 | 8 | Key byte length |
| 48 | 8 | Value offset in values file |
| 56 | 8 | Value byte length |
| 64 | 8 | Storage LSN of latest mutation |
| 72 | 4 | Flags: value/tombstone/blob reference |
| 76 | 4 | Reserved, zero |

The values file contains encoded keys and immutable value bytes. Large repeated collections are separate keys; a large scalar/value can be an immutable, length/hash-checked blob reference. Offsets/lengths are checked before reads; uint64 arithmetic cannot silently round in JS. Implemented positioned-I/O limits are explicit and fail closed; files are never truncated to fit an offset type.

Data pages are 64 KiB, final page length is declared. Each slots/values file has an on-disk binary Merkle checksum tree. Leaves authenticate domain tag, file role, page number, actual length and bytes. Internal nodes authenticate a separate tag and ordered child hashes. Pad leaves use a distinct empty tag. Descriptor binds page count, byte length, tree shape and root. The tree uses heap-order 32-byte nodes; leaf base is the next power of two ≥ page count. Header/role/version are bound by the descriptor. Empty files have a defined empty root. The implementation spec must encode tags unambiguously, with fixed field widths, before fixtures are created.

A point read verifies the requested data page with its sibling path to the descriptor's trusted root. A 64-level fixed workspace suffices for the file format; no leaf-hash array is loaded. Slot reads crossing a page boundary verify both pages. A bounded LRU caches **verified bytes**, keyed by immutable file identity/root and page number, not just path. No `readFileSync(shard)` or whole proof-tree load. Whole-file SHA is for publication/offline audit; normal reads verify pages and do not hash all old files.

This checksum tree is the minimum additional integrity mechanism needed for exact **negative** lookups without a full startup scan. Checking only a returned value's hash would miss corrupted search pages and could turn a duplicate into an apparent absence. Corrupt or missing proof/page/header is `INDEX_INTEGRITY_FAILED`, never `not found`. Hash collision resistance is the normal SHA-256 integrity assumption; hashes are never used as substitutes for full key equality.

## 4. Lookup and update API

Point calls are synchronous to match current capture call chains. Iterators/export/recovery yield in bounded batches. No `getAll()` or object-enumeration compatibility shim is permitted.

| Operation | Exact pattern / ordering |
|---|---|
| `getDedupe(key)` / `hasDefinitionKey(key)` | Recent cache → exact journal overlay → D shard binary search. Compare original typed signature with strict existing semantics. Existence checks stay distinct from equal-signature checks. |
| `getEvent(eventId)` | Overlay then E; preserved original metadata, child-dependency cursor as needed. |
| `getEpisode(id)` / `getEpisodeBySource(source)` | Resolve S first, then P summary; arms/controls fetched by paged child cursors. Never synthesize a new ID from a hot-cache miss. |
| `getSourceContext(source)` | S merged context, including old epochs. |
| `getNative(key)` / `iterateNativeSince(cutoff)` | Exact N read; enumerate only hour-bucket heads intersecting the caller's cutoff/now window, then bounded reference pages. Keep a reference only if its LSN equals the exact latest N value and at meets the cutoff, so superseded updates neither duplicate nor resurrect keys. No full N scan at boot. |
| `getAttempt(id)` | A latest merged state. |
| `getEvaluation(eval)` | A aggregate preserving attempt count, last attempt by **first-seen order**, and first qualifying PARSED_RESPONSE by that order. Existing `Object.values` uses insertion order, not latest-event order. |
| `iterateObligations(kind,cursor)` | O records only, batches ≤256 records and ≤1 MiB. Snapshot/pin generation and merge the bounded overlay exactly. |
| `getExtremes(trade)` | X before the next excursion calculation. |
| `getArchive(day)` / `iterateCatalogue` | C exact receipt or cursor; membership is a disk child list, not receipt.eventIds in RAM. |
| `restoreProvider(provider,now)` | V compact projection + O started requests + bounded minute window. Full ledger `read(visit)` is separate. |
| `status()` | Stored counters; no Object.keys(events), Object.values(episodes), all-segment arrays or archive manifests. |

Iteration order is explicit: event sequence for events; retained insertion ordinal for maps where baseline order affects behavior/audit hashes; family/shard/key order for internal scans. Ordered public output uses external merge if needed. Source metadata uses the exact existing filter of undefined context values. Distinguish absent/null/false/empty-string/number/string signatures; do not normalize them into one value. Evaluation aggregates are based on each attempt's **current latest state**: a later update changing an attempt out of PARSED_RESPONSE must remove it from the qualifying set and select the next first-seen qualifying attempt. Persist ordered candidate references on disk if needed; do not retain an evaluation's entire attempts array.

Native hour pages contain at most 128 references and are updated atomically with the native key. Older hour buckets remain cold/addressable, but normal restore reads only the fixed recent interval. A reference's timestamp uses the original value.at semantics, not journal arrival time. Missing/invalid timestamps follow baseline selection semantics. If current cache capacity is insufficient, callers must use exact point fallback instead of treating eviction as a new native candidate. Closed O view entries are removed from the **current derived obligation view** when folding; tombstones/old values remain in preserved prior generations/journals. This prevents scanning every formerly open obligation at restart without deleting evidence.

P summaries keep counters for unresolved arms/controls, hasDecision, hasCriticalLoss, controlResolved, reason, origin/latest/latestDecision IDs and epoch. Updating a single child reads its previous exact value and adjusts counters, then computes the **same** state transition as apply(). CENSORED does not remove unresolved flags. Full legacy episode JSON is reconstructed as a stream in original property/insertion order when calculating retirement `state_sha256`; preserve hashes of existing receipts.

## 5. Bounded overlay and publication

Journal tail target ≤4 MiB, hard encoded bound 8 MiB, decoded/index accounting ≤16 MiB. Accounting includes keys, strings, maps, references and metadata, not just JSON bytes. Process one transaction at a time. Fold before accepting a transaction that would cross a bound. Values too large for the overlay are streamed into immutable blobs; tail carries checked references. The architecture's bound assumes a bounded single operational producer input; it does not authorize rejecting/deleting old large evidence. Migration streams arbitrarily large legacy collections/blobs.

Folding freezes the writer at LSN F, streams the old shard and sorted overlay mutations into new files, and keeps one merge working set ≤4 MiB. At most 16 input runs with 64 KiB buffers; additional runs are merged in multiple passes. SHA/tree construction uses bounded page buffers and a fixed-depth stack or disk-level passes. Old shard bytes and referenced blobs are never overwritten. One current shard per family/bucket in the next root. New values replace current views, while immutable prior generations and journals retain previous evidence.

No full-table JSON conversion or whole-shard JS sort. Overlay sort is bounded by its 16 MiB cap. A transaction affecting multiple families publishes all their descriptors through **one** generation/checkpoint pointer. A partial fold cannot expose a dedupe update without its event/episode/obligation changes.

Writes pause during the simplest first implementation's fold; reserve capacity for existing outcomes. The 0.2-vCPU latency test is mandatory. If synchronous folding cannot preserve native management deadlines, Phase 1 fails qualification; change the folding schedule under a writer fence before release. Do not keep an unbounded incoming queue while folding. The executor and provider dispatch order are not to be redesigned as part of this fix.

## 6. Authoritative write state machine

The storage LSN monotonically orders **all** durable mutations: event appends, native-only writes, scalar health/suppression/failure changes, catalogue updates. Event IDs/sequences remain exactly the old contract.

1. Drain/reconcile any existing committed WAL before dedupe or a new sequence allocation. Under the sole writer lock, query exact prior keys. Compute deterministic final mutations using the unchanged reducer; capture event timestamps/bytes now, never recreate them with a new clock on retry. Reserve bounded working and disk space.
2. Write and fsync WAL parts and bounded mutation/blob descriptors. Fsync WAL directory. Publish `commit.json` by temp/fsync/rename/directory-fsync. **This is the durable acceptance boundary**, including all index mutations or deterministic references necessary to recover them.
3. Reconcile physical canonical segments at declared offsets. Identical complete bytes are retained; incomplete bytes are repaired only from the committed WAL. A contradictory committed region is corruption and blocks; do not overwrite unrelated later committed data. Fsync each affected file and new directory entries. Only changed segment descriptors travel in the transaction; never the full segment inventory.
4. Append framed, checksummed journal receipt for this LSN and fsync. Receipt includes transaction hash, event sequence if any, final keyed mutations and exact counter transitions. Check duplicate LSN/hash; identical replay is a no-op, conflicting content blocks. Update bounded overlay/hot counters once. Ack success only after physical data and receipt are durable. Event `persistedRows` advances once; native-only mutations advance LSN only.
5. Preserve retired WAL/receipt evidence under immutable names, with an explicit completion marker; do not delete evidence in this phase. Clear the active commit pointer only after durable completion, fsyncing the directory. Startup never enumerates all retired WAL files.
6. `flush()` publishes a new bounded hot checkpoint through H referencing index base C and the bounded tail `(C,H]`. It need not fold. Folding separately publishes a new root through F and a checkpoint whose base is F; future tail is a new journal ID. Fsync all referenced files and directories **before** atomic CURRENT publication. Retain previous checkpoint/root/tail for recovery and review. CURRENT is the only authority for generation visibility.

Journal records need length, LSN, previous-receipt hash, transaction hash, data hash and an end/commit marker. Native updates get their own LSN even when event sequence is unchanged. A crash after step 2 must finish the accepted transaction; after step 4 it must not increment counters again. Failures before durable acceptance remain explicit failures using existing loss/censoring semantics. WAL corruption with unknown accepted extent is an integrity blocker, not permission to increment guessed lost counts or resume.

If journal append is torn after a WAL commit, replay repairs the journal only from that committed descriptor. A bounded active tail may include records before the hot watermark; rebuild overlay visibility from index base, but apply scalar hot changes only after checkpointLSN. Sequence tests alone cannot establish this boundary.

Published corruption cannot silently fall back to a lower generation. A prior generation is usable only with a proven continuous journal/WAL bridge through the acknowledged high-watermark. Otherwise remain fenced and require offline reconstruction. An unpublished `.building` generation can be ignored without changing the last committed view.

## 7. Exact dedupe examples

For the same key K: K/A appends; immediate K/A returns duplicate false; K/B appends; K/A appends again. After cache eviction/restart/fold, results are identical. An old source key still resolves to its original canonical episode. Two distinct full keys with equal forced hash digests both survive and are individually found. A corrupted page in a negative binary search blocks the append; it cannot authorize a new row. No Bloom-filter positive can drop rows, because no probabilistic filter exists.

The original option check is truthy `options.key`; preserve treatment of empty/no key. Preserve definition-presence checks independent of signature. Emit's historical boolean false can mean duplicate/suppression/failure; internal APIs should return a tagged result so new callers do not accidentally conflate those outcomes, while public behavior remains compatible.

## 8. Historical queries and scratch sets

Explicit archive/export/audit operations can scan history with bounded memory. Pin one immutable generation plus exact tail snapshot, then iterate current metadata without collecting it. Spill selected IDs, episode IDs, dependency worklists, seen `(eventId,chunkIndex)` keys and verification joins to scratch sorted files. Each wave uses sort/unique/merge; terminate dependency closure only at a fixed point. Cycles do not permit dropping references. Provider-filtered episode expansion must match existing closure behavior exactly, including explicit cross-provider dependencies already selected.

Physical source scanning may encounter the same event in multiple archives and retained segments. Sort/check all copies by event/chunk identity; identical duplicates collapse, conflicting hashes/bytes block. Keep one logical event spool, not a global chunk Map. Original canonical payload bytes can be exported without parsing a giant row. Detailed JSON manifests are token-streamed to scratch; ZIP entry count is bounded by the fixed stream set, avoiding yazl's per-entry metadata scaling.

No background job may run concurrently with another history-sized job in the first implementation. Cancelled HTTP exports stop their pipeline and release their lease; source files remain preserved. Scratch limits block the job, never truncate the output or set complete=true early.
