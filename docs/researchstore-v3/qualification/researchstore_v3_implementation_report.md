# ResearchStore V3 implementation — Phase 1 gate failure

**MEDIUM IMPLEMENTATION PARTIAL — FROZEN DESIGN GATE FAILED**

No production deployment, activation, epoch reset, history deletion, model/feedback activation, Marci receipt, Heavy Meta action or PostgreSQL action occurred. The new primitive is isolated and has no production imports. This is not a canary candidate.

## Verified base

- Repository: `walanbilla93-spec/Orayan-V2`.
- Implementation base: `582d9056c1fbc10dad342bf71e60169e86969b88`.
- Parent/resource-reset fixes: `c1875c87925f5425d28e1d48eeea8369ca6bfdb9`.
- Unhealthy deployed baseline: `c66f1d7494635030e3871ed78529f83ea1080ff1`.
- Remote default `main`, read during this task: `d7f2ba802a4b4204fad70bf502c6f996f76aabc4`. It is an ancestor of the reviewed candidate and lacks the later ResearchStore/resource-reset implementation. Rebasing onto it would remove required functionality. The remote resource-reset branch still resolves to `c1875c8`; no newer merged resource-reset tree was identified.
- Branch: `implement/researchstore-v3`, isolated local clone. No branch push or production-connected build was requested.
- Primitive commit: `e8d5188d842434a3e6c05c68ffd60914afaedc2c`.
- Protected fingerprints: `researchstore_v3_protected_fingerprints.json`. All 18 protected paths match base Git content after normalizing checkout CRLF to LF. Raw working-tree and Git hashes are both recorded, without falsely equating different line endings. Existing native admission/management span fingerprints also pass.

## Implemented slice

Node built-ins only: closed versioned tuple codec, 10 fixed families/256 empty descriptors per family, 80-byte slots, SHA-256 routing/order with full-key identity, 64-KiB authenticated pages, disk Merkle trees, verified-byte LRU, file-handle LRU, byte-accounted bounded overlay, streaming copy-on-write shard fold, bounded offline external run sort/16-way merge, atomic exclusive lock directory without timeout stealing. Immutable content names are never overwritten. Independent codec/hash fixtures and format documentation are checked in before any caller integration.

The benchmark generates and externally sorts 215,336 real SHA-routed D-family keys, 128-byte inline values, and 256 physical immutable shards. It performs 512 positive/negative lookups, then one update per populated shard in a single synchronous fold batch. This intentionally covers the frozen design's evenly distributed batch touching most shards. It is a primitive workload, not migrated canonical evidence, a full service startup, or a realistic ten-family transaction rate.

## Gate failure and required High decision

The authorized temporary Northflank job ran Node v20.20.2 / Alpine 3.23.4, a verified 0.2-vCPU cgroup quota and 512,000,000-byte (488.28125-MiB) memory limit with 352-MiB V8 old space. First Linux fold batch: **34,130.342 ms**, versus the conservative **15,000-ms** management interval supported by unchanged `settings.js` (minimum 15 seconds; default 60 seconds). Maximum individual shard fold: **394.929 ms**. The batch read 52,319,764 logical index bytes, plus 58,816 proof bytes. Holding the writer/event loop for 34 seconds fails support for the 15-second interval.

This is not a measured live-production deadline miss, a same-input native-engine scheduling replay, or proof that all implementations of the frozen architecture are impossible. The actual deployed scan setting was not read. No timing threshold was relaxed. The conservative pre-integration gate failed and broad integration stopped. High must decide whether an approved writer-fenced scheduling approach can preserve native timing and bounded backlogs, or whether the architecture needs revision. Medium did not add shards, levels, workers, a database, retention, or a new dispatch policy.

10× and 100× were not run after the 1× failure, following the mandatory stop condition. Their memory growth, latency and correctness remain unqualified. A27 sustained operation is also not run. The free project's scratch options allowed 2 GB and disabled larger sizes; that would require addressing before a later full 100× physical run, independent of this earlier latency failure.

Windows Node 24 supplementary result: 39,918.881-ms fold, 199,241,728-byte kernel maxRSS. It was not substituted for Linux qualification.

## Validation and limits

- Linux primitive tests: 12/12 passed. Collision, authenticated negative reads, corrupt slots/keys/proofs/header, truncated files, exact replacement/tombstone folds, overlay pressure, closed codecs and empty shards are covered at the primitive level.
- Windows protection regressions: 36/36 passed with temp files inside the workspace. Includes checkpoint reader, resource reset/safety, shared birth evidence, disabled request-byte equality, native/PAPER protection and reserved FEEDBACK retry behavior. An earlier run failed on Windows sandbox TEMP rename restrictions; rerun with a workspace TEMP passed without changing production code.
- This is **not** A01–A26 acceptance. No V3 checkpoint, CURRENT publication, transactional multi-family root, active WAL, storage-LSN replay, hot reducer, obligation projection, provider restore, archive adapter, runtime selector or migration tool is implemented. No production caller was adapted after the primitive gate failed.
- Primitive bounds are implementation limits, not full-service memory qualification. No source snapshot was migrated and no source evidence reconciliation was claimed.
- The read-handle LRU caps itself at 32; a shared reservation including temporary builder/tree descriptors is not yet implemented. Thus the frozen global 32-handle ceiling is not certified by this slice. Root path/symlink fencing, immutable blob verification, authenticated family/root publication, output-wide sorted/order audit and global job/cache coordination also remain integration blockers. A per-shard prototype is not a qualified storage engine.
- No process-kill WAL/crash matrix or power-loss test was run. The dedicated crash report marks every unimplemented boundary honestly.
- The temporary job's first artifact transfer was truncated by the viewer to 1,000 characters per log line. An identical-source rerun changes only artifact chunking to recover complete traces. Both attempts are retained in the evidence package; this is not performance tuning after the stop condition.

See the benchmark CSV, acceptance matrix, memory trace, raw artifacts, example unverified migration receipt and selector/rollback document. The source package includes exact local commit history and a patch against the reviewed base. Do not deploy this partial implementation.

## Downloaded Linux traces

Artifact-recovery run `086f52c3-dbd4-4767-acea-c0201106bcbd` repeated the same eight source files. Fold: **34,016.032 ms**, max single-shard **526.876 ms**; the 1× latency gate failed again. Complete artifact gzip SHA-256: `9e9fb0dfa5723431cea6350bffdcf69afa79c997eaad909add3f8b89001ddbe0` (153 chunks, 76,112 base64 characters). Numbered chunks, byte count and SHA-256 were checked before decoding.

Kernel maxRSS was **135,372,800 bytes (129.1016 MiB)**, sampled heapUsed peak **15,037,512 bytes (14.3409 MiB)**, and cgroup peak **409,419,776 bytes (390.4531 MiB)**. These values include the synthetic fixture build/sort/fold job and its parent measurement process/page cache; they do not prove full-service memory acceptance. The parent requested 50-ms sampling; the observed maximum kernel sample gap was **197 ms** under quota, exceeding the frozen <=100-ms sample cadence. Boundary heap samples are not continuous heap coverage. Raw traces preserve this limitation.

The image tag was `node:20-alpine`; the exact registry digest was not captured, so image-digest pinning is unqualified. `linux-platform.json` records the actual Node, Alpine and cgroup identities. No production-volume durability claim is made from ephemeral scratch I/O.
