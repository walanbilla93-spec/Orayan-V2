# ResearchStore checkpoint format 3

Frozen schema contract, independent of canonical row schema `ORAYAN_RESEARCH_V2`. See [write ordering](researchstore_cold_index_design.md) and [migration](researchstore_migration_plan.md). New namespace only; leave old `status.json` byte-identical.

## 1. Authority and bounded envelope

`research-canonical-v3/CURRENT` is a ≤4 KiB JSON pointer, atomically published with file fsync + rename + parent-directory fsync on Linux. It carries format/version, generation ID, checkpoint relative path/bytes/SHA-256 and previous pointer receipt reference. Reader validates size before reading. The immutable checkpoint is ≤1 MiB. It contains compact HOT scalars, bounded recovery hints and references, **not every open episode or retained dictionary**.

Illustrative shape; metavariables below are descriptive, not literal production values:

```json
{
  "checkpointFormat": "RESEARCHSTORE_HOT_COLD",
  "checkpointVersion": 3,
  "captureSchema": "ORAYAN_RESEARCH_V2",
  "generation": "<content-derived-generation-id>",
  "parentGeneration": "<previous-id-or-null>",
  "writerCommit": "<40-hex-commit>",
  "epochId": "<unchanged-source-epoch>",
  "startedAt": 0,
  "timezone": "Asia/Colombo",
  "watermarks": {
    "checkpointLSN": 0,
    "indexBaseLSN": 0,
    "eventSequence": 0,
    "latestEventId": null,
    "earliestAt": null,
    "latestAt": null
  },
  "indexRoot": {
    "path": "roots/<hash>.json",
    "bytes": 0,
    "sha256": "<64-hex>",
    "format": "RS_SORTED_SHARDS_1"
  },
  "activeJournal": {
    "id": "<journal-id>",
    "path": "journal/<id>.log",
    "baseLSN": 0,
    "checkpointEndOffset": 0,
    "checkpointHeadHash": "<64-hex>"
  },
  "wal": {
    "directory": "wal-active",
    "format": "RS_WAL_3",
    "lastCompletedLSN": 0
  },
  "counters": {
    "attemptedRows": 0,
    "acceptedRows": 0,
    "persistedRows": 0,
    "archivedRows": 0,
    "lostRows": 0,
    "optionalSuppressed": 0,
    "acceptedBytes": 0,
    "retainedBytes": 0,
    "retainedRows": 0,
    "uniqueDecisionEpisodes": 0,
    "countsByStream": {},
    "bytesByStream": {},
    "attemptedByStream": {},
    "lostByStream": {},
    "archivedByStream": {},
    "episodeStates": {"OPEN": 0, "COMPLETE": 0, "CENSORED": 0}
  },
  "health": {
    "populationComplete": true,
    "captureHalted": false,
    "lastError": null,
    "pendingFailure": null,
    "reserveReleased": false
  },
  "catalogue": {
    "lastClosedDay": null,
    "indexCompactedThroughDay": null,
    "segmentCount": 0,
    "archiveCount": 0,
    "activeSegmentHead": null
  },
  "obligations": {
    "directoryFamily": "O",
    "counts": {},
    "recoveryCursor": null,
    "activeHints": []
  },
  "providerRestore": {
    "projectionFamily": "V",
    "projectionLSN": 0,
    "providers": ["Groq", "Alibaba"]
  },
  "migration": {
    "receiptPath": "migration/<hash>.json",
    "receiptSha256": "<64-hex>",
    "sourceCheckpointSha256": "<64-hex>",
    "sourceInventoryRoot": "<64-hex>"
  },
  "verification": {
    "generationReceiptPath": "receipts/<hash>.json",
    "generationReceiptSha256": "<64-hex>",
    "lastFullAuditReceipt": null,
    "startupMode": "ROOTS_AND_AUTHENTICATED_ON_DEMAND_PAGES"
  }
}
```

Required counter fields preserve their original values/meanings; optional previously absent state is recorded with presence metadata in the migration receipt rather than silently turning unknown into zero. Counts for new derived views must be reconciled. `activeHints` is optional acceleration, maximum 256 entries /64 KiB; it is never the authoritative open list. An empty hint array does not mean no open obligations. Provider restore projections and counts include currently disabled providers' retained obligations without dispatching models.

Historical per-epoch summaries/openedEpochs remain C records. Stream/provider enum maps are closed and byte bounded; arbitrary user-defined stream cardinality cannot enlarge the HOT checkpoint indefinitely. Additional unknown stream names are kept as exact C records, with compact aggregate/lookup support; never discard them. Copy source legacy extension fields to a preserved extension blob with exact hash and presence metadata. Unknown fields cannot simply be ignored if used by a caller.

`indexCompactedThroughDay` preserves legacy provenance only. It does not authorize v3 evidence/index deletion. `retainedRows` counts addressable canonical event metadata, not JS cache size. `retainedBytes` retains the legacy segment-byte meaning; expose separate index/archive/on-disk totals to avoid changing that meaning during migration.

## 2. Index root and receipts

Root ≤16 KiB: fixed ten family references, shard count 256, format/hash algorithms, base LSN, epoch/sequence at base, compact counts, source/generation receipt references. Each family manifest ≤512 KiB and exactly 256 bounded descriptors; combined ≤4 MiB. A descriptor binds:

- family, bucket, generation and exact-key codec version;
- record/live/tombstone counts;
- slots/values/checksum-tree paths, lengths, SHA-256 and authenticated page roots;
- maximum represented LSN and normalized-child/blob format;
- explicit canonical empty-shard identity where applicable.

The generation receipt binds parent root hash, previous receipt hash, first/last folded LSN, corresponding journal transaction-chain hash, event sequence, family/count reconciliation, producer format and every current family-manifest hash. A partition is immutable after fsync/publication. Receipt completeness means these indexes were built/verified at publication, **not that every source archive is complete or every old cold page was re-read on this boot**. Whole-evidence audit coverage has a separate immutable receipt rooted in the paged source inventory.

Hash inputs use explicitly versioned, length-prefixed binary envelopes or canonical fixed-field JSON. No hash includes itself. Generation ID is the hash of its root body; checkpoint hash is held in CURRENT; receipt hashes are held by the checkpoint/root without cyclic references. For receipt/root dependencies, hash the receipt's body containing the *proposed family hashes and parent identity*, then place that receipt hash into the final root. Root hash is added only to the outer checkpoint. External audit receipts may bind the completed root later.

## 3. Validation rules

`0 <= indexBaseLSN <= checkpointLSN <= highest continuous durable journal/WAL LSN`; eventSequence is separately monotonic and is not a substitute for LSN. Root's baseLSN must equal checkpoint indexBaseLSN. Journal base/head boundaries must match the reference and verify through the checkpoint end, then any fully committed tail. Each event-ID metadata sequence/hash must agree with canonical payload when accessed/audited. New native-only operations can advance LSN without changing eventSequence.

All reference lengths/counts/offsets must be safe checked integers under the format's explicit I/O range. Reject unknown version, family, key codec, checksum algorithm, illegal paths, duplicated descriptors, mismatched generation, invalid empty roots, missing files or contradictory watermarks. Do not attempt `initial()` on any such failure. Root or checkpoint corruption fences capture and exposes unavailable/unknown counts, not a fresh epoch with zero loss.

Normal boot reads bounded roots, checks current index file headers/sizes through at most the fixed descriptor count, and authenticates pages used by recovery. It also streams the segment catalogue to preserve the old existence/exact-size verification of every referenced segment; metadata I/O grows with file count while RAM remains bounded. It does not load/hash all shards or replay completed payload history. A missing shard or segment is a blocker. A dormant corrupt page may be discovered only when touched or by a full audit: expose `lastFullAuditReceipt`/coverage and do not claim full-startup revalidation. Every page used for an exact positive or negative query must be authenticated before its answer is used.

## 4. Atomic publication and crash table

| Failure point | Required recovery |
|---|---|
| Before WAL commit publication | No accepted transaction; preserve incomplete files as forensic orphans, never index them as committed. |
| WAL commit durable, segment write partial | Finish exact bytes from WAL, then journal/apply once. |
| Segment bytes durable, receipt missing/torn | Recreate receipt from committed WAL; verify matching bytes; no duplicate append. |
| Journal receipt durable, HOT state not updated | Replay final mutations once by LSN. |
| New shard/family/root files incomplete | CURRENT still selects previous generation plus continuous tail; ignore unpublished candidate. |
| New checkpoint durable, CURRENT not renamed | Same as above; no split generation visibility. |
| CURRENT rename durable, active tail rotation incomplete | Published references are authoritative; old tail remains available. Complete only idempotent bookkeeping after verifying the cut. |
| Published checkpoint/shard/bridge corrupt | Fence; use prior generation only with a verified bridge through acknowledged commits, otherwise offline rebuild. |

Fsync files before referenced directory entries, and fsync the directory after rename. Runtime assumes one writer and a local persistent volume honoring fsync/atomic rename; qualify the actual mounted filesystem. Windows verification cannot certify Linux crash durability. Existing accepted canonical evidence, old checkpoint and prior roots are never overwritten/deleted for rollback.

## 5. Backward reader

Keep `readCheckpointJson` from `582d905` for explicit legacy inspection/backward support. Its current return value still materializes all maps, and one archive entry can contain a giant eventIds array. Migration must add a **visitor/token sink** that streams root dictionaries and nested large arrays directly to spool files. Do not parse the old whole state and prune it after load. V3 boot never auto-falls back to whole-state legacy construction; if migration is absent/incomplete it stays in explicit legacy/maintenance mode. No automatic production migration on constructor entry.
