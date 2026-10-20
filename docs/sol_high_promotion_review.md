# SOL HIGH promotion review — 2026-10-20

**STOP — HIGH-RISK ISSUE FOUND**

Reviewed PR #13 at 19a79824509fcc058cfad56d9f261e8eb8e07904 against deployed
c66f1d7494635030e3871ed78529f83ea1080ff1. The additive retirement patch accompanies
this review. No merge, production deployment, model installation, feedback
activation, epoch reset, service pause, or database mutation is authorized by
this review outcome. No production operation was performed during the review.

## Gate findings

1. **HIGH — feedback recovery is incomplete.** A committed canonical native
   close can be followed by failed/missing optional feedback. The optional
   module suppresses subsequent work in memory, but restart clears its failure
   flag without reconciling missed closes or publishing durable gap/censor
   accounting. An isolated injected write failure reproduced absent feedback
   with health OK after restart. See metaBrainResearch.js:48-81.
2. **HIGH — experiment assignment can change across restart.** decorate()
   recomputes current lesson eligibility before reading the durable reservation.
   After the prior lessons leave the 256-record index, the same reserved
   FEEDBACK cohort returns an unchanged BASE request. This was reproduced with
   a real route file, later lesson eviction, and module restart. BASE comparison
   cannot be trusted under activation. See metaBrainResearch.js:89-97.
3. **HIGH for activation — crash-file validation is incomplete.** Startup parses
   only feedback files. A truncated birth file named as valid evidence is
   accepted during restart and can enter an export as invalid NDJSON. Direct
   final-name writes have no staged publication/recovery receipt. Constructor
   rejection of all corrupt kinds, durable failure/gap accounting, recovery
   reconciliation, and export hash/identity manifests are required before
   activation. See metaBrainResearch.js:8-24 and 107-110.
4. **Model gate remains closed.** Feature projection is a six-field birth
   allowlist, and asynchronous provider verdicts are excluded. Training checks
   basic clocks and duplicates, but trusts supplied feature/label rows and a
   bare episode_id, does not reconcile epoch/cohort/context/trade identities,
   does not enforce a chronological split, and does not prove artifact training
   provenance. A self-consistent model hash proves content integrity, not an
   audited historical curriculum. Synthetic fitting is insufficient.
5. **Retirement accounting is implemented on the review branch only.** See
   marci_retirement_accounting.md. It has no fake trade closure, no historical
   outcome rewrite, and no blanket exclusion of unresolved episodes. Original
   Marci bytes and canonical episode state remain unchanged. Unknown/mixed
   ownership, evidence damage, and all native/V3/provider/legacy obligations
   remain blockers. No live receipt has been published or reconciled, so live
   sealing readiness is not claimed.

These are concrete promotion/activation blockers, not claims that the native
trading strategy changed. The protected native management/admission and
signals/gates/risk/executor/Meta-Lite/birth-payload fingerprints passed the
focused validation. The diff removes Marci discovery, simulated management,
counterfactual work, periodic ledger writes and UI polling. It introduces no
new timer or execution authority. Existing canonical capture and provider
budgets remain authoritative. New exports reuse fail-closed maintenance auth.

## Validation boundary

One focused pass selected 126 checks covering the retirement patch, original
resource reset, maintenance and adversarial invariants, shared birth packets,
Meta-Lite, provider audit chains/exports, and lean payloads. 125 passed on the
first run; the isolated HTTP authorization check was blocked by sandbox
localhost EACCES. That check alone passed outside the network sandbox.
All 126 selected checks therefore passed. No production behavior or paid
provider transport was used. Three additional isolated fault probes reproduced
the defects above; passing functional checks do not override those defects.
Syntax and whitespace checks passed. No repeated whole-suite cycle was run.

## Frozen first development curriculum and validation protocol

This is a prescribed extraction/validation contract, not a trained artifact:

- Dataset ID META_BRAIN_V1_DEV_001; extraction cutoff
  2026-10-20T10:00:00Z (15:30 Asia/Colombo). Use the live native canonical epoch
  db1ec857-1e53-4c6a-a13d-79a91b4c87fd only after independently confirming it in
  the immutable source export. Preserve all prior epoch/history data.
- Include every reconciled native NEW_ORAYAN PAPER opportunity born before
  cutoff with a complete historical shared birth packet and an observed native
  fill/close. One endpoint per (source_epoch, opportunity_id): earliest filled
  native PAPER trade, ordered by filledAt then trade ID. Record all excluded,
  duplicate, inherited, missing, unresolved or cost-unreconciled rows by reason.
  Exclude Marci, V3 hypothetical paths and Heavy Meta labels. No outcome-based
  cherry-picking and no synthetic substitutions.
- Recompute only the six frozen features from that exact historical birth
  packet and frozen Meta-Lite version. Validate observed/available clocks at
  birth; forbid retrospective provider votes or later quotes. Identity includes
  epoch, opportunity, cohort, shared_context_hash, source event hashes, birth
  cutoff, native trade ID and outcome event hashes. Label is net native
  realized R > 0, never a false-signal label. Require resolved_at <= available_at
  < extraction cutoff, with actual source-observation clocks, not import time.
- Sort by birth cutoff then full identity. Keep equal-cutoff groups together.
  Allocate earliest 60% of distinct birth-cutoff groups to training, next 20%
  to validation and final 20% to locked test; use floor boundaries and record
  exact resulting UTC boundaries/row IDs before examining scores. Purge training
  endpoints whose resolution or availability reaches validation start; purge
  validation endpoints reaching test start. Log all purges. Never randomly
  split rows or share an opportunity across partitions.
- Fit means/scales and the existing fixed logistic procedure on training only:
  500 iterations, learning rate .05, L2 .01; thresholds .6/.4 remain frozen.
  At least 20 reconciled training rows and both label classes are necessary,
  but are not evidence of efficacy. If insufficient, produce NO_MODEL. No
  tuning or second fit based on validation/test results in this first run.
- Record partition counts, class balance, missing/censor rates, retain/skip/
  abstain coverage, Brier/log loss, observed net R and day/symbol concentration
  against frozen native-all/Meta-Lite references. Small samples remain
  descriptive. Test is opened once with the fixed artifact; do not reselect a
  model after seeing it. Future shadow births must follow the frozen training
  cutoff. No learned execution or online weight changes.
- Pin source archive checksums, reconciler revision, feature/comparator hashes,
  row manifest, partition manifest, fixed procedure, training cutoff and model
  hash in a reviewed artifact receipt. Reproduce identical bytes twice from
  the same ordered reconciled input in the offline build. Installation needs
  that real receipt and a code/build-pinned artifact hash; the current validator
  alone cannot authenticate historical training. No model was fit or installed.

## Exact feedback release conditions

No first experiment was registered as activation-ready because persistence and
assignment are unsafe. A future immutable registration must contain eligibility
at birth, exact provider/model/prompt/parser/base-request fingerprints, a fixed
assignment seed/hash, arm counts and intention-to-treat/censor analysis. Persist
assignment before dispatch for all eligible cohorts. Distinguish assigned BASE,
assigned FEEDBACK, NO_PRIOR_LESSONS, QUOTA_CENSORED, DISPATCH_BLOCKED,
TRANSPORT_UNCERTAIN, INVALID_RESPONSE and STORAGE_CENSORED. Never reclassify an
assigned FEEDBACK cohort as BASE because context or dispatch becomes unavailable.

After deployment stability, recovery/export verification and the assignment
fix, start Qwen only at 1% and at most five actual FEEDBACK transport attempts
per UTC dispatch day, including retries and uncertain attempts. The present
route cap counts cohorts by birth day; it must not be represented as that
stricter attempt cap. Enforce atomic persistent reservations before each
transport, and preserve existing whole-provider request/token/dollar caps with
no increase. Confirm actual configured model pricing is known and reserve the
full maximum output cost. Groq requires its own reviewed registration and stays
off. Do not imply that the Qwen experiment authorizes Groq activation.

Retrieve only same-epoch, prior-resolved, prior-available lessons; exclude the
same opportunity. Pin digest and request bytes once; read that reservation before
recomputing current eligibility on retries/restart. Maximum five lessons,
1024-byte digest and <2048-byte reflection envelope; structured categories only,
no raw historical provider instructions. Loss remains NEGATIVE_NET_R and
unsupported path attribution remains AMBIGUOUS_UNSUPPORTED. One existing call
per provider/cohort, no second reflection call. BASE requests/system prompts/
schemas/thresholds remain byte-identical. Unknown completion is charged
conservatively, never freely retried. Stop on accounting gaps or budget failure.

Initial production flags must remain explicitly false or unset:
META_BRAIN_V1_SHADOW, QWEN_FEEDBACK_ENABLED, GROQ_FEEDBACK_ENABLED.

## Heavy Meta preservation and resource decision

Live service remains 78e0820c9cef79537b11f0f73314d5d753e9304e /
mint-ants-3373 / meta-brain-shadow-v1-5c88d4b667; no service pause/deletion.
The live dashboard showed capture_enabled=true, feed_enabled=true,
market_connected=true and capture_pause=null, epoch
ac5ce9dc-bd2d-429e-9e9f-a45399fe1105. Collection is active. Seven verified daily
archives, 2026-10-13 through 2026-10-19, were listed. The status interface does
not inventory mb_pending, external receipts, all PostgreSQL tables or unresolved
joins; absence cannot be inferred. No direct database changes or table-level
backup-completeness claim was made.

One external local copy of the 2026-10-13 archive was downloaded and verified:
SHA256 562c82b42aae3b32d5a9130f6d71aa411f7081af2cd65e17eca97b40a4c2f2ed;
ZIP CRC, manifest bytes/hash/counts, all 15022 event hashes, uniqueness and epoch
lineage passed. This is one completed day, not a full evidence/working-state
backup. Current export was not forced under the observed memory headroom.

PostgreSQL meta-brain-research-db is RUNNING separately: PG17, 6 GB NVME,
private networking/TLS, about 658 MB disk and 288 MB memory. Leave running.
Before any future pause, inventory mb_pending with read-only queries, resolve
or explicitly censor collection obligations, freeze a recorded collection
cutoff, verify current/all daily archives plus external receipts and working
state, confirm environment/build rollback, and prove only the service is
selected. Reuse the service slot only after that preservation gate and an
independently reviewed lightweight service build. Do not delete the service.

Orayan remains c66f1d7494635030e3871ed78529f83ea1080ff1 / brave-gold-9811 /
min-service-5d98495697. Live dashboard snapshot: 473/512 MB, .184/.2 vCPU,
two restarts. Heavy Meta: 444/512 MB, <.001/.2 vCPU, zero restarts. These are
point-in-time platform metrics, not an RSS benchmark or deployment savings.
No after-deploy measurement exists because deployment was withheld.

## Deployment and rollback disposition

PR #13 stays draft/unmerged. Only the reviewed safety patch is added to its
feature branch. No new production build/deploy IDs, live Marci cutoff receipt,
model or enabled feedback experiment. No native behavior/Meta-Lite/epoch reset.

Rollback is presently unnecessary. If a later approved resource deployment
needs rollback, redeploy Orayan build brave-gold-9811 at c66f1d7494635030e3871ed78529f83ea1080ff1
without restoring an old volume over newer evidence. Preserve /app/backend/data
and all newer receipts; keep learner/feedback flags off. Returning to an old
Marci-producing build ends the freeze: subsequent changes must invalidate the
receipt, and require a new reviewed observation period rather than reuse.
Heavy Meta rollback/resume uses mint-ants-3373 at 78e0820c9cef79537b11f0f73314d5d753e9304e
with its unchanged PostgreSQL/environment. Never pause/delete the addon.

Stop promotion here under the requested persistence/recovery and archival
uncertainty rules. The next implementation should address these named defects;
this review does not authorize activating them or inventing historical evidence.
