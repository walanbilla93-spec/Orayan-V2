# Meta Brain capture redesign plan

Prepared before capture changes, 2026-10-08. **PLAN ONLY. No deletion, reset, schema or capture behavior changes authorized or executed.**

## Scientific finding

The frozen `Base.predict()` already persists a durable observation ID, event ID/clock, decision and receipt timestamps, complete frozen `feature_snapshot` and hash, availability audit, missing mask, model hashes/version, heads A/B/C/D, cohort and safety flags. It explicitly sets `flow_used_by_base=false`. `Base.observations()` uses completed OHLC and receipt-gated OI, premium, long/short and funding data. Heads A/B labels require the future minute OHLC path and an extra continuity minute. Taker/depth flow is computed online in `Flow`; `base_plus_flow_model` is null.

Therefore existing predictions and labels can score the frozen base heads without reconstructing dense raw flow. However dense flow is also a separately frozen Phase 3B acquisition contract intended for future preregistered Base+Flow research. Stopping routine raw capture changes that research population and removes the ability to invent/reconstruct arbitrary future flow features. Preserve existing evidence. A future sparse epoch needs a declared feature contract and new capture epoch ID; do not present it as lossless continuity of the original raw experiment.

## Current → proposed matrix

| Current stream/field | Category | Proposed persistence | Scientific condition / retention |
|---|---|---|---|
| predictions: all frozen features, hashes, clocks, outputs, missing masks, cohort | MUST KEEP | Immutable research episode; reuse existing observation ID, add capture epoch/contract version | Durable, no routine TTL |
| labels: realized RV/two-sided outcome, entry, censor reason, source receipts | MUST KEEP | Linked outcome, fixed horizon and completeness status | Durable; keep even censored cases |
| boundary/model lineage/universe | MUST KEEP | Immutable boundary per epoch; original boundary untouched | Durable |
| minute OHLC and source receipts | MUST KEEP | One immutable completed minute/symbol plus continuity/gap evidence | Keep at least bootstrap lookback and unresolved label horizon; episode outcome paths durable; no deletion in current epoch |
| raw_trades: entire publicTrade batches and envelopes | BOUNDED FORENSIC BUFFER | Compute deduplicated volume/delta/CVD online; freeze declared 1/5/60s values at decision; optionally raw window around selected episodes/errors | Only after future flow hypotheses/required reconstruction windows are frozen; otherwise short TTL/cold archive proposal |
| depth_1s: 100 price/size pairs, spread, bands, walls, quality | BOUNDED FORENSIC BUFFER / EVENT-ONLY-SPARSE | Decision-time spread/band imbalance/depth, wall/persistence proxy, source ages/u/seq; retain levels only around declared events | Current samples cannot reproduce all book cancellations anyway; ring with explicit byte cap |
| derived_1s/5s/60s: repeated flow, CVD and book summaries | EVENT-ONLY-SPARSE | Freeze all required windows at an episode with receipt bounds, anchor, completeness and quality | Do not recompute overlapping windows from future arrivals; durable selected features |
| raw_liquidations | EVENT-ONLY-SPARSE | Sparse unique liquidation events; freeze side semantics, total/count/windows and missing coverage flags at decision | Retain sparsely if rate stays small; no message ≠ proven zero |
| feature_pipeline_status every 10s | DROP ROUTINE | Emit on state change/quality transition; 5-minute compact counter/watermark heartbeat | Durable transition ledger; repeated unchanged payload discarded |
| capture_status every 10s: nested feature/health payload | DROP ROUTINE / MUST KEEP ledger | Tiny epoch-level counts, first/last IDs, received/persisted/dropped counters, gap transitions, writer sessions | 5-minute counters; compress repeated errors by kind + first/last/count |
| aux_funding every ~47s repeats same 8h publication | DROP ROUTINE | Deduplicate by symbol/source publication timestamp, preserve first receipt and revisions separately | Keep decision-used values/availability; cadence continues in memory |
| aux_oi_5m / long_short_5m / premium_1m repeats | EVENT-ONLY-SPARSE | First receipt per publication; decision-used derived values and provenance | Preserve receipt gating and revision status |
| bootstrap_ohlc repeats on restart | EVENT-ONLY-SPARSE | Bootstrap session manifest/source hashes; deduplicated bars with original cohort | Cannot silently promote bootstrap into prospective labels |
| error/health spam | DROP ROUTINE | Aggregated counters, transitions and bounded representative error | Censoring intervals durable |

## Proposed episode contract

Each episode preserves UTC decision clock, input watermark, symbol, observation/event ID, frozen model and feature contract hashes, only predecision features, predictions/eligibility/abstention, uncertainty/OOD, receipt and availability audit, cohort, and quality/gap flags. Flow snapshot must be captured once before issuance and reference exact rolling bounds, connection CVD anchor, deduplication, last source receipts and depth truncation. Research episodes are the full population, including rejected/censored episodes. Status/ledger carries epoch, expected/issued/matured/censored counts and first/last IDs; export manifests describe the snapshot population.

Outcome paths use predefined 60-minute endpoints plus the existing continuity check; future features must not enter decision snapshots. Reproduction check: replay frozen episode features through unchanged models and independently recompute labels from retained completed minute paths; compare IDs, outputs, hashes and censor flags. Validate that feature calculations and eligibility remain equivalent through gaps/reconnects.

## Bytes/day: evidence and explicit sizing assumptions

Direct audit: logical DB 1,263,105,715 bytes at 06:10:59 UTC; capture_chunks 1,230,782,464 bytes including indexes (97.44%). Six complete hours 01:00–07:00 UTC produced 186,356,024 gzip bytes, or 31.059 MB/hour / 0.745 GB/day. Depth 1s + raw trades + derived 1s account for 91.95%; adding derived 5s gives 96.85%. See META_BRAIN_STORAGE_AUDIT.md for per-stream rates, fields and index costs.

Independent health readings at 2026-10-08T05:42:28.186000+00:00 and 2026-10-08T07:21:06.063000+00:00 show 73,097,216 logical bytes added over 5,917.877 seconds: **44.467 MB/hour / 1.067 GB/day**. This includes table/index/status overhead and excludes WAL. Projected time to the existing 3 GiB logical ceiling was about 42.9 hours from the second reading if this slope persists; capture then stops rather than deleting data. This is a workload projection, not a guaranteed deadline. The supplied 1.73 GB addon screenshot is physical volume usage from another timestamp and cannot be treated as exact table or WAL size.

Illustrative future budget, not a measured forecast: 50 episodes/day × 20 KiB including features/flow/label/path = 1.0 MiB/day; 4,320 completed minutes/day × 500 B = 2.06 MiB/day; 288 compact heartbeats/day × 1 KiB = 0.28 MiB/day; deduplicated auxiliary/publication events + sparse liquidations + transitions budget 3 MiB/day. Durable payload target ~6.4 MiB/day, provision 15 MiB/day including indexes/overhead. Against the measured recent logical growth this would mean ~98.5% lower durable daily growth, **conditional on actual event count and payload measurements**. No promise that current database shrinks.

Raw forensic design: in-memory receipt ring with global hard cap 8 MiB and nominal preceding 120 seconds; high traffic shortens coverage and must be reported. Triggered windows max 2 MiB/event, global persisted raw cap 128 MiB, nominal 24-hour TTL. Durable counters/manifest record window clipping, sampling and omissions. A future TTL needs separate authorization and an epoch-specific mutable store; existing immutable chunk triggers must never be weakened silently. Cold archive is an alternative if arbitrary-feature replay remains required; price and destination need separate decision.

## Rollout sequence (future authorization required)

1. Use the completed direct storage audit and establish required future flow feature windows.
2. Export/checksum current evidence; retain original population and immutable guards.
3. Declare a new sparse capture epoch, feature contract and prospective start boundary.
4. Compare old and new recorder on the same feed in qualification; verify features, labels, gaps, hashes and population counts; measure bytes/day and bounded memory under high-volume traffic.
5. Obtain separate authorization for capture/schema changes and any destructive TTL/reset.
6. Deploy capture change with explicit gap/restart receipt; check no duplicate IDs, execution false, and near-zero idle payload growth except tiny heartbeats.

This task implements a read-only access layer only. Existing data, capture cadence, models, risk state and historical backtest database remain untouched.

## Acceptance measurements for a future epoch

Target durable growth <=15 MiB/day for the stated episode/event workload; measure actual table+index deltas over complete days and high-traffic windows, rather than compressed payload alone. Keep triggered raw forensic storage capped at 128 MiB in addition to durable episodes. At 15 MiB/day, 90 days of durable data is about 1.32 GiB, one year about 5.35 GiB; select archival/retention before exceeding volume headroom. Durable episodes have no automatic deletion; archive policy requires a separate decision. Measure online ring and export memory concurrently before rollout. The observed 21 episodes in roughly 29 hours are below the illustrative 50/day budget; future regimes may differ. No redesign code or TTL was deployed in this task.
