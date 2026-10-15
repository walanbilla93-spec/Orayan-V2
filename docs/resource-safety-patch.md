# Resource safety patch

Scope: provider startup logging, HTTP status presentation, canonical checkpoint output allocation. No strategy, PAPER execution, provider caps/models, prompts, Meta-Lite, archive retention/generation or research evidence changes.

Startup logging passes a frozen scalar summary to the logger. Full recovery indexes and their contents never enter the startup log buffer.

Ordinary `/api/status`, `/api/v3/status` and `/api/capture/status` project canonical archive/segment metadata into small summaries. Health, reconciliation, episode counts, per-stream counters and fields used for the current UI's daily archive links/storage totals remain available. `/api/capture/status/details` provides the original full capture status read-only. Stored manifests, checksums and exports are unchanged.

Canonical `ResearchStore.flush()` uses synchronous buffered JSON traversal of its existing JSON-compatible state, avoiding the whole-state output string and its conversion buffer. The output buffer is 48K characters, plus the current JSON scalar (a single large scalar is still serialized whole). The traversal does not yield, so the snapshot cannot interleave with event/index mutations. Other uses of the atomic helper retain their existing serializer. No caches, workers or timers were added.

The checkpoint schema and serialized bytes remain identical to native `JSON.stringify` for canonical state. Atomic behavior remains temp write, file fsync, close, rename, directory fsync on Linux, then journal truncate/fsync. A write/fsync/rename failure throws before journal clearing. The previously published checkpoint and replay journal remain authoritative. As before, a directory fsync failure after rename leaves the replay journal intact; replay handles already checkpointed transactions. No checkpoint reader/recovery changes.

Rollback: deploy parent `84e17c5495faf54667c9cb57b1f399b7b66cf113`. It reads the same `ORAYAN_RESEARCH_V2` checkpoint and journal without migration or reset. The new optional detail URL disappears on rollback; current UI does not depend on it.

Focused verification covers scalar recovery counts/logger references; compact status size and actual route/detail behavior; checkpoint byte parity on JSON edge cases and representative 75,000-entry state; epoch, sequence, dedupe, episode/native indexes, completed AI metadata and open obligations across restart; partial-write, fsync and rename failures preserving checkpoint/journal; existing capture/reconciliation, archive safety, PAPER sizing/execution, shared packet and Meta-Lite tests.

Local synthetic allocation comparison (Node 24, Windows, separate processes, explicit baseline GC, 4 MiB semi-space): 13,583,408 identical output bytes; native sampled transient heap 22,073,392 bytes versus chunked 13,824,648 bytes (~37% lower). Serialization 103 ms versus 190 ms. These samples are not production/cgroup peaks and show a CPU tradeoff. Production uses Node 20 on 0.2 vCPU / 512 MB; retained state and startup replay still consume memory. This patch does not establish that all OOM risk is eliminated.
