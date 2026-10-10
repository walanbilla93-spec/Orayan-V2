# Compact lossless research capture

Implementation base: `5766e5fc0698c2049615b347ea4a0866ccd2c316`. Deployment is a separate, explicitly approved operation. Never merge this work into the currently auto-deployed minimal-reset branch during review.

## Storage contract

`backend/data/research-canonical-v2` is the sole active research store. Logical schema `ORAYAN_RESEARCH_V2` has definitions, decisions, lifecycle, outcomes, experiments, ai_calls, integrity, optional telemetry, and experiment_paths. Configuration and shared AI material use immutable SHA-256 definitions. Episode source aliases preserve original epoch identity after restarts and later epochs. COMPLETE requires the control endpoint and every admitted independent experiment endpoint; OPEN explains pending endpoints; CENSORED explains missing origin, legacy incompleteness, path gaps or failed critical persistence.

Physical JSONL rows are lossless 48 KiB binary chunks encoded in base64 with identity, index, total chunks and logical SHA-256. Segments rotate at 8 MiB or 15 minutes, including epoch transitions. WAL parts are bounded, committed before segment application, and replayed idempotently with offset/hash validation. A compact checkpoint plus bounded index journal tracks identities, dependencies and attempted/accepted/persisted/archived counters. A critical failure records a reason and marks the affected population incomplete. Optional suppression is counted separately.

Critical records have no daily, row or queue discard cap. New PAPER/SHADOW admissions and AI dispatch stop on unavailable persistence or insufficient headroom. LIVE admission returns unchanged authorization, and live risk/execution code remains frozen. Existing episode management/outcomes can release a protected 128 MiB reserve. Exhausting protected capacity cannot guarantee recovery; the interface continues to display HALTED and identifies affected streams and loss.

## AI audit and lean request

Both providers persist request material before transport and raw response before JSON parsing. Logical evaluation IDs, unique attempt IDs, retry relationships, provider call IDs, latency, usage, parsing/normalization versions, original and normalized responses, disposition and episode endpoint references remain durable. Restarted unresolved attempts are explicitly INTERRUPTED_UNCERTAIN, never invented responses. Neither shadow advisor has execution authority; successful outputs are SHADOW_ONLY.

`ORAYAN_LEAN_AI_V1` transmits one snapshot_at_utc, trade geometry, quote evidence, regime/breadth/features, exposure and H1/H2 comparators. It omits empty containers, repeated success statuses, clocks, versions, debug/source metadata, long historical arrays and unapproved correlation/policy context. Underlying full causal snapshots, including observed/available/birth clocks and engine/comparator versions, are reconstructed from an AI_FULL_CAUSAL_AUDIT definition and immutable AI_CONTEXT_FRAGMENT references. Actual transport parameters, system prompt and response schema have their own immutable definitions; exact requests reconstruct and verify their SHA-256. Actual request and response clocks remain separate audit records. Credentials are excluded; any exceptional content redaction retains a digest and explicit redaction flag rather than claiming byte-exact reconstruction.

Deterministic freshness checks reject stale/future candidates and quote/regime/exposure evidence before dispatch, in addition to existing causal leakage validation. The dispatch boundary rechecks freshness after asynchronous budget lookup. Structured missing_useful_data is bounded to eight strings of at most 128 characters and remains in original/normalized output. It is research evidence for future experiments, not an instruction to enlarge continuous capture. No synthetic confidence map is generated. Model confidence remains an uncalibrated self-report.

## Archives and exports

Daily closure uses Asia/Colombo midnight unless explicitly configured; event clocks stay UTC. Streamed ZIPs contain manifest.json, schema.json and chunked per-stream records. Manifests enumerate event/dependency identity, checksums, counts and integrity. A .building file becomes final only after complete checksum/closure verification and durable publication. Seven completed downloadable archives remain, plus current segments; dependency closure can include older origins. Interrupted builds never publish complete archives.

Current ~30-hour exports read canonical segments and retained daily ZIPs into a temporary download ZIP, with causal dependency closure and pinned source files. They do not maintain a second dataset. Combined exports retain both existing provider export-token checks; filtered exports retain only the requested provider's AI chain and shared causal endpoints. Tokens travel in headers and are never persisted in the UI or URL. Publication, successful checksums/integrity and dependency/read pins gate source deletion and retention. Old epoch changes never delete archived history.

## Offline preservation and legacy import

`backend/tools/research-data.js inventory|backup|plan|import SOURCE [NEW_TARGET]` is offline tooling. Inventory hashes every file and flags files that change while read. Backup writes a new directory outside its source, refuses overwrite/symlinks and verifies checksums. Inventory/backup cannot promise one atomic instant for a hot production volume; changing files must be retried or preserved using a consistent platform snapshot. Raw backup artifacts require access-controlled storage and must not be committed.

Plan is read-only. Import targets a separate new store, verifies source before/after, deduplicates by source file checksum and line identity, and labels historical evidence LEGACY/INCOMPLETE/CENSORED. Deleted requests, responses and endpoints are never reconstructed or inferred. Import is not wired into startup. No migration or backup of production has been executed by this implementation.

## Operational review gates

Before deployment: download/preserve surviving production data read-only and verify its full inventory; rehearse Linux/container crash durability, permissions and resource limits; confirm live free space, active config/timezone and approved image SHA; review storage contributors and writer latency; rehearse rollback while keeping a compatible V2 writer and existing-episode management active. A blind rollback to the old capped/destructive-reset image is unsafe for research continuity. Use a separately tested compatibility image or halt new research intake while preserving management and the canonical store. Never delete the V2 directory or rerun the V1 reset.

Only after explicit approval may deployment/migration/merge occur. Live per-stream rates and provider-billed token reductions are still deployment-time observations, not claims derived from synthetic fixtures.
