# V3.4B capture hardening and prospective ATR replacement

Primary evidence: `Orayan_V34B_2026-10-03_comprehensive_analysis.md` and the existing service's actual hourly capture ledgers, read before deployment. No production trading rule is promoted. V2 benchmark files, V3.3 evaluation/geometry/outcome simulator and control fingerprint remain frozen. V3 execution is disabled.

## Proven loss mechanism

The deployed `Archive.commit` in `backend/lib/v3Archive.js` summed compressed occupancy across both priority classes for each UTC hour. Priority writes bypassed the 8,388,608-byte hourly cap. Subsequent STANDARD writes threw `V3_ARCHIVE_BUDGET_PAUSED`; `Archive.write` recorded permanent skips. `ShadowJournal.record` advanced its observation state without preserving those rejected payloads, and `observeAI` advanced its source offset. The global archive had healthy headroom and was not the rejection cause for these hours. Reserve accounting could not protect STANDARD rows from the shared hourly cap.

| UTC hour, 2026-10-03 | Physical bytes | Attempted rows | STANDARD skips |
|---|---:|---:|---:|
|03|8,525,209|24,101|2,336|
|04|8,468,589|25,434|1,364|
|05|8,481,966|25,062|1,612|
|06|8,496,597|25,851|1,860|
|07|8,397,671|22,967|156|

These actual ledger buckets reconcile the report's 7,328 post-start permanent losses. Lost payloads remain unavailable; nothing is described as recovered. The headline's 86,700 historical/pre-ledger residual remains unresolved and separate from the 62,241 ledger-era skips. Legacy ledgers lack per-event timestamps, exact reason detail, implementation/cohort attribution and physical-write counters; exports explicitly report those fields unavailable rather than inventing them.

## Capture contract

All seven archive channels are required, unsampled research data. Hourly and rolling size thresholds now raise alarms and never reject those rows. The durable fsynced write-ahead payload and prepared multi-channel redo transaction complete after restart without charging an attempt twice. Irrecoverable validation failures create fsynced tombstones outside rolling retention. Storage failures preserve their original payload for retry; arbitrary disk exhaustion cannot be guaranteed lossless indefinitely.

Hourly ledgers include exact UTF-8 logical rows/bytes, first/last timestamps, channel/type/priority, epoch, cohort, implementation, skip reasons and checksums. Compressed physical writes and growth are distinct; shared block costs use documented integer logical-byte weighting with the last-row remainder. Shared raw exports, summary, ledger and tombstone exports freeze one watermark. New daily immutable manifests include actual ledgers; previously immutable snapshots are preserved.

Live verification also exposed synchronous retained-export enumeration delaying health responses and capture while it counted old compressed blocks. Enumeration now yields after every bounded block and caches counts only on immutable file objects. Replacing a mutable head invalidates its cached counts even if compressed size is unchanged. Audit metadata and file hard links are frozen before the first yield; concurrent writes continue into a later watermark. Concurrent export requests share the same in-flight enumeration. Export lease expiry allows a full download window after enumeration finishes.

The reconciliation equation applies to exact offered-row ledger accounting: `baselineRows(0) + attempted = accepted + skipped`, in both rows and bytes; recovery adjustments are zero. The historical residual is outside this equation and remains visibly unresolved. New cohort counters filter its exact cohort ID, while lifetime ledgers persist. No active analytical cohort is explicitly labeled not started. New ledger keys also partition the exact writer implementation hash. Previously unpartitioned writer hints remain available as unverified hints; their exact hash attribution is explicitly unavailable.

Priority, standard, measurement and full-research completed-hour streaks are separate. Full research also requires continuous receipt pulses and available required causal noise/quote measurements. Partial hours are never counted as complete. Missing measurements can keep full-research status unqualified even when archive capture has no skips.

## Workload proof and budget

See `V34B_CAPTURE_HARDENING_VALIDATION.json`. Real changing retained rows from the worst observed offered-count hour (06 UTC) are repeated to exceed its 25,851 attempted rows by at least 30%, with 3,200 additional lifecycle/path/error/arm burst rows and 70 further replay tail rows. All 36,876 rows and 525,976,623 logical bytes were accepted, zero skipped. V3/V2/AI reconstructed canonical logical hashes equal the offered records. This is stress augmentation, not recovery of lost market data.

The validated hour uses 8,537,694 compressed bytes, exceeding the old 8 MiB threshold. Raise the soft hourly alarm to 10 MiB, retain the 320 MiB rolling target and 30-hour protection. Actual prune/snapshot/restart verification retains 31 cloned validated physical hours, 264,668,514 bytes. Those capacity clones are explicitly synthetic. Estimated worst augmented daily snapshot growth is 204,904,656 bytes. Northflank remains 512 MB memory and the existing 6 GB volume. Sampled replay peak RSS 441,778,176, heap 287,959,536 bytes; independently observed Windows peak working set 501,891,072 includes the offline decoder and leaves limited memory headroom. The online writer does not decode historical exports.

## Cohort and preregistration

The original `V34B_CLEAN_HOLDOUT_2026-10-03T03:10:43.114Z` metadata is preserved in a separate immutable migration file and labeled `capture-incomplete/exploratory`, excluded from new analytical metrics. New collection requires a matching implementation hash and an operator-written live qualification receipt after deployed safety, export and reconciliation checks. It records repair commit, capture policy, budgets and exact ledger baseline. It starts unqualified completed-hour counters at zero; it does not claim a complete green hour immediately.

`ATR1M_1P5_REPLACEMENT_V1` is prospective shadow research. It requires the existing exact causal SMA of 14 completed one-minute true ranges with positive ATR, available receipt and causal cutoff. The decision stop is intended entry minus/plus 1.5 ATR; the modeled fill stop is actual entry minus/plus the same decision-time 1.5 ATR, rounded adversely to tick. It replaces the structural stop, so can widen or tighten. The original structural objective has no 2R cap. Decision and fill cost-adjusted RR/geometry checks still apply. Planned cash risk is bounded by the paired control's cost-inclusive planned risk with downward lot sizing and quantity/notional caps. Frozen fees, slippage, funding approximation, hold limit, target trade-through, gaps and conservative stop-first ambiguity apply.

Independent arm workers continue complete path and funding collection past control termination; missing data is censored. Matched-fill and full-geometry opportunities, geometry rejects, fills/terminal states, equal-risk cash/R, rescue/damage and concentration remain separate from `ATR1M_BUFFER` and frozen controls. A control cost-RR rejection may admit the replacement prospectively, without consuming control slots or its first-admission ordinal. No live outcomes are used to change the preregistered definition.

The actual Groq 400 evidence is a generated `reason_notes` string of length 97 exceeding 96 (`json_validate_failed`). Diagnostics classify that output violation and record request/schema hashes. No unproven request-schema fix is applied. AI provider modules and Alibaba's disabled configuration remain unchanged; AI has no execution authority. Cached pre-fill quotes retain their age and missing-reason labels.

## Validation

Full suite: 196 tests passed, 0 failed, 0 skipped. Tests cover frozen parity, disabled execution, exact exports, WAL/redo restart, pressure/restart tombstones, burst/hour transitions, cleanliness and cohort semantics, ATR causality/replacement/equal-risk checks, independent horizons, gaps/funding/censoring, arm isolation, UI/download routes, shared watermarks, capture during export enumeration and mutable-head cache invalidation. Live deployment qualification and its resulting cohort are recorded separately in the final handover.
