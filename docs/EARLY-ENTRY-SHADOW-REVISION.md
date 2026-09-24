# EARLY_ENTRY_SHADOW_V1: revised prospective research cohort

The export schema remains `EARLY_ENTRY_SHADOW_V1` for existing download compatibility.
New rows carry `hypothesisId=RETRACE_CONTEXT_PRIOR_BREADTH_192_BOS_CHOCH_V1`;
this identifier is also part of each experiment ID. Do not pool these rows with
earlier V1 assessments. The cohort is a new prospective research question, **not**
an implementation or equivalent of Old Orayan's Direction Brain.

## Fixed birth-time rules

- Context: use the already computed `RETRACE_STATE_SHADOW_V1` state on the
  candidate birth link. The three separate cohorts are `DETERIORATING`,
  `HEALTHY_PULLBACK`, and `STRONG_CONTINUATION`. An insufficient or absent
  state is `NOT_AVAILABLE`. No later order flow or forward label is used.
- Breadth: rank the current `marketSnapshot.directionalBreadth` against at most
  192 **earlier** snapshots with the same timeframe and configuration hash.
  Require at least 24 earlier snapshots and at least 80% universe coverage on
  current and historical observations. The predeclared zone is percentile >=85.
  Warmup and poor coverage are unavailable, not silently converted to a value.
- Structure: for STRUCTURE candidates use the signal's native BOS/CHOCH event.
  For TREND candidates independently run the existing causal detector on the
  closed candles available at birth and require an event in the candidate's
  direction. `TREND_PULLBACK` is only a strategy pattern and is never called BOS.
  TRAP and DIVERGENCE have no confirmed birth-time detector in this repo.
- Keep native birth episode, BUY side, bullish BTC permission, and passed
  strategy gates. Both arms are created only after every field passes and the
  first research-observed bid/ask response arrives within 60 seconds. Bybit
  does not provide the quote tick timestamp here, so this is not claimed to
  be the first exchange quote after decision.

The comparison freezes stop, target, settings, risk basis and hold rules.
The early arm pays taker entry and observed spread; the control uses its
existing pullback entry and maker fee assumption. One-minute OHLC cannot order
events inside the decision or fill minute: the control cannot fill in the
partial decision minute, and a fill-bar target/stop overlap is marked
`ENTRY_BAR_AMBIGUOUS` with no claimed net R. Missing 1-minute bars produce
an incomplete record.

This research sidecar returns no value to signal generation, gates, ranking,
sizing, portfolio controls, or order placement.
