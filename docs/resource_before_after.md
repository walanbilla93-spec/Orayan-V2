# Resource before / after

Observed in Northflank on 2026-10-20 (Asia/Colombo); snapshots, not averages.

| Component | Allocation | Before | After |
| --- | --- | --- | --- |
| Orayan min-service | 0.2 vCPU / 512 MB | 0.164 vCPU / 463 MB; 2 restarts / 5 days | Not deployed; no measured reduction |
| Heavy Meta meta-brain-shadow-v1 | 0.2 vCPU / 512 MB | 0.032 vCPU / 444 MB; 0 restarts / 8 days | Unchanged; not paused/replaced |
| meta-brain-research-db | 0.2 vCPU / 512 MB, PG17, 6 GB NVME | 0.011 vCPU / 288 MB RAM; 658 MB disk | Unchanged |
| orayan-data | 6 GB volume | about 0.91 GB used; mounted /app/backend/data | Unchanged |

The Orayan volume mount was verified in Northflank's volume detail UI.
Historical Marci bytes remain on disk by design. New learner stores nothing
while default-disabled. If enabled, new evidence stops at 32 MB / 8,192 files,
with a 256-lesson memory bound. No exact production RSS claim is made.

Existing deployed identifiers:
- Orayan c66f1d7494635030e3871ed78529f83ea1080ff1 / brave-gold-9811 /
  min-service-5d98495697.
- Heavy Meta 78e0820c9cef79537b11f0f73314d5d753e9304e / mint-ants-3373 /
  meta-brain-shadow-v1-5c88d4b667.

New commit/branch/PR: see delivery receipt accompanying this source package.
New build/deploy IDs: NONE. No live settings, database, volume or epoch changes.

## Validation

48 targeted checks passed: retirement/read-only history; protected native
management/admission and signal/gate/risk/execution/Meta-Lite hashes; existing
PAPER fill/close; shared immutable birth/canonical capture; base providers with
mock transports; exports and existing auth; immutable feedback; bounded causal
retrieval/restart; frozen model validation; reproducible synthetic offline fit;
enabled observer/plumbing/route cap/export test; original epoch controls.

The first test run encountered seven Windows sandbox temp-file rename failures;
rerunning the same focused suite with temp files inside the workspace passed.
No production code change was made to bypass those failures.
An isolated HTTP startup smoke passed: server health/PAPER mode, canonical
epoch preserved, historical Marci reads and clear refusal, UI retirement,
default-disabled learner, protected new export fails closed. Sandbox localhost
restriction required running that same synthetic check outside the network sandbox.
Syntax and diff whitespace checks passed. No live provider calls.
No production deployment/OOM observation or historical model fit was performed.
Follow-up focused maintenance validation (required by the retired-obligation
finding): 23 checks passed, including native management while research is fenced,
a single engine timer across cycles, immutable retired Marci, provider fencing
and HTTP authorization. Its localhost test required the same network-sandbox
exception as the startup smoke. Total targeted checks: 71 passed.

## Rollback and deployment handoff

Keep both current services running during review. The branch is based on the
deployed Orayan commit, not main. Deploy Orayan retirement only after reviewing
the diff and recording the retirement cutoff for unresolved Marci observations.
Existing full-snapshot maintenance counts unresolved Marci conservatively;
retirement/censor accounting is deferred rather than clearing those obligations.
This is an additional reason to defer live rollout until review.
Preserve /app/backend/data, all existing environment references and current epoch;
do not submit any reset request. Leave all new flags unset for initial rollout.
Observe RSS/CPU, canonical capture health and restarts over a short interval.
Rollback by redeploying brave-gold-9811; do not restore an old volume snapshot
over newer trading evidence. The new namespace is additive and may remain.

Before enabling shadow evidence, review synchronous small-file write latency,
storage headroom/export lifecycle, failure visibility and reconciliation gaps.
Before replacing/pausing Heavy Meta, verify current/daily archives, external
copies, unresolved joins and preservation of PostgreSQL tables/receipts.

## Deferred to Sol High

Actual historical curriculum reconciliation/fit and chronological validation;
any model installation; feedback experiment activation/statistical registration;
failure/recovery completeness; long-lived evidence externalization;
Heavy Meta pause/service slot reuse; any learned influence on trading (absent).
