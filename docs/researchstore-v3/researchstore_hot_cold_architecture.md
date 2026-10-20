# ResearchStore bounded-memory architecture freeze

Decision: **SOL HIGH DESIGN APPROVED — READY FOR MEDIUM IMPLEMENTATION**

2026-10-20, Asia/Colombo. Approval is for this design and a separate implementation task. It is not a deployment approval, a production integrity certificate, or a measured memory result for the proposed implementation. No production code or infrastructure was changed in this review.

## 1. Evidence and scope

Inspected local Git HEAD `582d9056c1fbc10dad342bf71e60169e86969b88`, parent `c1875c87925f5425d28e1d48eeea8369ca6bfdb9`, and the prior investigation report and measurements. Repository: `walanbilla93-spec/Orayan-V2`. References below are repository-relative, one-based, at that candidate. A separate untracked scratch data directory exists in that checkout; this review did not modify it.

The investigation used a synthetic population made from eight renamed copies of a real export's metadata: 184,103,711 checkpoint bytes, 215,336 events, 9,248 episodes, 720 AI attempts, **no physical segments/archives**. Baseline `c66f1d7494635030e3871ed78529f83ea1080ff1` failed inside whole-file JSON parsing. Candidate constructor maxRSS was 395,145,216 bytes / 376.84 MiB; lower-bound service startup was about 381.19 MiB. These were Windows Node 24 measurements, not Node 20 Alpine acceptance results. The actual production snapshot and dominant production allocation remain unverified. The candidate result proves a real defect and residual O(history) residency; it does not prove that one allocation explains every production restart.

The source report is `orayan_startup_oom_root_cause.md` in the preceding investigation's outputs. Source checkpoint SHA-256 for that stress fixture: `307bbed0ac4712d584b6e1522c39a0999110a21543372b3f14b3efe444d72f8d`. Do not treat this as today's production hash or epoch.

The architecture preserves every available canonical row, byte-level row hash, epoch, sequence, identity, recovery disposition, dependency, and existing explicit incompleteness. It does not reset epochs, purge evidence, retire obligations, change strategy/risk/execution behavior, enable models/feedback, or change Heavy Meta/PostgreSQL. All new data is additive in a new storage namespace. Evidence expiration, segment collection and old index-deletion routines are prohibited in this work regardless of environment defaults.

## 2. Frozen decision

Keep existing canonical chunk records and WAL recovery semantics. Replace retained JS dictionaries with **immutable, hash-partitioned sorted index files**, addressed by one small generation root. Use exact full-key comparisons, authenticated fixed-size disk pages, and a bounded durable journal overlay. There is one writer and one published generation. No SQLite, LMDB, LevelDB, service database, Bloom filter, or native addon in this implementation.

This selects option 2 plus reuse of option 4: static sorted files for derived indexes, existing journal/WAL and physical evidence for authority. It avoids implementing a general mutable B-tree or an LSM with an unbounded run list. Each shard has exactly one current sorted version. A bounded overlay is merged into touched shards by sequential copy-on-write. Older files remain preserved, but only current root descriptors are loaded.

The costs are explicit: folding a heavily used shard rewrites that shard; CPU and disk work can grow with history. Disk capacity is not bounded. The design guarantees bounded RAM and exact lookup, not constant compaction latency or unlimited retention on finite disk. If disk or fold throughput is insufficient, the implementation must stop new research admission through the existing persistence gate and report it, preserving obligations and committed evidence. Do not secretly add levels, partitions, retention, or a new database to pass a benchmark.

See [cold index specification](researchstore_cold_index_design.md) for the exact format, collision behavior, APIs, transaction ordering and alternatives.

## 3. What the code actually requires

| Code evidence | Semantic consequence |
|---|---|
| `researchStore.js:96–119`, `:310–413` | `events`, `dedupe`, `episodes`, source mappings, native mappings, attempts and extremes grow with retained keys. Their full residency is an implementation choice. |
| `researchStore.js:417–420` | Dedupe compares **current signature for a key**, not membership of every historical `(key,signature)` pair. A→B→A must append three rows. |
| `researchStore.js:437–441` | Source mappings can link late updates to an older epoch. Replacing a missing hot entry with `currentEpoch:source` would fork identity. |
| `researchStore.js:352–406` | Episodes merge context, independent arms and controls; COMPLETE may reopen. CENSORED can still have unresolved controls/arms. Neither label is an eviction proof. |
| `researchAI.js:47–51`, `:56–91`, `:195–197` | Retry numbering, first-definition presence and parsed-response references query historical state. A recent-only cache is insufficient. |
| `researchStore.js:783–806` | Attempt terminal set is exactly PARSED_RESPONSE / TRANSPORT_ERROR / INTERRUPTED_UNCERTAIN. All other latest attempt states need interruption recovery. |
| `researchAI.js:167–224`; both provider `src/ledger.js` | PROVIDER_LEDGER records have request obligations independent of `attemptId`. Recovering only `aiAttempts` misses them. |
| `minimalCapture.js` nativeOutcome/nativePair/observe; `researchExcursions.js:37` | Live point lookups need prior decision, source context, arms and previous extrema. A disk miss cannot become an empty object/default value unless exact absence is proven. |
| `researchCapture.js:161` | Native continuity restore uses an explicit three-hour query; it does not need all native history. The window is a caller's current contract, not a dedupe horizon. |
| `researchArchive.js:79–137`, `:150–205`, `:380–455` | Existing readers, closure and verification allocate history-sized Maps/Sets/arrays and manifests. Replacing only the constructor is insufficient. |
| `maintenance.js:229–235`; `marciRetirement.js:18–36`, `:69–80` | Maintenance and retirement accounting depend on unresolved historical state and exact episode/event hashes. They require paged queries; no receipt may silently cover missing rows. |
| `researchStore.js:180–218`, `:265–309`, `:646–667` | Native-only transactions lack event sequence advancement. A new monotonic storage LSN must cover them and scalar-only transactions too. |

The complete member inventory, including fields introduced outside the constructor, is in [the CSV](researchstore_state_classification.csv). No full-history object/array API survives behind a lazy Proxy: callers are changed explicitly to point reads, cursors or compact counts.

## 4. HOT contract

HOT means state required promptly by operations, **not a promise to materialize every unresolved historical object**.

Always resident, within byte budgets:

1. Current epoch/start/timezone, event sequence, storage LSN, generation identifiers, compact stream counters, health/completeness, reserve state and archive cursor.
2. The fixed-size root directory and authenticated page cache.
3. A bounded journal overlay containing final values/tombstones or blob references, indexed by exact keys.
4. Byte-accounted working caches for currently scheduled episodes/trades, source/native links, attempts and extrema. Small open entries may be pinned while actively used; pins are reserved before accepting new work.
5. One current segment head, WAL transaction descriptor, compact provider summaries and recovery cursors. Detailed historical manifests are never resident.

The durable open-obligation directory lives on disk and is updated in the **same transaction** as episode/attempt/provider changes. It contains all unresolved entries, including older epochs and CENSORED entries with pending work. It is paged at restart. A large open population therefore increases recovery work and disk size, not mandatory RAM. Runtime scheduling must not mark readiness until required management/reconciliation completes; paging must not change trade management order or deadlines. If the executor's pre-existing working population itself exceeds the service budget, report a whole-service acceptance failure; never discard or cap old obligations.

Recent exact dedupe cache: at most 8,192 entries **and** 4 MiB accounted space, whichever is first. Eviction affects speed only. Every cache miss consults overlay then exact disk index. There is no time horizon after which duplicate evidence is acceptable.

Keep active episode pins at most 16 MiB, active source/native/extrema caches at most 8 MiB combined, attempt/provider working state at most 8 MiB. These are proposed engineering limits, not measured production populations. Overflow entries stay addressable on disk; only a shortage of pinned processing capacity blocks new admission. See [memory budget](researchstore_memory_budget.md).

## 5. COLD and rehydration contract

| State | Durable representation / access |
|---|---|
| All event metadata, dependencies, payload locations | Exact event key plus separately keyed repeated children; row payload stays in canonical files. |
| Dedupe | Exact original key → latest original typed signature and event ID. No TTL. |
| Episode summary, arms, controls | Separate keyed records with resolved/unresolved counts; rehydrate an individual summary or page children. Preserve original aggregate projection for audits. |
| Source mapping and context | Exact original source key → original canonical ID plus merged context; survives terminal status/epoch transitions. |
| Native mappings | Latest full value by original key; immutable hour-bucket references support the existing three-hour restore without scanning completed native history. |
| AI attempts/evaluation references | Latest attempt state, stable first-seen order, evaluation count/last attempt/first qualifying parsed response, exact open directory. |
| Provider state | Request and candidate identities, first-input identities, open-request directory, UTC-day counters, historical summaries, bounded minute-window cursor. |
| Extremes | Exact latest trade extrema; active trades page them before observation. |
| Segments, archives, opened epochs, retirement references | Paged catalogue; hashes, sizes, membership references, publication/verification/expired flags preserved verbatim. |

A late record can rehydrate and update any terminal episode or old source mapping. A terminal attempt can also receive later metadata exactly as the existing spread-merge does. Never infer immutable completion from a cached classification. Repeated children are normalized to avoid an episode's `arms`/`controls` becoming a second unbounded object. Raw historical versions remain recoverable from preserved evidence/journals.

## 6. Startup and exactly-once recovery

1. Acquire an exclusive store writer lock. A second writer fails before touching WAL, files or counters. Read `CURRENT`, its bounded checkpoint, generation root, and migration receipt. Verify envelope hashes, epochs, LSN ordering, paths, file descriptors and required head sizes.
2. Validate cold root/header identities and authentication roots. Read cold pages only on demand and authenticate each page, including pages used to establish **absence**. Preserve the existing `verifySegments()` gate by paging through C and stat-checking **every referenced retained segment** for existence and exact size, without an array of descriptors. This metadata work grows with file count; no completed-event/provider-ledger replay, giant manifest, event-key set or full payload hash sweep occurs at normal startup. Full content verification is performed at generation creation/migration and during explicit audits; startup must expose that distinction.
3. Stream at most the bounded active journal tail. Reconstruct its exact overlay; apply final mutations/counter transitions only for LSNs after the hot checkpoint watermark. Earlier tail entries are still needed for disk-key visibility. Check native-only and scalar records by LSN, never by event sequence.
4. Validate/replay the single durable WAL commit. Compare bytes at exact segment offsets, preserve identical already-written bytes, finish incomplete writes, append any missing journal receipt once, and advance indexes/counters once. A torn **uncommitted** tail may be ignored only after proving no published commit refers to it. Committed corruption halts; it is never treated as a duplicate or empty store.
5. Stream the open-obligation directory in batches. Restore management prerequisites and exact source/context/extrema reads. Recover nonterminal AI attempts with the current `INTERRUPTED_UNCERTAIN` event. Recover started provider requests with existing `INTERRUPTED_UNKNOWN_OUTCOME` semantics; no automatic network retry. These are separate obligations.
6. Initialize provider projections from durable summaries/open directories and bounded recent state. Do not call the current whole-history canonical ledger reader to rebuild them. Archive catch-up/export starts only after critical recovery and under the shared job budget.
7. Publish readiness only after these gates pass. Normal `flush()` writes a bounded hot checkpoint; it does not rewrite all shards or force a whole-history verify. Background/fenced shard folding is separately bounded.

See the cold-index document for the authoritative write state machine. Event sequence stays unchanged; storage LSN is internal and includes operations that do not create events. Exactly-once refers to durable canonical append/index/counter effects, not provider network execution.

## 7. Archive and export freeze

Keep current ZIP member names, capture schema `ORAYAN_RESEARCH_V2`, event bytes/hashes, manifest field meanings, provider filtering and causal closure. Checkpoint format version 3 is independent of research row schema. JSON whitespace/property order in newly generated manifests need not match an old ZIP; original ZIPs remain unchanged and hash-addressable.

Exports pin `(generation, checkpointLSN, sequence, tail byte boundary, physical sizes)` in a bounded lease. Selection, dependency closure, episode expansion, event/chunk dedupe and verification use disk spill sets and external sort/merge. These use the same sorted-file primitives; no new in-memory Set grows with export population. Full closure can include arbitrarily old dependencies; it is never trimmed to the requested window. Stream legacy manifest arrays to a scratch `manifest.json`, then add that file to the ZIP. Verify all declared rows/chunks/dependencies and file hashes before marking complete or publishing. One event can be spooled while hashing rather than Buffer.concat of all chunks. Missing evidence blocks publication.

Provider `canonical.read(visit)` remains a full streaming historical API for explicit analysis. Boot recovery uses a separate compact restore contract. Never redefine `read()` to return just a recent subset while claiming compatibility. Ordinary status uses transactional scalar counts and bounded recent summaries; detailed segment/archive/event endpoints are paged with explicit cursors and coverage flags. Existing `/daily` downloads locate a receipt by exact key and verify the file before serving.

Legacy `retention()`, `compactIndex()` deletion, `collectGarbage()` and segment-release paths must not run in v3. Storage folding changes derived current views while preserving old evidence and source generations. It cannot be presented as archival completeness.

## 8. Proof boundary and delivery gates

For retained population H, the resident store bound is:

`fixed root + fixed page cache + bounded overlay + bounded active pins + bounded scratch + one bounded operational input`.

H affects file size, binary-search depth, fold duration, required segment metadata verification and explicit export time. A fixed-width file format and bounded proof-depth workspace prevent even sparse offsets/Merkle paths from becoming an H-sized JS structure. No recent cache, shard list, directory listing or manifest grows in RAM with H. An individual producer input and existing executor state also require measured bounds; this design does not claim that an arbitrary already-created JS object or unlimited simultaneous trades can fit in 512 MB.

Target: full-service startup and steady RSS ≤300 MiB, preferred startup ≤280 MiB; heapUsed ≤160 MiB. This is a target to prove on Node 20 Linux/Alpine, not a result from this review. Container accounting must include file cache and other processes. Preserve the existing 352 MiB old-space setting; raising memory is not a fix.

The implementation has three release gates described in [the Medium plan](researchstore_medium_implementation_plan.md). Migration must be deterministic, additive, restartable and tied to real source hashes. A production snapshot or a documented conservative fixture including physical archive/provider/native histories is required before canary. Missing snapshot access is an operational validation gap, not an unresolved architecture choice.

## 9. Companion deliverables

- [Member classification](researchstore_state_classification.csv)
- [Checkpoint v3](researchstore_checkpoint_v3_schema.md)
- [Cold indexes and write state machine](researchstore_cold_index_design.md)
- [Migration and rollback](researchstore_migration_plan.md)
- [Memory budgets and failure behavior](researchstore_memory_budget.md)
- [Medium implementation phases](researchstore_medium_implementation_plan.md)
- [Acceptance tests](researchstore_acceptance_tests.md)

Retain the incremental reader from `582d905` as legacy-reader support and the basis of a streaming visitor for migration. **Do not deploy that reader alone as the bounded-memory solution**, and do not call its object-returning API from the v3 startup path.
