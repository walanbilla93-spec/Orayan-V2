# Meta Brain frontend delivery report

Completed 2026-10-08. **Deployed to the existing free service; no spending.** The storage audit and capture redesign plan are complete. No captured data was deleted/reset, and no capture/schema/model/risk changes were made.

## Access

Live frontend: https://p02--meta-brain-shadow-v1--2c624d5p4kgs.code.run/research/

Enter the private research access key stored in Northflank → existing meta-brain-shadow-v1 service → Environment → RESEARCH_ACCESS_TOKEN. Do not put it in a URL or share it. The masked form establishes an eight-hour Secure/HttpOnly/SameSite=Strict session. The earlier browser session has expired; the live page now correctly asks for the key. Existing health remains on port 8080; research uses port 8081/p02 on the same service. No new service/addon or resource upgrade was created.

The UI has logical database size, approximate dataset counts, capture ranges, observer state, dataset/stream/symbol/UTC filters, an estimate and CSV/CSV.GZ downloads. Exposed actual datasets: capture streams, predictions, linked labels, boundary, capture status. No edit/delete/reset controls. Research bundle export was deferred to keep memory/CPU bounded; the delivery ZIP contains code, reports and evidence.

## Implementation and limits

Code under research/meta-brain-shadow: research_api.py, research_launcher.py, research_memory.py, research.Dockerfile, research_overlay_lock.json, audit_research_storage.py, research_ui/* and test_research_api.py. CI: .github/workflows/meta-brain-research.yml. Reports: docs/meta-brain-research/.

Catalog/index metadata avoids a full capture scan at page open. Fixed allowlists and parameterized queries; separate read-only transactions, cursor streaming, rollback/close on completion. Existing writer role was not broadened; a dedicated SELECT-only role remains optional additional defense. No browser DB credentials, secret URLs, third-party assets or access logging. Unauthorized status/download requests returned HTTP 401; public login page returned 200.

Maximum range one hour, one query/export at a time, query timeout two seconds and overall deadline 120 seconds. Limits: 8 MiB compressed input, 32 MiB CSV output, 25,000 rows; each compressed chunk <=2 MiB, decoded chunk <=8 MiB, line <=1 MiB. Estimated working-set headroom must be >=64 MiB before estimates/downloads and every 256 export rows. Pressure refuses/aborts the download while observer processing continues. Interrupted gzip lacks a valid completion footer. Long/old ranges can time out because current index layout is unchanged; shorten range/select a stream. No indexes were added.

## Deployment and observer safety

Deployed additive commit 5c509d771affd1caa186a6657481a0cf0b141f07; build mammoth-fork-5755 completed successfully in 39 seconds. Existing service remains 0.2 CPU / 512 MB, one instance, CI/CD disabled. User explicitly authorized restart/deploy without spending. A controlled pause → image replacement → resume prevented overlapping writers; resume recorded at 09:15:14 UTC. There was a brief capture interruption during rollout/warmup, approximately 09:12–09:18 UTC; exact gap endpoints were not independently enumerated.

Read-only post-rollout checks found all original 21 predictions, 21 labels and one boundary intact, with one writer advisory lock. Original source/config/model files are byte-identical to frozen observer commit 6b99b620435717bc360d3d9b5ca4d42b88f6ffef; GIT_COMMIT remains that provenance, with additive RESEARCH_REVISION recorded separately. Original boundary remains 2026-10-07T01:50:01.328Z.

Final health at 17:48:14 UTC: HTTP 200, healthy=true, execution_enabled=false, shadow_only=true, write_errors=0, no task errors, uptime 30,766 seconds (about 8.5 hours since rollout). Logical DB 1,894,823,603 bytes. Current-session counters show 12 new predictions and 10 new labels; these are not full historical population counts. Capture still stops at its unchanged 3 GiB logical ceiling without deleting data.

## Memory

Pre-rollout cgroup usage 480,096,256 bytes; main process anonymous memory 360.59 MB. It included 14 audit/console shells plus wrappers (~20 MB anonymous combined), reclaimable file cache, live deduplication/history and Python scientific runtime. Original aggregate 95% alone did not establish a need for paid capacity; the earlier paid recommendation is superseded.

Allocator settings MALLOC_ARENA_MAX=2 / MALLOC_TRIM_THRESHOLD_=131072 and minute malloc_trim release unused allocator pages only. Scientific windows, models and deduplication were retained. Post-warmup cgroup probes measured 311,681,024–325,017,600 bytes; main anonymous memory about 162 MB, no OOM/kill events. Probe shell was exited after measurement. These are early measurements: restart also makes deduplication caches cold, so the entire decrease cannot be attributed to allocator changes and is not a guaranteed steady-state limit. No long-duration memory/load profile was captured. Export memory guards remain active.

## Verification

21 local tests passed in 4.304 seconds; JavaScript syntax passed. GitHub research CI run 37753337237 and shadow safety run 37753337078 succeeded for the deployed code. Tests cover auth/cookies, SQL/read-only lifecycle, schema and range checks, exact nested records/decimal strings, gzip/checksum/line limits, interrupted exports, concurrency, memory accounting/pressure refusal and frozen observer hashes. Container build and production readiness passed.

A real authenticated raw_trades CSV.GZ download for 09:17:35–09:22:35 UTC completed in Chrome. The saved file was fully read through gzip (CRC/footer verified), parsed as CSV and every record_json decoded; live_export_verification.json records row count, bytes, symbols and checksum. The raw research file is retained in the user's Downloads and excluded from Git/review ZIP. A separate historical predictions CSV browser smoke test was not completed; CSV output is covered by local regression tests. Desktop/mobile local preview was checked (mobile width 390, no horizontal overflow); frontend_live.jpg shows the deployed protected page.

## Storage and capture plan

Audit measured logical DB 1.263 GB at 06:10:59 UTC; capture_chunks occupied 97.44%. Recent payload growth 0.745 GB/day and logical database growth 1.067 GB/day are separately measured projections. Depth, trades and derived one-second capture account for 91.95% of payload. The supplied 1.73 GB addon screenshot is physical volume usage at another time; WAL could not be measured with existing permissions.

META_BRAIN_CAPTURE_REDESIGN_PLAN.md defines durable episodes/features/outcomes, sparse status and bounded forensic capture. Illustrative target <=15 MiB/day is conditional on a future declared experiment contract and is not an achieved reduction. Dense acquisition supports future Base+Flow research even though current frozen base predictions already retain their used features. No capture redesign, TTL, reset or deletion was executed.

Draft code review: https://github.com/walanbilla93-spec/Orayan-V2/pull/12 . It remains unmerged; deployment used the reviewed feature branch. The delivery package includes all plans, measured audit/rates, code, tests, patch, screenshots and safety/export receipts; no access keys, DB credentials or raw research population.
