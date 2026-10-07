# Frozen order-flow v1 contract

Universe is BTCUSDT, ETHUSDT, SOLUSDT, Bybit linear USDT perpetuals. No symbol selection by subsequent outcomes. Public-only endpoint constants are immutable in this version.

Raw publicTrade messages retain all original decimal strings, taker S (Buy/Sell), i (trade ID), T (exchange fill ms), seq, and original batch. Envelopes add original local receipt milliseconds, monotonic ns, connection ID, cohort, payload hash, clock offset estimate and uncertainty. Duplicate IDs are retained in raw audit but deduplicated in derived sums with a bounded 200,000-ID per-symbol cache. Current publicTrade seq can repeat across batches and is not guaranteed contiguous. Regression triggers a recorded gap and resubscription; no fictitious seq+1 test.

Receipt windows are half-open [decision_ms-window_ms, decision_ms). Windows are emitted approximately each 1, 5 and 60 seconds, anchored at the actual decision receipt clock. No late data revises a published row. Buy/sell volume=sum(v) by taker side; delta=buy-sell. Session CVD is exact Decimal signed quantity since the current websocket connection anchor. Rolling CVD delta equals each trailing window's delta. Reconnect resets CVD with a new anchor and gap record; a disconnected interval is never represented as zero flow. Exchange completeness remains explicitly unproven; transport continuity alone cannot prove Bybit published every trade.

Depth 50 is reconstructed in memory from authoritative snapshots and deltas (zero size removes a level). New snapshot/u=1 resets state. Out-of-order u/seq, crossed book, malformed frames or transport loss invalidate book and reconnect for a new snapshot. Neither cross seq nor u is assumed consecutive at depth 50. Top 50 levels and summaries are sampled once per second, not every redundant delta. Raw trades are lossless within the received stream; raw book deltas are intentionally not retained. Sampled book storage cannot reconstruct every cancellation. RPI orders are excluded by the exchange.

Best-level imbalance=(best_bid_qty-best_ask_qty)/(best_bid_qty+best_ask_qty). Depth imbalance=(bid_band_qty-ask_band_qty)/(bid_band_qty+ask_band_qty), at fixed 5/10/25 bps from contemporaneous mid=(best_bid+best_ask)/2. Band totals reflect available top 50, with depth_truncated=true. Book is null/stale after 10s. Largest displayed wall is the sampled maximum size level; sampled age is elapsed receipt time while its side+price stays the sampled maximum. Depth-change proxy is current sampled total minus prior sampled total. These are sampled persistence/change proxies, not verified cancellations.

Absorption proxy=(buy_qty+sell_qty)/max(abs(last_trade_price/first_trade_price-1)*10000,0.1), over the same receipt window, unavailable with fewer than two trades. Units: base quantity per bps. It is neither true hidden liquidity nor proof of absorption. No directional model consumes any flow column. Base+Flow model is unconfigured for later preregistered research; all base rows say flow_used_by_base=false.

Public allLiquidation is stored separately, original position side S and bankruptcy price p preserved. Buy means a liquidated long position, not an aggressor buy. No message does not establish zero liquidations; completeness is not proven. No provider purchase.

Sources verified 2026-10-07 Asia/Colombo:
- https://bybit-exchange.github.io/docs/v5/websocket/public/trade
- https://bybit-exchange.github.io/docs/v5/websocket/public/orderbook
- https://bybit-exchange.github.io/docs/v5/websocket/public/all-liquidation
- https://bybit-exchange.github.io/docs/v5/websocket/public/kline
