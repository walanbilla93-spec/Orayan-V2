# 512 MB service memory budget

Proposed limits, **not measured results of an implementation**. Units below are MiB = 1,048,576 bytes. Read the actual cgroup byte limit; a platform label “512 MB” is not proof of 512 MiB. Keep the existing `--max-old-space-size=352`; this budget does not require raising it.

## 1. Resident allocations

| Component | Target allocation ceiling | Bound / accounting |
|---|---:|---|
| Node/V8/native libraries, code and ordinary idle service state | 65 MiB | Measured allowance, not enforceable by this module; qualify actual image. |
| Native engine, market data, existing noncanonical runtime | 65 MiB | Requires whole-service measurement; current native trades/environment/holdout readers may violate it. No arbitrary history truncation permitted. |
| Root manifests, compact checkpoint, scalar state | 8 MiB | Checkpoint ≤1 MiB serialized, root ≤16 KiB, family manifests ≤4 MiB serialized; decoded representations count too. Use compact descriptors if JSON expansion exceeds allowance. |
| Verified cold page cache + proof workspace/file handles | 16 MiB | Byte LRU; proof depth fixed; ≤32 open handles, close on eviction. |
| Journal overlay including decoded keys/strings/references | 16 MiB | Encoded tail ≤8 MiB; fold before either byte bound. |
| Active episode working state/pins | 16 MiB | Other unresolved state stays in disk O/P; no eviction of an executing pin. |
| Active source/native/extrema working state | 8 MiB | Paged exact fallback; entry caps supplement byte accounting. |
| Attempts/provider recovery working state | 8 MiB | All outstanding identities on disk, batches ≤256/1 MiB; no evicting open requests as resolved. |
| Recent exact dedupe accelerator | 4 MiB | ≤8,192 entries and byte ceiling; disk fallback on every miss. |
| WAL, row serializer, reducer and merge scratch | 12 MiB | One transaction; streamed blobs and pages; merge workspace ≤4 MiB. |
| One archive/export/migration-style scratch pipeline | 12 MiB | One history job at a time; spill sets/manifests; source data on disk. Offline migration sort budget separately ≤16 MiB. |
| GC/allocator/measurement slack | 40 MiB | Allowance; RSS is the acceptance metric, not sums of JS payload estimates. |
| **Planning total** | **270 MiB** | Approximate full-service allocation plan; not a sum of independently measured RSS components. |

Preferred startup maxRSS ≤280 MiB; mandatory full-service startup and normal steady-state maxRSS ≤300 MiB. HeapUsed target ≤160 MiB. Process RSS includes V8 reserved/committed pages and external buffers; a cache's serialized size is not its real resident cost. Track heapTotal, heapUsed, external and arrayBuffers, avoiding double-counting arrayBuffers already contained in external. Measure maxRSS and cgroup `memory.current`/`memory.peak` where available, with file-cache/kernel accounting. Require cgroup peak ≤400 MiB on the actual ≤512-MB limit; retain the remaining margin for bursts and accounting differences. A larger unmanaged side process invalidates this plan.

## 2. Bound with respect to history

For constant operational inputs/concurrency, increasing completed retained history from H to 10H/100H must not increase roots, page caches, overlay, active pins or scratch limits. Ten families ×256 descriptors is fixed. Sparse offsets, archive membership, normalized episode children, Merkle leaf hashes, generation lists, seen-ID sets and retired WAL inventories remain on disk. File offset/proof arithmetic uses a fixed-width format with checked representability. Recovery reads bounded roots/tail, recent native hour buckets and disk open directories, without completed-event/provider-ledger replay. The existing all-segment existence/size gate remains a paged metadata scan; startup time is not claimed to be independent of history.

Open/unresolved cardinality is not assumed constant. All such entries are durable; recovery pages them without retaining them all. If the executor itself requires simultaneously resident unresolved trades beyond its existing measured allowance, this storage design cannot certify the whole service. Preserve obligations, block new admission through the existing persistence gate and fail qualification. Never “solve” this by censoring/retiring episodes, evicting requests, shortening a dedupe horizon, or completing them without evidence.

Retained-history boundedness is conditional on bounded individual operational inputs. Current emit constructs a row/JSON buffer, and some callers already own large objects. Measure maximum actual row, metadata and obligation sizes; budget the transient copies. Old oversized source values must be streamed to destination blobs. A newly presented row exceeding safe processing space must be held/fenced before durable acceptance with an explicit error; there is no permission to silently suppress a critical row or delete its WAL. Add an upstream reservation/preflight where needed, keeping existing executor behavior. If an already-durable transaction exists, recover it using disk spools and reserved workspace rather than refusing its existence.

## 3. Pressure and hard failure

| Trigger | Required behavior |
|---|---|
| A cache reaches byte/entry limit | Evict unpinned cache entries only; exact disk fallback. Not loss/incompleteness. |
| Overlay approaches cap | Stop new writer admission long enough to fold under bounded workspace. No unbounded queue. |
| New research reservation cannot fit | Existing capture admission gate returns unavailable/degraded. Do not change signal/gate/risk geometry. Record reason durably when possible. |
| RSS ≥300 MiB or heapUsed ≥160 MiB | Stop launching exports/archive catch-up/provider dispatch; shed caches. New admissions remain fenced until measured headroom returns and integrity is healthy. This is an acceptance failure, not a normal target operating mode. |
| RSS ≥336 MiB or heapUsed ≥192 MiB | Fail-closed new research admission, release noncritical caches/jobs, preserve current committed WAL and operational outcome lane. Expose bounded health. Do not induce restart loops as the remedy. |
| Corrupt cold page/root or unproven absence | Fence captures/dispatch using existing safety contract; leave all evidence untouched. Never use `{}`/null as an error fallback for a correctness lookup. |
| Scratch/disk exhaustion | Abort incomplete export; never publish completeness. Preserve committed writes; keep protected outcome reserve behavior. No cleanup of historical evidence. |

Sample RSS at ≤100 ms during qualification and high-watermark signals at transaction/job boundaries in production. Soft/hard thresholds are defense in depth: they cannot rescue an unbounded synchronous allocation. Limits must be enforced before allocating, with separately reserved processing space for existing outcomes. No forced GC is required to meet acceptance. Failure while an outcome cannot be persisted retains the existing explicit loss/censoring/incompleteness behavior; do not reset counters to make status healthy.

## 4. Measurements required

Use Node 20 Alpine with the exact lockfile/image and matching CPU/memory cap. Compare 1×/10×/100× completed populations with identical open state; also test large unresolved populations, archive/provider histories and concurrent current export. Record stage RSS/heap/external, kernel high-watermark, cgroup peaks, elapsed time, bytes read/written, fd count, disk headroom and longest native management delay.

Prior 376.84/381.19-MiB results on Windows Node 24 only justify the redesign. None of these proposed ceilings has passed yet. See [acceptance tests](researchstore_acceptance_tests.md).
