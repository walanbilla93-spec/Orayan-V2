# Meta Brain pressure repair — local review only

## Confirmed incident

Service: `meta-brain-shadow-v1`, Orayan V2, London. Verified deployed image:
`valid-mint-17`, commit `e05837e0bc785300db2e1fbdef7cb03063a1543a` on
`feature/meta-brain-research-download-v1`. Resources: 0.2 vCPU / 512 MB.
This repair starts from exactly that commit in an isolated local branch.

The current pod `meta-brain-shadow-v1-686dbd5d57-7dvjm` showed 7 restarts on
initial inspection, then 8 and 9 during read-only observation. Prior pods under
the same deployment repeatedly showed 25 restarts. The three latest completed
exits at initial log inspection were 2026-10-11 03:52:14, 03:56:08 and 04:02:18
UTC (09:22:14, 09:26:08 and 09:32:18 Asia/Colombo). Each showed:

```
observer.run -> bootstrap -> raw('bootstrap_ohlc') -> PgStore.append
OSError: CAPTURE_PAUSED_DATABASE_PRESSURE
Process terminated with exit code 1
```

These three failures are application exits, not evidence of OOM termination.
Readiness is HTTP `/healthz`: initial delay 180 s, interval 30 s, timeout 10 s,
failure threshold 3. No Northflank liveness check was configured. Application
exits occur about 65–69 seconds after startup, before the readiness delay.
The deployed build has not changed; events show container startup and BackOff.
Historical pod replacement is distinct from new application image rollout.
OOM or platform causes for every older instance have not been independently
ruled out.

`PgStore.capacity()` checks `pg_database_size(current_database())`, cached for
10 seconds; capture is permitted only below **3,221,225,472 bytes (3 GiB)**.
At or above that value `append()` raises the observed exception. Northflank
reports **3.63 GB / 6 GB (62%) physical volume use**. This is a separate
measurement and includes overhead; it is not an exact current logical DB size.

CPU peaks reach approximately 0.2 vCPU; memory graphs repeatedly reach roughly
470–480 MiB. They align broadly with startup intervals in the log history.
No per-process/cgroup probe was obtained, so model loading versus restored
payloads versus allocator usage cannot be apportioned. The existing bootstrap
`allrows` list is bounded to six 1000-row pages per symbol; it is not unlimited.
The ordinary PostgreSQL restoration cursor, however, buffers the full matching
result before application iteration.

## Repair behavior

- Check capacity before replay or exchange warmup; keep the observer alive with
  explicit `capture_pause` and `capture_gap` health fields and structured logs.
- Back off capacity polling up to 30 seconds, refreshing liveness every second.
  Readiness remains unhealthy while paused. Do not write periodic pause records
  into an already pressured database.
- Recover only the exact capacity-pressure exceptions. Other task failures and
  checksum corruption remain fatal; a concurrent fatal error is not concealed.
- Stop all capture producers during runtime pressure. Keep accepted buffers,
  immutable predictions/labels/boundary and source evidence intact. On recovery,
  persist the gap before producer restart, clear feed freshness and reconnect
  flow; never present the missing interval as complete capture.
- Bootstrap reuses durable warmup pages and existing prospective minutes,
  fetching only contiguous missing intervals of at most 1000 candles. A rejected
  page stays in memory during pressure and is retried without refetching. Its
  source is flushed before indicator warmup is applied. Original source receipts
  and live provenance are retained. No existing rows are overwritten.
- Restore through a named server cursor with one chunk per fetch, verify SHA256
  before decoding, and iterate gzip lines. Yield during replay for HTTP service.
- Preserve frozen model/config/feature files and original boundary lineage
  `GIT_COMMIT=6b99b620435717bc360d3d9b5ca4d42b88f6ffef`. The reviewed runtime
  hashes are explicitly updated in the overlay manifest; `RESEARCH_REVISION`
  identifies the actual implementation build.

No change to capacity ceiling, resource limits, dense capture cadence, trading
settings, execution authority, table schemas, immutability guards or pruning.
No push, deployment, production restart, env change or database mutation occurred.
The `min-service` deployment and AI-contract task were untouched.

## Verification

Python 3.12, matching pinned scientific/network dependency versions:
`python -m unittest test_capacity_pause test_shadow test_research_api -v`.
51 tests run; **49 passed; 2 skipped**, no failures. Skips need unavailable
upstream audit source / upstream replay predictions. Bundled locked-model replay
and feature/label integrity checks passed. New tests cover startup pressure,
liveness/readiness, bounded polling, runtime recovery, unrelated fatal errors,
accepted-tail preservation, healthy recovery after fresh feed, partial bootstrap
resume, durable restart reuse, lazy cursor memory, checksum corruption and exact
capacity thresholds. Synthetic replay of 20,000 chunks has traced peak Python
allocation below 2 MiB; this does not measure total Linux observer RSS.

No local container runtime was available. Real PostgreSQL cursor integration and
Linux cgroup memory remain deployment qualification checks.

## Current audit limits and deployment plan

The private DB has no external network endpoint. The current service shell did
not connect during attempted natural startup windows; public health returns
503 `no healthy upstream`. Fresh SQL sizes, row counts, per-stream bytes,
duplicate rates, current label backlog and durable checkpoint integrity remain
unmeasured. A credential-free read-only SQL audit is prepared separately.

After separate user approval:

1. Build the reviewed isolated commit for this Meta Brain service only. Preserve
   original boundary GIT_COMMIT, all existing environment/settings, resources and
   one-writer enforcement. Record actual build via RESEARCH_REVISION as already
   supplied by the image recipe. Do not merge into the trading deployment branch.
2. Use a controlled single-writer rollout; no concurrent observer or data reset.
   Keep the existing image as rollback. No resource scaling, schema migration,
   ceiling increase, readiness reconfiguration or evidence deletion is bundled.
3. Expect **alive but capture paused** while logical DB remains above its ceiling.
   Validate stable restart count, explicit reason, low steady CPU, liveness 200,
   readiness 503 and unchanged boundary/model/config hashes.
4. With a stable private shell, run the read-only audit. Compare durable receipts,
   immutable IDs, row populations, pending labels and source checksums. Measure
   RSS/cgroup anon/file/peak/events before loading replay or exporting data.
5. Retrieve essentials first via the existing read-only export using private
   access/forwarding if readiness blocks public routing. Then stream dense
   capture in approved export windows: one symbol and stream per request, at
   most one hour, below existing 25,000-row / 8 MiB compressed-input / 32 MiB
   output limits. Shorten windows when refused. Verify CRC, manifests, SHA256,
   continuity and population totals; avoid concurrent large exports.
6. Analyze duplicate source identities offline and freeze the scientific scope
   of a future sparse/cold-storage epoch. Existing raw evidence remains preserved.
   A capture redesign, retention/archive move, limit change or deletion needs
   its own separately reviewed authorization.

Rollback returns to the old image and its known crash behavior; it cannot cure
database pressure. Stop rollout if source hashes, boundary identity, evidence
integrity or writer ownership differ. Do not reset lineage to force startup.

## Handling issue

The Northflank addon page unexpectedly included credential fields in browser
tool text despite their masked visual appearance. They were not copied into
saved reports/downloads, used for external connections, or changed. Such fields
may remain in this chat's tool history. Avoid that page for future diagnostic
text captures; any credential rotation is a separate production action requiring
user authorization.
