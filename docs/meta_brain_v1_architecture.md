# Lightweight Meta Brain V1

This first pass is a prepared, default-disabled shadow module in Orayan. It
requires no extra service slot, exchange acquisition, deep history, timer or
provider call. Heavy Meta remains a separate untouched experiment. Deployment
as a separate lightweight service is deferred; no duplicate independent feed
consumer is introduced in this pass.

## One-way data flow

Existing ORAYAN_SHARED_BIRTH_AI_V1 -> frozen Meta-Lite -> optional birth observer
-> compact feature projection -> frozen model inference -> immutable research
record. Observer return values are discarded by the engine. Existing provider
terminal responses and native PAPER closes flow one way into compact feedback.
No new module imports execution, signals, risk, or gates.

META_BRAIN_V1_SHADOW=true explicitly enables the module. Default is disabled.
Inference has no execution authority or online fit. Without an installed model,
each valid birth emits ABSTAIN / NO_FROZEN_MODEL. This is operational plumbing,
not a trained learner or evidence of predictive value.

## Frozen feature contract

META_BRAIN_FEATURES_V1: planned reward/risk, quoted spread/initial risk,
native birth score, signed side, regime/side alignment and Meta-Lite vote.
Identity includes source epoch, opportunity, cohort, shared context hash and
birth cutoff. Features are scalar and allowlisted. Missing input is explicit;
no imputation from later state. Groq/Qwen statuses are NOT_AVAILABLE_AT_BIRTH:
asynchronous verdicts are joined into feedback, never backdated into a birth
prediction. The shared packet is built once by the existing causal validator.
Top features report signed standardized model contributions, not causal claims.

Outputs: RETAIN/SKIP/ABSTAIN, model id, development training status, uncalibrated
P(positive native realized R) score, reason codes/top three contributions,
timestamp and original cutoff/provenance. Retain >=0.6, skip <=0.4, otherwise
abstain. Missing input, non-prior training or no model causes abstention.

## Reproducible offline development fit

backend/tools/train-meta-brain-v1.js takes curriculum.jsonl, an ISO cutoff, and
an explicit new output file. The curriculum contract is one row per unique
episode with contract, episode_id, birth_cutoff, resolved_at, available_at,
realized_r and values keyed by the six frozen feature names. Clocks are UTC
milliseconds except ISO birth_cutoff. Labels are positive native realized R,
not false-signal labels. All outcomes must have been observed before cutoff.
At least 20 complete rows and both classes are required. Input is capped at
16 MB / 20,000 rows. Fixed standardized logistic gradient descent (500 steps,
learning rate .05, L2 .01), no tuning loop, no model selection. Output includes
curriculum checksum, fixed procedure, parameters and content-derived model id.
No output overwrite. Validation checks hash, schema and finite parameters.

Historical curriculum ingestion/causal row reconciliation and actual fitting
are deferred. The pipeline was verified on synthetic data only. No synthetic
model is installed. A reviewed artifact would be placed at
backend/models/meta-brain-v1.json in a later code/build revision. Its training
cutoff must precede every inference birth. Held-out chronological evaluation,
leakage/selection audit and usefulness are Sol High review items.

## Persistence and operations

New namespace /app/backend/data/meta-brain-v1-evidence under the existing
Orayan volume. Exclusive-create immutable JSON files for compact births, first
provider terminal responses per cohort, feedback and experiment reservations.
No full market snapshot/history copy. Maximum 8 KB per record, 8,192 records,
32 MB total; stop the optional research module at pressure, retain all evidence.
The process maintains at most 256 compact lessons; no persistent mutable learned
weights. Restart derives the lesson index in a bounded directory scan.
Single Orayan process/writer is required; do not share this directory across
replicas. A crash-partial record fails the optional module closed for review.

GET /api/meta-brain/status exposes bounded health/capacity. GET
/api/meta-brain/export streams immutable evidence as NDJSON with both existing
research export authorizations, and fails closed if no authorization is set.
The new evidence is not automatically part of the existing canonical ZIP;
export it separately. Daily rotation/externalization is deferred. At capacity
the module stops rather than silently dropping old history. Its status must
be monitored before any activation. Native PAPER/canonical capture continues.
An I/O failure/crash between canonical close and optional feedback append can
leave missing feedback; recovery reconciliation is deferred and no completeness
claim is made. Disabling the module creates an explicit observation gap.

## Heavy Meta resource strategy

Existing production persistence is PostgreSQL meta-brain-research-db, not a
service filesystem volume. Keep the addon, private network/TLS, environment
references, mb_* tables, legacy evidence if present, archives and receipts.
Existing runtime includes independent Bybit klines/OI/ratio/premium/funding
acquisition. None is reused by this module.

Before pausing: inventory unresolved mb_pending, export current/daily evidence,
verify checksums and external copies, record capture cutoff and existing build,
confirm no collection obligation remains. Then pause only
services/meta-brain-shadow-v1 (never the addon or volume). Resume the same
build mint-ants-3373 to roll back. Preserve its environment and service ports.
Expected freed runtime: roughly the observed 444 MB / 0.032 vCPU; plan quota
reclamation semantics must be checked in Northflank at switch time. The addon
continues consuming resources. No pause/replacement was performed here.
