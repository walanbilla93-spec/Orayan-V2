# Orayan capture reset — plan before mutation

Status: inspection complete for the current source/runtime identity; execution must pass the safety-equivalence and reset-scope gates below. Created before any source, strategy, settings, or captured-data mutation. UTC creation time and SHA-256 are recorded separately in `orayan_capture_plan_attestation.json`; do not rewrite this original plan after implementation.

## Verified target and ownership

Existing Northflank service `orayan-v2/min-service`, repository `walanbilla93-spec/Orayan-V2`, deployed branch `feature/orayan-v34b-capture-hardening-atr15`, commit `5eb0262e51747d76879d85eac877eec3ced0531a`. Runtime implementation SHA-256 `45add96f5e48c660f53071dc699caed53542696bf6ca995f10e12bfe379a4944`. Container root `/app`, Orayan store root `/app/backend/data`. PAPER mode, trading enabled, V3 `executionAllowed=false`; credentials are not read or changed.

The volume `orayan-data` is shared infrastructure. Meta Brain has a separate service and PostgreSQL addon, and an edge observer is a separate job. None is a reset target. Do not clear the volume, run a blanket database reset, or delete local historical/research folders.

The metadata-only pre-reset audit enumerates 40,880 files totaling 1,338,216,469 bytes at 2026-10-07T21:56:18Z. This is a moving pre-stop inventory, not an atomic snapshot. Re-audit after a graceful stop and writer quiescence. Preserve the actual per-file metadata as the scope evidence; do not preserve payload backups.

## Capture matrix and classification

| Current family | Class | Proposed behavior |
|---|---|---|
| V3 signal/surface exposure + matched V2 on every universe scan | C for generic watches; A for candidate boundaries | Capture only structural candidates with a causal direction and reaction, native V2 candidates, admission/rejection/state transitions. Suppress NO_TREND, trend-regime watches, and repeated identical states. Preserve candidate denominators, not a denominator pretending to cover every market instant. |
| V2 candidate births, signal events, research events | A, merge | One decision episode record and compact lifecycle. Keep exact gate checks and decision operands, geometry and config hash; suppress duplicate journal copies. |
| Full V3 measurements, level inventories, reference chains | C except operands | Direct self-contained selected reaction/stop/objective, causal ATR receipt for active ATR arms, required cost/rounding/size geometry, reason codes and availability flags. No unused indicator arrays, nearest-objective ablation inventories or immutable-definition chains. |
| Cross-sectional environment and symbolReturnState | C for disk; B in memory | Preserve in-memory calculations for existing sidecars. Freeze only decision-relevant BTC/regime context with the candidate. No all-day environment files. |
| Trade snapshots and minute paths | A/B | Entry/fill/terminal events, management transitions, final MAE/MFE aggregates and precision/censor flags. Keep internal bar processing unchanged; emit no raw minute candles or periodic MARK snapshots. |
| V3.4B paired arms | A only active policies | Preserve FIRST_ADMISSION_ONLY, FIRST_FILLED_ONLY, ATR1M_BUFFER, ATR1M_1P5_REPLACEMENT eligibility, parameters, decision/fill checks and endpoints. Emit only admission/status/fill/terminal changes. Dormant defended trailing produces no arm rows and is not activated by the redesign. |
| Early-entry / structure-stop recovery / forward labels / order-flow sidecars | C for routine payload archives | Existing in-memory observation/simulation may continue when needed for equivalence. Suppress duplicate payload stores; do not introduce or promote a new experiment. Mark old censored experiments explicitly at the clean epoch. |
| Groq/Alibaba giant input/output ledgers | C unless an active registered endpoint | No routine AI payload replication. Preserve configuration and execution-authority isolation. State plainly if providers continue their existing one-way work but their unused payloads are suppressed. |
| Liquidation/OI/funding research feature streams | C | Parked. Disable research-only liquidation subscription/async forward/order-flow capture. If an existing decision gate actually uses funding, retain its decision operand; trade funding used in net outcomes remains. |
| Repeated cooldown/rate-limit errors | B | First occurrence + count + last occurrence per safe code/subsystem/time bucket. Rare severe errors retain individual compact sanitized records. |
| Capture ledger / tombstones / counters | A | Durable epoch, schema, IDs, offered/accepted/lost counts and bytes, first/last times, retained-population counts and explicit pruning/missing flags. Capture failure never grants trading authority. |
| Raw forensic telemetry | D | Disabled by default. Optional explicit local ring cap of 1 MiB around admitted trades/errors only; no permanent all-day recorder. |

## Proposed record contract

`orayan_capture_schema_vNext.json` is authoritative for exact retained paths. Records use schema `ORAYAN_MINIMAL_CAPTURE_V1`, immutable UUID clean epoch, stable episode ID prefixed by that epoch, source candidate/trade IDs, UTC millisecond timestamps plus export UTC strings, strategy/control/config hashes, and explicit LIVE/PAPER/SHADOW/WOULD_BE mode. No execution settings are copied wholesale into telemetry. Freeze an allowlisted nonsecret decision configuration definition once per hash.

Decision: preserve symbol/side, source strategy/version/cohort, boundary/admission/rejection reason, causal bar time, signal score and used gate operands/check results, used regime, selected structural reaction, entry/stop/objective, raw/cost RR, fees/slippage/rounding/sizing parameters actually needed by the existing simulation, positive causal ATR/receipt/availability for active ATR comparisons. Preserve threshold values via the configuration definition. V2 and V3 comparisons join through native candidate IDs at the same boundary; rejected candidates are distinguished from unobserved generic watches.

Lifecycle: source episode/trade IDs, entry intention/ack/fill and timestamps, initial geometry, management policy, status, terminal reason/time/price, gross/fees/funding/net cash/R, duration, outcome completeness and final MAE/MFE with lower-bound precision. Arm: identity, control trade ID, equal-risk eligibility, provisional/fill stop, original objective, decision/fill rejection, subset flags, causal ATR definition/receipt, admission ordinal, fill/terminal economics and censor reason. Management: actual stop/target/BE/trailing state changes, not every bar. Context is embedded once at a decision, not a separate continuous stream.

## Exact destructive scope

All paths below resolve directly under `/app/backend/data`; refuse symlinks or any path outside this root. No wildcard parent deletion. Before deleting a listed directory, verify every contained file is a known capture artifact; an unknown file blocks that directory's reset.

Directories to clear captured contents: `research-v2` (51 files / 229,651,986 B), `research-events-v1` (97 / 51,437,494 B), `research-supplement-v1` (73 / 7,729,572 B), `early-entry-shadow-v1` (97 / 4,747,660 B), `groq-shadow` (2 / 25,420,464 B), `alibaba-shadow` (2 / 31,871,725 B), `v3-shadow` (7 / 43,302,355 B), `v3-shadow-compact-v1` (40,545 / 912,396,806 B), including old rolling blocks, definitions, hourly ledgers/tombstones, old holdouts, WAL/redo capture payloads, export links and daily immutable snapshots.

Files to clear/reinitialize: `researchEnvironmentV1.json` (3,996,037 B), `researchEventsV1.json` (2 B), `signalEventsCompactV2.json` (22,482,903 B), `signalHistory.json` (2 B), `trades.json` (628,763 B), `marciShadowTrades.json` (4,550,700 B). These are current runtime targets, not copies downloaded into prior research chats.

Important safety gate: `trades.json` is also an input to `risk.checkCircuitBreakers`; circuit breakers are enabled. Do not simply zero it. Before history deletion, isolate the exact safety information into protected operational state, with regression proof of daily-loss and consecutive-loss equivalence before/after reset, including subsequent wins/losses and UTC day rollover. Preserve active executable/PAPER/MARCI positions as working state, never count them as newly born clean-epoch trades. No exchange order cancellations or replay are authorized by this capture reset. Existing open V3 research simulations must either retain operational state excluded from the new population or be explicitly censored at reset; do not relabel their outcomes as new data.

Protected: source and Git history; `.env` and every credential; settings/override maps; deployment manifests, arguments and secrets; `settings.json`; `engineControl.json` (other than an ordinary authorized stop/start); `symbolStats.json`; working execution/lockout/breaker state; `bosPending.json` while needed operationally; `lost+found`; Meta Brain PostgreSQL/service/storage; observer job data; historical backtest database; local prior-chat research inputs/outputs; all other files. Unknown subdirectories/files are protected pending classification. Do not preserve a full captured-data backup. Only active operative state and minimal safety aggregates may survive, clearly outside the research population.

## Retention, volume and caps

Canonical new event files: append-only segmented JSONL, maximum row 16 KiB, maximum segment 1 MiB; decision/config/health per-day caps, separate priority reserve for lifecycle/arm endpoints. Target 10 MiB/day combined with 2 MiB priority reserve, 256 MiB storage hard cap, age cap 180 days. Never silently delete a populated epoch: ledger records pruned files/rows/time boundaries and all-time totals separately from retained counts. A hard-cap rejection is a compact durable loss counter/tombstone and invalidates completeness; never claim a complete dataset. Prefer sealed epochs exported before scheduled expiry. Small checkpoints carry active working state and dedupe only, not historical universes.

Baseline source replay estimated ~195.4 MiB/day immutable capture; actual recent archives and metadata support hundreds of MiB/day. Planning scenario: 500 meaningful candidate boundaries at 3 KiB + 150 lifecycle at 1 KiB + 500 arm transitions at 2 KiB + 100 management at 0.5 KiB + 100 health buckets at 0.5 KiB + config/status <0.1 MiB = approximately 2.8 MiB/day, about 98.6% below 195.4 MiB/day. A stressed 2,000-boundary day may approach 8–10 MiB/day (about 95%). These are estimates, not measured reduction. Re-estimate from implemented row sizes and current eligible density. Idle/no-event disk capture should be zero except changed health/status and bounded working-state checkpoints.

## Execution order and code rollback

1. Save this plan, schema and SHA-256/time attestation; independently review required questions: eligibility/rejection, fill status/mode, frozen geometry/config, clean paired endpoints, net R/censoring, population identity, retention completeness. Resolve unsafe coupling before reset.
2. Implement the smallest observation-plumbing changes in an isolated branch/checkout from the verified deployment. Enable the new policy through an explicit nonsecret marker. Preserve old implementation for code-only rollback. No risk/strategy changes beyond verified state-isolation plumbing.
3. Run meaningful deterministic tests: unchanged frozen signal/outcome core hashes and baseline tests; before/after safety parity; candidate/no-event trigger suppression; stable joins across restart; active/dormant arm handling; terminal/censor endpoints; writer failure isolation; restart/redo idempotency; exact exported count ledger; finite error bucket growth; row/day/storage caps/rotation/retention; no secrets; non-event byte growth.
4. Stop the existing engine gracefully, wait for scan/worker/provider quiescence, preserve active operational state and final metadata-only audit. Stop the service process if writers cannot be quiesced independently. Verify no LIVE orders and no replay risk. Do not pause/delete other services or the shared volume.
5. Apply an exact allowlisted reset, create clean epoch and schema marker; reset research counters/dedupe/cohorts. Receipt lists each path, metadata size/count, removal time and exclusions. Migrate working state without leaking previous population into the new schema.
6. Deploy only as needed to restart this existing service, using its normal GitHub/Northflank workflow. No promotion to main or other services. Restart in the exact prior execution mode and settings; verify implementation/epoch/settings hashes, active safety state and lack of duplicate orders.
7. Smoke-test using isolated disposable fixtures, never fabricate live market trades. Observe a short actual idle/no-event period and report capture bytes, events and working-state bytes separately. Verify exports and population totals. Save post-reset verification and final report.

Rollback is CODE/config only: revert the capture commit or marker and restore the preserved settings/active safety working state if required. Deleted telemetry is intentionally irrecoverable. Never restore an old checkpoint that reintroduces order replay or old population; do not leave a captured-data backup behind.

## Stop conditions

Stop before destructive mutation if any store's ownership is ambiguous, unknown contents appear, safety/working-state isolation fails equivalence, live order restart cannot be proven safe, or access is blocked. Provide the exact blocker and complete unaffected artifacts. Do not substitute clearing only a convenient local export for resetting the actual runtime.
