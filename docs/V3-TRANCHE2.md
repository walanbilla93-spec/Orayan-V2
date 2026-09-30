# V3.3 structural geometry and would-be outcomes

Continues Tranche 1 on the existing repository and data volume. Policy `V3.3_STRUCTURAL_MARKET_NEXT_MINUTE_V1`, capture version `ORAYAN_V3_TRANCHE2`. V2 remains the frozen benchmark and the only existing execution engine. No shadow output is read by V2. Groq/Alibaba remain observers; their exact linked deterministic V3 decisions can now be compared when available.

## Candidate and geometry policy

Only BUY/BULL_TREND and SELL/BEAR_TREND qualify. Require a completed reclaim or rejection of an active structural level that existed before the reaction candle opened. Choose the nearest qualifying reaction, then recency and stable identity. Quotes must be available at decision time, no older than two minutes, with valid bid/ask; exchange tick and lot information is required. Reaction candles more than two minutes past their normal availability are stale.

Invalidation is independently the defended swing/OB boundary or the more adverse completed reaction extreme, plus one tick outside. A POC reaction requires a separate, previously known defended structural boundary. The objective is the nearest active opposing swing/OB boundary or POC ahead of the entry. Its price rounds toward entry. No fixed 2R target, stop clamping, skipping nearby barriers, nominal max-R clamp or premium/discount gate exists.

Planned entry uses the observed ask/bid plus adverse 3 bps market slippage and adverse tick rounding. Both entry and exit fees use the configured taker fee; stops include configured adverse slippage with executable tick rounding. Targets require the configured trade-through amount. Cost-adjusted RR is net target reward divided by fee/slippage-adjusted stop loss. Reject absent/malformed geometry, nonpositive reward or RR below the configured minimum. Funding is not forecast into planned RR; later settled funding is an outcome feature. Cost/policy inputs and sizing budgets freeze at admission, including across later operator settings changes.

This remains a distinct combined structural hypothesis. The original pivot-only and regime-only ablations are still recorded separately. The logged selected reaction is the one actually used by geometry. Premium/discount is measured at the candidate entry, with the original closed-price location separately retained.

## Fills and lifecycle

Admission records a unique setup ID from version, configuration, symbol, direction, reaction bar and reaction level. Repeated scans do not create another trade for the same setup. Each admission links to its immutable V3 candidate/update; birth and current clocks remain separate. Old Tranche 1 rows are never converted into retrospective trades.

Entry eligibility starts at the first whole minute at or after max(decision, physical capture). A completed 1m candle's opening price plus adverse 3 bps/tick rounding is the simulated market fill; no earlier partial minute or forming bar can fill. At that opening, a conditional market admission rechecks stop/target orientation and net RR. Invalid gaps cancel before entry. Quantity floors to lot step from the cost-adjusted risk budget, notional cap and maximum quantity; never round up to the minimum lot. Below-minimum sizing cancels. This is a precisely defined conditional next-minute fill model, not a historical resting-limit queue simulation.

States: PENDING → OPEN → CLOSED; or EXPIRED/CANCELLED/DATA_GAP. Once filled, use frozen stops, objectives, fee rates and hold limit. Gaps through stops exit at the opening with adverse slip, permitting losses beyond 1R. Gap targets receive only the target limit price after trade-through, with no favorable gap windfall. An intraminute stop/target collision takes the conservative stop result and records ambiguity plus the alternative target P&L. No assumed OHLC path resolves it. Hold timeout exits at the closing price with adverse slip. Expiry means no simulated entry.

Records include fill/exit price and clocks, quantity, gross P&L, separate fees, net before funding, funded model net, R, hold time, excursion metrics and ambiguity. Intraminute exits use a one-minute time bound. Excursions are lower bounds from completed nonterminal bars; terminal-bar extremes after exit cannot honestly be assigned to the trade.

After closure, the worker waits two minutes and queries settled funding rates for the simulated holding interval. Positive funding debits longs and credits shorts; negative rates reverse this. Funding uses entry notional as an explicitly labelled approximation because settlement mark-price history is not captured. Ordering at entry/exit funding boundaries is ambiguous, so only adverse boundary cash flow is applied. Exact intraminute funding cannot be claimed. Net remains null until funding resolves; failures retain the closed state and retry without refilling. Source: [Bybit funding-history contract](https://bybit-exchange.github.io/docs/v5/market/history-fund-rate).

Missing or invalid minute paths become DATA_GAP with no invented exit or net result. Transport failures retain the cursor and retry. Closed funding failures remain visibly pending. These are full modelled lifecycle records where data permits, with explicit censored/unresolved outcomes where it does not. They are independent research trades, not a portfolio-return simulation or executable liquidity guarantee.

## Persistence, bounds and exports

Separate hourly `trades-*` JSONL files have output type `V3_SHADOW_TRADE`, stable event IDs and immutable snapshots/transitions. A fourth V3-tab download streams trades/outcomes through the existing fixed-watermark, backpressure pipeline. Existing V3, matched-V2 and AI downloads remain separate; the research manifest includes trade files.

At most 32 active/funding-pending trades and 32 terminal summaries are retained; admissions beyond capacity explicitly reject. Every 15 seconds a background worker handles up to eight due trades sequentially, at most once per minute per trade. All path/funding requests use the existing research transport queue, yielding to trading traffic. No worker promise is awaited by V2 scanning. It continues tracking after the engine stops; the V3 enabled flag pauses both capture and tracking.

Same-bar quote movement within the same geometry/decision bucket does not duplicate candidate rows. A changed geometry verdict, structural boundary, objective, native V2 decision or completed bar creates a new observation. This keeps quote refreshes from amplifying hourly archive growth while preserving admission and rejection changes.

Each minute response is capped at 1000 bars and released after processing. Downtime catches up in successive bounded chronological windows. No outcome archive is loaded at boot. Admissions and cursor/funding transitions checkpoint atomically; the existing checkpoint cap remains 1 MiB, archive retention 96 hours, record cap 64 KiB and Docker heap 352 MB. Existing settings, provider configuration, volume and plan are preserved.

An abrupt crash between append and checkpoint can replay an event; consumers must deduplicate stable trade event IDs. Checkpoints preserve active trades and prevent repeated fills during graceful redeploy. This tranche does not claim filesystem transactions or exactly-once durability through disk corruption.

## Validation and rollback

The full existing plus V3.3 suite passes 102 tests: geometry, nearest-objective rejection, costs, causal entry eligibility, instrument constraints, gap guards/exits, trade-through, collisions, timeout/expiry, funding signs/boundaries, missing paths, duplicate batches, setup deduplication/capacity, pending/closed restart, request and disk failures, and frozen V2/AI parity. Frontend syntax checks pass. Deployment checks separately verify settings preservation, version, health and export behavior; short memory checks do not establish sustained OOM immunity or profitability.

Rollback by selecting `feature/orayan-v3-shadow-tranche1` at commit `ad69470` in Northflank, preserving the volume/settings. The old observer ignores trade files and its checkpoint reader ignores extra fields. Preserve the V3.3 checkpoint separately before rolling back if later recovery of active model trades is required; the old writer does not retain their fields. Alternatively set `ORAYAN_V3_SHADOW_ENABLED=false` to pause both observations and lifecycle advancement without changing V2.
