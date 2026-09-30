# Orayan V3: first research tranche — 30 September 2026

V3 is a separate, one-way shadow observer inside the existing Orayan V2 codebase. V2 continues to generate and execute its original orders. V3 emits no executable signal. No profitability claim or retrospective OB/VP performance claim is made.

## Frozen benchmark and attribution

Tag `orayan-v2-benchmark-2026-09-30` identifies GitHub main commit `d7f2ba802a4b4204fad70bf502c6f996f76aabc4`. Its tree matches the deployed Alibaba-dark branch commit `bc962b7`. `backend/lib/v3Benchmark.json` captures the non-secret effective settings read from the running service before this deployment. Every V3 row hashes its current settings and reports `benchmarkConfigMatch`; changed configurations become separate episode keys rather than silently pooled cohorts. Operator settings are not overwritten.

V2 signal builders, gates, scoring, sizing, executor, market-data provider, Marci, Groq and Alibaba code are unchanged. The engine adds only the delimited V3 observer call. Tests compare all execution code and the stripped engine directly with the frozen commit.

## Stage V3.0

`signals_trend_v30.js` is an explicit pivot-only ablation of frozen `signals_trend.js`. Its only behavioral correction uses all supplied CLOSED candles for width-two confirmation. The original V2 stop detector intentionally stays unchanged as the control. The ablation retains EMA entries and fixed nominal targets solely to measure the engineering change; these are not V3 structural orders.

Bybit's `allLiquidation.S` is position side: Buy means liquidated long; Sell means liquidated short. The research window aggregator is corrected, filters both event and receipt clocks, and labels its interpretation version. Raw buy/sell values are unchanged. Existing files are not rewritten. Historical inverted window values must not be merged with the new interpretation.

Prospective compact capture becomes `PROSPECTIVE_COMPACT_V5`. Current updates retain their own physical capture, decision, signal, episode-origin/age clocks and scalar features. They no longer omit current inputs and rely on a historical birth. Arrays alone are omitted from update trendMomentum. Forward-label evaluation starts after max(scan, decision, physical capture) and uses that clock for its horizon, preventing pre-capture path contamination. These are observational repairs, not V2 order changes.

## Stage V3.1: isolated permission research

V3 native trend direction permission is BUY only in BULL_TREND and SELL only in BEAR_TREND. BULL_RANGE is recorded as `V3.1_TREND_REGIME_NOT_PERMITTED`. V2 retains its original permission. `ablations.v31RegimeOnly` records whether an existing V2 trend candidate would be removed; no swing, OB, POC or premium/discount gate is invisibly combined with that observation.

## Stage V3.2: preliminary deterministic research definitions

The provider supplies closed candles. V3 rejects malformed, unsorted, duplicate, forming, gapped or unavailable candle history. Decisions record the current clock separately from scan start. Level/range generation uses the prefix BEFORE the latest closed reaction candle; a level's confirmation-close time must be at or before the reaction's OPEN time. A pivot newly confirmed during the reaction cannot be borrowed by it.

Swing highs/lows use strict width-two fractals, with separate anchor and confirmation times and latest/prior roles. A close beyond the defended boundary invalidates the level; current invalidation is measured independently from wick interaction. Retest counts and last-touch clocks are derived only after level confirmation. History is limited to the provider's current 200-bar window; levels outside that window are unavailable.

OB research borrows the supplied indicator's confirmed swing → closed BOS → POC-touch anchor → zone lifecycle concept. The anchor is the lowest-low/highest-high candle touching the most-touched price bin between swing and BOS, excluding the BOS bar. The OB becomes known at BOS close. Close-based invalidation uses the distal boundary. Rendering, overlap suppression, gap filters and lower-timeframe Pine-specific calculations are deliberately not ported; this is a distinct, versioned research hypothesis.

Volume Profile uses up to 120 preceding closed bars and 30 rows. Each candle's volume is distributed uniformly over intersecting bins, conserving total volume. POC is the highest-volume bin midpoint. OB's most-touched anchor search uses 40 bins. This differs from the supplied VP indicator, which assigns full bar volume to each intersected row; the method is explicitly logged. Candle-direction volume is a proxy, never actual taker volume delta. Missing actual delta remains null.

Reaction research records touch, retest, wick rejection and close reclaim. Selection ranks active same-direction/neutral levels by current reaction, distance, recency and stable identity. No reaction observation becomes a trade yet. POC alone supplies no structural invalidation price. Selected invalidation is only a research reference; executable stop and objective remain null.

Premium/discount uses the latest opposite confirmed swing high and low known before the reaction. No rolling future extreme is used. A malformed/nonpositive range is unavailable. Logs contain range high/low, midpoint, confirmation age/source, anchor clocks, candidate closed-price percentile (unclamped), out-of-range status and direction-relative meaning. The middle 48–52 percent is EQUILIBRIUM; below is DISCOUNT and above is PREMIUM. These fixed research bins are not execution gates.

Trend leg count uses the existing EMA21/55-cross directional-pivot research method. No 5–8 rule is applied. Confluence tags include swing+reclaim, OB+reclaim, POC+reclaim and overlapping OB+POC; premium/discount is logged alongside them.

## Data separation and AI

`backend/data/v3-shadow/` contains separate hourly `v2-*`, `v3-*`, and `ai-*` JSONL files with output types V2_SIGNAL, V3_SHADOW_SIGNAL and AI_RESEARCH_CONTEXT. V2 rows are matched observations for meaningful V3 updates; the existing full V2 journal remains the authoritative complete V2 signal stream. Native V2 absence is recorded instead of suppressing V3 observations.

Rows also identify process boot/start and a SHA-256 fingerprint of the V3 implementation, so repaired shadow builds remain attributable. AI agreement uses the providers' actual RETAIN/SKIP/ABSTAIN semantics; abstention is not agreement or disagreement. Total capture errors are retained across deployments; last-scan errors identify current health.

The separate V3 Analysis tab downloads each channel independently. The server pipelines files at fixed byte watermarks with backpressure; it never reads a full archive into memory for an export. Existing data download panels remain intact.

AI providers keep their original context and request logic. V3 incrementally observes completed outputs from existing ledgers, logging timestamp, provider, model, original output and available exact-candidate V2 agreement. Local abstains retain their status. V3 agreement remains null with an explicit reason while executable geometry is unavailable. Outputs do not feed V3 decisions. Decision rows mark AI context unavailable at their decision clock; later AI records must be joined as later annotations, never backfilled as known-at-decision predictors. Only current/birth native candidate links are kept; unmatched outputs retain null agreement. No additional AI requests are made by V3.

## Memory, persistence and rollback

V3 retains at most 512 compact episode keys, 24 UI summaries and 64 KiB per record. Candle arrays are used temporarily and never copied into persistent state. Boot restores only a checkpoint under 1 MiB, never the full archive. AI reads at most 64 KiB per provider per scan. Checkpoints are atomic; hourly files retain 96 hours and prune only recognized V3-owned filenames. Existing Docker heap limit stays unchanged.

Graceful restart preserves episode birth clocks. A crash between row append and scan checkpoint can replay a row after restart; downstream analysis should deduplicate candidate IDs and inspect boot/capture clocks. A future tranche should add crash recovery beyond the checkpoint without loading archives. Disk-full errors fail open for V2 and increment V3 capture errors. Synthetic memory checks do not guarantee combined production RSS; watch multiple scans and a download under Northflank's 512 MB limit.

Set `ORAYAN_V3_SHADOW_ENABLED=false` to stop V3 observations while leaving V2 running. Or redeploy the frozen V2 tag / prior `bc962b7` image. Keep the persistent volume and all settings. Never enable V3 execution: no execution route exists in this tranche.

## Next tranche

Review these level/reaction definitions against prospective captures, then implement V3.2 candidate state and V3.3 independent invalidation/objective geometry, executable tick rounding, fee/slippage assumptions, clearly versioned rejection rules and candidate-update outcome labels. Prospective forward labels must attach to each decision update, not borrow birth outcomes. Add richer MI and exact-candidate AI disagreement context without giving AI execution authority. Do not infer structural-engine performance from existing 60-minute birth labels or the small eight-short retrospective pocket.
