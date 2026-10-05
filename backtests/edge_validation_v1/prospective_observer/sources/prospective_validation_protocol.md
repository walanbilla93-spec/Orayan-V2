# Prospective same-universe validation protocol

Cohort: `ORAYAN_EDGE_VALIDATION_V1_SAME140`. Registration: 2026-10-04T13:00:57.806545+00:00 (2026-10-04T18:30:57.806545+05:30 Asia/Colombo). Status: **not activated**; this task creates a specification only. Active frozen eligibility: 140/140 discovery symbols, exact list and SHA256 in prospective_cohort_manifest.json.

Start is the first UTC midnight at least48h after BOTH registration and a successful24h research-only capture readiness dry run. Earliest theoretical start is **2026-10-07T00:00:00+00:00**, which is 2026-10-07T05:30:00+05:30 locally. Actual start is null until readiness. Record activation before any cohort outcomes; no past rows and no moving start based on returns.

Evaluate each frozen engine on one complete UTC15m comparison surface at scheduled barClose+1ms. Record actual observer evaluation time separately. Each required input must be completed and physically received by the scheduled decision timestamp; a late callback must use the snapshot known at that timestamp. A just-closed REST/WS bar usually arrives later than1ms: record missing eligibility rather than relaxing timing, delaying entry or reconstructing late input. The readiness dry run must quantify this practical timing bottleneck. It may render the strict prospective test underpowered; any alternate real-receipt decision schedule would require separately preregistered future v2 and cannot silently enter this cohort.

Capture can preload at least72h of raw historical warmup before activation, clearly marked WARMUP_ONLY, received before decisions. No historical decision or outcome joins count. Preserve literal200 contiguous15m histories, source-native gates, mark-close scenario, 1440-minute turnover, BTC regime logic and side/episode lineage. Missing features are never retrospectively backfilled into eligibility. Store per-feature validity flags; missing premium excludes H3 only when base candidate provenance remains valid. Missing symbol/BTC closes excludes H5. Capture rejected and unavailable surfaces for denominator auditing.

Entry reference is ceil(scheduledDecisionAt/60000)*60000 open. Compute only15/30/60/120m inverted simple price-return bps after each endpoint bar is complete and received; require every intervening minute. No execution, fees, stop, target, sizing or delay enters primary outcomes. Outcomes are written to a separate sealed namespace, inaccessible to hypothesis tuning/research until stopping. Operational staff may inspect counts, source latency, gaps and writer accounting only.

Lock60 consecutive calendar days. At day60, evaluate only counts and coverage. Every hypothesis requires>=1,000 complete candidates,>=500 episodes,>=30symbols,no symbol>20%,>=250 candidates in each fixed chronological half and each applicable side>=100 candidates,>=50episodes,>=10symbols. If any hypothesis misses counts, extend the whole cohort once by exactly60days without unblinding. At day120 stop regardless; underpowered hypotheses are INCONCLUSIVE. Half split is the midpoint of the final60/120-day calendar, fixed by duration rather than outcomes. No early success/failure stopping. Prospective inference uses symbol/episode/week clusters plus calendar-month companion; month count is not the external four-month adequacy requirement. Month CI is reported with limited-cluster caveat for60days. Both validation streams remain separate; joint future confirmation requires both to pass.

Discovery frequency justification (276 observed calendar days, partial final month):

|Hypothesis|Candidates/day|Expected60days at discovery rate|Expected episodes60days|
|---|---:|---:|---:|
|H1|133.4|8003|4792|
|H2|216.0|12961|4191|
|H3|79.8|4790|2970|
|H4|49.0|2938|1355|
|H5|249.6|14976|5624|

These rates are feasibility estimates, not guaranteed sample counts; active universe/receipt strictness and regime changes can reduce them. Ten days alone gives only about490 UTC22 candidates at the historical rate. Sixty days covers multiple weekdays, weeks and calendar boundaries, so>=1,000 rather than arbitrary rapid unblinding is defensible. No threshold adapts to observed prospective returns.

Retain all frozen eligible symbols; later delistings remove only future decisions and remain documented. No substitute symbols, thresholds, feature searches, parameter changes, score changes, stops/targets or deployment while active. Freeze observer implementation/config/list hashes at activation, require monotonic receipt clock with UTC offset evidence, daily immutable manifests and independently recompute a sample after unblinding. Repeated source response revisions cannot rewrite what was known at decision.
