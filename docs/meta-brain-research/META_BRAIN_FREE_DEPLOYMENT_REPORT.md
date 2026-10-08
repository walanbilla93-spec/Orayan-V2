# Meta Brain rollout within the existing free allocation

User authorized restart and deployment on 2026-10-08, with no spending. The earlier paid-capacity recommendation was too conservative: aggregate memory alone did not establish a need for more capacity. This document supersedes that deployment gate. Existing capture, predictions, labels, boundary, models, safety settings and the 512 MB / 0.2 CPU plan remain intact.

## Pre-rollout measurement

Read-only cgroup/process probe: current 480,096,256 bytes; limit 512,000,000; anonymous 386,310,144; file 84,111,360; inactive file 52,482,048. Working-set estimate (current minus inactive file) 427,614,208; estimated headroom 84,385,792. Main Python PID 3: RSS 422,760 KiB, anonymous 352,136 KiB, file-backed 70,624 KiB. Four main-process threads. OOM events and OOM kills both zero; prior hard-limit reclaim events 344.

There were 14 console-shell sessions (including the current one), plus their environment wrappers. Combined env-injector/sh/bash anonymous allocations about 20 MB. Repeated audit-console connections contributed to this avoidable overhead. A replacement pod clears them; probes must exit and console sessions must be closed afterward.

Frozen serialized models total only about 2 MB; the main footprint includes the scientific Python runtime, the 200,000-ID-per-symbol deduplication cache, minute/auxiliary history and transient dataframe allocation. Shrinking scientific windows or deduplication would change experiment behavior, so they are retained.

## Changes for the free rollout

- MALLOC_ARENA_MAX=2 and MALLOC_TRIM_THRESHOLD_=131072; once a minute, malloc_trim returns unused allocator pages to the OS. No live records or arrays are evicted.
- Before query estimates/downloads and every 256 export rows, require at least 64 MiB estimated working-set headroom. Try releasing unused allocator pages first; refuse/abort research export under pressure. Observer processing remains active.
- Conservative export limits: 8 MiB compressed input, 32 MiB decoded CSV output, 25,000 output rows; existing single-chunk/line bounds and one-query gate remain. Catalog/table scan guard remains 32 MiB independently of streamed input size.
- Private access-key form replaces fragment-token links. Keys never enter URLs. Same-origin HTTPS POST exchanges the key for the existing Secure/HttpOnly/SameSite cookie. No existing health authentication changes.
- Original observer, config/model hashes and immutable population boundary remain unchanged.

21 local tests passed, including memory accounting and refusal before database work under low headroom; JavaScript syntax passed. Production deployment succeeded; a real authenticated CSV.GZ export completed and its gzip CRC/footer, CSV and nested JSON were verified. Post-warmup cgroup usage was 311,681,024–325,017,600 bytes versus 480,096,256 before rollout; OOM/kill events remained zero. Restart also cold-started deduplication caches, so this is not a steady-state guarantee. Final health remained healthy after about 8.5 hours with execution disabled, shadow-only and zero writer errors. Full details and evidence are in META_BRAIN_FRONTEND_REPORT.md. No paid resource or billing change is authorized.

References: https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html ; https://sourceware.org/glibc/manual/latest/html_node/Memory-Allocation-Tunables.html . Inactive cache can be reclaimed, but working-set headroom remains an estimate; sustained live observation is required.
