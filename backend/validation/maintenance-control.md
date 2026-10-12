# Maintenance / drain / seal control

Scope: min-service only. Based on a3f63f1fd230249f3a83421f96dcdb51da9b61e9.
No bounded-memory index, UI, strategy, risk, model, retention, or LIVE authority changes.

## Model A: research sealed, management open

PAPER/MARCI/independent SHADOW lifecycle, experiment arms, excursions and funding share
the canonical store. Pausing them could change outcomes. Maintenance therefore stops
new research admissions and Groq/Qwen dispatch, but leaves existing management running.
Existing SHADOW trades still receive defended-level receipts through the unchanged
evaluator/receipt policy. The minute cache continues for existing management symbols.

`SEALED` means **research sealed**. `sealedWatermark` is frozen at the drained research
boundary. `managementWatermark` reports current canonical totals, including subsequent
management records and their causal references. Those totals may advance while management
is open. These are two cursors into one store, not two physically separate journals.

Only `snapshotSafe=true` proves a full boundary. Full seal requires zero native positions,
counterfactual trackers, V3 trade/arm/funding workers, legacy pending outcomes, unresolved
canonical controls/arms, active management sections, research producers and export readers;
then checkpoint publication and a second clean writer flush. No obligation is force-closed.
Obligation categories overlap: `total` is a conservative blocker count, not a trade count.

## Operator API

All four endpoints require the existing Groq and Alibaba export protections. Every
configured token must match; when neither is configured, access fails closed with 503.
Use the existing `x-groq-shadow-export-token` and `x-alibaba-shadow-export-token` headers.
No new weaker token, query credential, or unauthenticated control is introduced.

| Endpoint | Behavior |
|---|---|
| POST /api/maintenance/enter | Fence synchronously, persist flag, drain, flush, seal research. Body: `timeoutMs` (1–120000; default 30000), optional `retry:true` only to retry FAILED without unfencing. |
| GET /api/maintenance/status | Read-only proof/status. |
| POST /api/maintenance/seal | Wait for zero mutable obligations and publish a full boundary. Same bounded timeout. |
| POST /api/maintenance/exit | Remove durable flag before resuming; idempotent. |

Enter rejects LIVE mode and noncanonical capture. Ordinary mutation routes and new
exports are fenced while maintenance is active. Emergency panic management remains
available behind the same operator protection; any resulting evidence invalidates a
full seal. HTTP and shell/container access remain alive.

Status includes state (`RUNNING`, `ENTERING`, `SEALED`, `EXITING`, `FAILED`), maintenance,
admissionsFenced/providersFenced/archiveFenced, providers.groq/qwen queueDepth/inFlight/
reserved/initializing/openRequests, archiveIdle/exportReaders/archiveBuildActivity,
scanResearchBusy/managementBusy/activeSections, managementObligations, writerFlushState,
pendingRows/pendingBytes, journalBytes/walFiles, captureHalted/pendingFailure,
sequence/attempted/accepted/persisted/lost, sealedWatermark/managementWatermark/fullWatermark,
fullSealed/snapshotSafe, reason, timestamp, capture epoch, maintenanceEpoch, processBootId,
and the underlying canonical capture status. `inFlight` includes advice processing,
not only network sockets; `openRequests` counts nonterminal canonical AI attempts.

## Algorithm and restart

1. Fence before any await and atomically publish maintenance-control.json.
2. Restore management workers; preserve existing engine RUN intent/timers.
3. Drain admitted scan sections, provider reservations/queues/callbacks, archive builds,
   publication and export readers. New provider transport is rechecked after awaits.
4. Existing provider callbacks finish normally. Accepted queued/deferred snapshots that
   have not dispatched receive explicit NOT_REQUESTED/MAINTENANCE_FENCED evidence with
   their causal snapshot. They are not silently discarded or replayed on exit. Existing
   reservations/settlements remain in the provider budget ledger.
5. Publish/fsync existing native trade/RUN checkpoints and V3 working/holdout checkpoints.
   Flush journal, recover canonical WAL by its existing protocol, flush canonical metadata.
6. Require zero pending bytes/rows/WAL files and zero index-journal bytes; require
   attempted=accepted=persisted and lost=0, no halt/failure. Publish research watermark.
7. Management may continue. Full-seal promotion waits for zero obligations/activity,
   repeats publication/flush, and reports a separate fullWatermark.
8. Unexpected post-seal append invalidates the seal **before** preserving the event.
   Status must never treat that invalidated boundary as snapshot-safe.

Timeout/failure leaves admissions/provider/export fences active, management available,
and evidence intact. It returns FAILED with blocker detail. Enter/exit do not replace
timers, listeners or workers or change risk/config/provider budgets. A restarted process
with an active or unreadable flag stays fenced, reports FAILED, and requires explicit
`enter {retry:true}` to reseal. Restart never trusts a persisted old seal. Existing
management workers are restored even when research is fenced.

## Snapshot and rollback procedure

Enter research maintenance; keep management running until obligations resolve. Promote
with `/seal`. Require snapshotSafe, matching epoch/maintenanceEpoch/processBootId,
attempted=accepted=persisted, lost=0, zero pending/WAL/journal, and idle readers/producers.

Through a verified private shell/transfer path, copy the **complete application data
directory** into a new immutable destination. Include canonical checkpoint, segments,
archives, all working trade/control/holdout checkpoints, policies and maintenance flag.
Preserve exact paths/lengths and SHA-256 values in a manifest outside the source data.
Never substitute the current 30-hour export for a complete rollback snapshot.

Check the same boundary again after copying. Any state/identity/watermark/counter change
invalidates the copy for rollback; retain it as evidence. Verify the copy offline and
reconcile event hashes/counts and active working state before declaring it reversible.
Require sufficient space and a tested private transfer before starting a copy.

For a future memory-index rollback, first seal the **candidate-era current** boundary,
preserve all its data, and run the candidate's offline legacy-checkpoint reconstruction
against that immutable copy, writing a separate output. Verify it, then install the
verified current checkpoint only with proven writer isolation. Do not restore an old
pre-canary snapshot over candidate-era evidence.

## Controlled rollout plan (approval required in a separate production task)

1. Independently review the local patch and artifact hashes. Deploy only its exact head,
   based on a3f63f1; keep Node 20.20.2 and every current env/risk/provider/experiment
   setting, including RESEARCH_PRESERVE_EVIDENCE=true. No Meta Brain or memory/UI changes.
2. Before deployment, prove Northflank will run one writer on the volume without overlap,
   inventory current health/queues/management/space and verify configured operator tokens.
   Preserve available baseline evidence. No environment changes are needed by this patch.
3. Bootstrap limit: the OLD process still has its existing incomplete drain/3-second
   shutdown. Observing idle queues cannot fence a race before its first restart. If zero
   interruption tolerance is required, withhold deployment until an independent graceful
   handoff is proven. This patch does not retroactively solve that bootstrap limitation.
4. After an authorized maintenance-only deployment, verify identity, preserved RUN intent,
   one timer/writer, normal PAPER/SHADOW management, auth failures, lost=0 and reconciliation.
   Unexpected restart, config drift, loss, writer halt or lifecycle interruption is a stop
   trigger. Do not automatically roll back data or force-close positions.
5. Enter maintenance; verify fences and provider/archive drain under natural traffic.
   Recheck research watermark stability while management evolves. Do not force providers
   or trades. On FAILED, retain evidence and diagnose; retry without reopening admissions.
6. Wait for zero obligations; full-seal; verify stable fullWatermark repeatedly. Test the
   private snapshot path and offline restore verification. Until successful, rollback
   capability remains unproven. Test idempotent exit and resumed cadence/budgets once.
7. If rollback of the maintenance code itself is needed, retain the latest evidence and
   current working state. Returning to a3f63f1 removes these fences; an active flag in
   that version is not enforced. Obtain a separate proven writer handoff first.

Follow-up: maintenance patch → verified live seal → verified reversible current-watermark
snapshot/rollback state → locally compose the f5b4ac307e57748e60c55742d2782955359d0f3e
memory/UI changes WITH these maintenance controls → resolve shared-file/index-status
integration and rerun its tests → separately authorize that resulting candidate canary.
Deploying literal f5b4ac would remove the controls and is not the intended follow-up.

Residual risks: unresolved or legacy obligations may prevent full seal indefinitely;
no manual terminalization is authorized. Linux filesystem durability, Northflank writer
handoff/shell persistence and private snapshot transfer require live verification.
This patch does not remove the old initial shutdown race, provide a backup transport,
expand storage, or prove compatibility with the future disk-index candidate.

## Three-defect correction qualification

The follow-up maintenance patch checkpoints `symbolStats.json` through the existing
durable atomic writer, consumes its delayed timer, and exposes pending/dirty/failure
and version state. Full snapshot safety also requires the published native version
to remain unchanged. Write/fsync errors retain dirty state and fail maintenance closed.

After existing provider activity drains, maintenance explicitly reconciles both
provider ledgers before publishing either boundary. This operation does not construct
a dispatch runtime or retry an uncertain request. Existing uncertainty records and
reserved usage/cost accounting are retained. SEALED provider polling uses a read-only
ledger load, including cold-cache and day-rollover reads; missing recovery is an error
instead of a publication from polling.

An absent control file alone permits normal first boot. Existing JSON is validated for
state/maintenance consistency, active epoch/boot UUIDs and seal watermark shape/counts.
Unreadable or invalid files restart FAILED and fenced. Valid active flags also restart
fenced, with no trusted seal; explicit retry reseals without reopening admissions.

`snapshotSafe` rechecks full seal and committed flush, all active sections, research and
management obligations, provider drain/recovery, archive builds/readers, native writers,
pending rows/bytes, WAL/journal, attempted=accepted=persisted, zero loss, capture failure,
and equality of current epoch/sequence/counters/native version to the published boundary.
An invalidation reason prevents snapshot safety.

This correction does not establish the first deployment from the old baseline. Before
any future production action, separately prove the outgoing old process's durable
producer handoff, stop-before-start single-writer volume ownership, complete private
snapshot verification and restoration of management obligations. No distributed lock,
platform deployment behavior, memory/UI candidate or Meta Brain change is included here.
