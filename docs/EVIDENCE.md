# Evidence behind the defaults

Why each default is what it is, and how much weight it can carry. Confidence is stated per claim
so nothing here gets mistaken for more than it is.

---

## Cost floor drives timeframe choice

**Default: 15-minute signal timeframe.**

At roughly 0.115% round-trip cost, a 1-minute strategy needs about a 71% win rate merely to break
even. 15-minute was the shortest timeframe where the required win rate (~37%) is realistically
achievable. `[Certain]` — this is arithmetic, not a backtest result.

This is also why `COST_FLOOR` exists as a gate: on short timeframes, fees decide profitability
more often than the signal does.

---

## Entry geometry: never chase

**Default: `chaseMissedMove = false`.**

In the previous system a structural contradiction between the pullback threshold and the
missed-move threshold meant 99.1% of signals (463 of 464) filled via the chase path. Planned
reward:risk of 2.46 collapsed to 0.73 at actual fill. `[Certain]` — measured directly on the
signal ledger.

The setting exists so the behaviour can be measured rather than assumed, but it should stay off.

---

## SCORE_BAND

**Default: on, 40 ≤ score < 80.**

Strongest single gate everywhere it was tested. In a fresh 189-pair replay it was the only solo
gate that flipped a losing population positive (mean R −0.147 → +0.037, win rate 41.5% → 52.4%,
n=808). On the real Bybit execution ledger it removed the worst 16 trades (25.0% win rate).
`[Likely]`

The ceiling matters as much as the floor. Very high scores marked exhaustion, not conviction —
the earlier system measured 0 wins from 7 trades above 80.

**Caveat that matters:** this was validated against a *different* signal generator. The scoring
function in this repo is new code. The band is a reasonable starting point, not a transferred
result. `[Guessing]` on whether 40/80 are still the right numbers here.

**Update 2026-08-30 — RETRACTED and replaced. Read this whole block.**

An earlier revision of this file claimed the score was confirmed dead on this generator, citing
that winners averaged 72.0 and losers 72.2 on the live ledger. **That conclusion was wrong and
the test was invalid.**

SCORE_BAND's finding is that score is **U-shaped**. A U-shape has the same mean on both sides by
construction, so a mean comparison cannot detect it — the identical blind spot that made the old
linear test read r≈0 and produced the mistaken "score is dead weight" rule in the first place.
The correct test is by BUCKET, and it always was. `[Certain]` — this is a property of the
statistic, not an empirical claim.

**The band was never actually tested here.** All 19 closed trades scored between 66 and 78. Zero
observations below 40, zero above 80. The gate rejected 135 of 20,000 signals (0.7%). It had
nothing to act on.

**Root cause: the additive score had almost no variance.** Measured across 20,000 signals:

| Component | Observed | Problem |
|---|---|---|
| `rrPts` | 15 on 100% | RR fixed at targetR by construction — a constant |
| `trendPts` | 22 on 94.9% | `Math.max(trendPts, 22)` pinned it to the floor |
| `momentumPts` | 3 distinct values | coarse |
| `pullbackPts` | **not exported** | the one component that varied had no journal column |

37 points of every score were constant. Only two components moved, one of them unmeasurable.
`[Certain]` — counted directly from the journal.

**Fix: the score was rebuilt on the original multiplicative BASE-50 architecture** (see
`signals_trend.js`). This matters structurally, not cosmetically. A U-shape is what multiplicative
stacking produces and additive points cannot: reaching 80+ requires every factor near maximum
simultaneously, which is a fully-extended euphoric setup — the 0W/7L end. An additive sum
reaching 80 only says "several things were somewhat good", a different statement entirely.

Factor-space sweep of the rebuilt score: range 10-97, with **<40 / 40-80 / 80+ all populated**,
80+ at 5.4% against the 4.2% (7 of 167) the old system actually observed. The band has something
to act on again.

**Because the scale is restored, 40/80 are restored too** — they are the original validated
numbers on the architecture they were validated against, not re-fitted ones. Every score factor
now has a journal column, so this is measurable from the first scan.

**Status: `[Likely]`, not `[Certain]`.** Same generator architecture, different signal source.
Pre-registered re-validation below.

### Pre-registered test — lock before looking

Criteria fixed 2026-08-30, before any post-rebuild data exists:

1. **Bucket, never mean or correlation.** Report WR and mean R for `<40`, `40-80`, `80+`.
2. **Minimum sample:** n ≥ 150 resolved trades, with n ≥ 15 in each outer bucket. Below that,
   report and do not conclude.
3. **Pass:** the `40-80` bucket beats the pooled outer buckets by ≥ 10pp WR *and* mean R,
   with within-day stratified permutation p < 0.05.
4. **Robustness:** must survive top-5-pair removal, and hold in ≥ 5 of 7 day-partitions
   (leave-one-day-out), matching the original's 6/6.
5. **Plateau:** sweep floors 30-50 and ceilings 70-90. A result that only works at one exact
   pair of numbers is a fitted knife-edge and is rejected regardless of significance.
6. **If it fails:** the band comes out. Do not re-tune the numbers against the data that
   failed it — that is the post-hoc fitting this project has rejected throughout.

## TURNOVER_GATE

**Default: on, 3,000,000 USDT / 24h.**

The clearest finding in the whole investigation. Across three consecutive real weeks, live win
rate fell 43.8% → 33.8% → 16.7% while median traded-symbol turnover fell $29.1M → $11.5M → $7.5M,
in lockstep. BTC was calm throughout, so this was not the market turning — the bot's own universe
drifted into progressively thinner coins as it expanded. Week 2 alone traded 51 symbols, 73% of
which were untouched in week 1. `[Certain]` that the correlation is real and the universe drift
happened.

Combined with SCORE_BAND in the fresh replay: mean R +0.111, win rate 56.3%, n=437 — the best
combination found. `[Likely]`

Threshold swept at $3M / $4M / $5M / $6M / $8M; $3M won. `[Guessing]` on the exact number.

---

## VOLUME_GATE — off

Failed four independent tests:

| Test | Result |
|---|---|
| Original backtest | ranked well, second most load-bearing |
| Paper ledger cross-check | win rate 59.6% → 50.0%, avg P&L fell |
| Real Bybit execution ledger | 40.0% vs 39.3% baseline — no effect, 80% of volume cut |
| Fresh 189-pair replay | mean R −0.173 vs −0.147 baseline — actively worse |

`[Certain]` it does not belong on by default. The only test that liked it was the one that
proposed it.

---

## FUNDING_GATE — off, unresolved

The single best gate on the real Bybit execution ledger: survivors 44.0% win rate and +$0.50 total
versus a −$2.24 baseline, and the trades it excluded were genuinely bad (28.9% win rate). Combined
with TURNOVER_GATE it flipped the whole eligible subset positive (n=78, 46.2%, +$1.52).

But in a fresh backtest over nearly the same weeks it was a **complete no-op** (mean R −0.155 vs
−0.147 baseline).

No clean explanation. Candidates: funding data mismatch between live snapshot and historical
reconstruction; or 165 real trades simply being too few to separate signal from noise. `[Guessing]`

Left off and clearly labelled rather than resolved by picking whichever answer sounded better.

---

## DEAD_HOUR — not implemented

An earlier study identified LK 01:00–04:00 as the worst contiguous 3-hour block and added it as a
gate. On the real execution ledger the trades it would have blocked were the **best** group in the
dataset (55.6% win rate, +$0.17/trade average, versus a losing baseline).

n=9. Too small to conclude either way, and pointing the opposite direction to the backtest that
motivated it. Not carried into this build. `[Guessing]`

---

## Thin/anomalous pairs manufacture apparent edge

A recurring failure pattern: removing the top-5 contributing pairs consistently collapsed or
inverted results. Pair-concentration robustness is a mandatory check on any future gate, not an
optional one. `[Certain]` as a methodological rule.

---

## Accounting bugs that produced fake profit

Each of these was found in a running system, and each inflated results until fixed:

- P&L booked on planned rather than actual fill price — a $115.75 paper-vs-live gap.
- 97% of paper trades never reachable on the exchange, yet counted in headline P&L.
- Take-profit counted as a win on a bare wick touch.
- Breakeven exits booking phantom profit — 46% of reported net.

All four are structurally prevented here (see `executor.js`). `[Certain]`

---

## What has NOT been done

Be honest about the gap between "promising" and "validated":

- The signal engine in this repo has **never been backtested**. It is new code.
- No multi-month walk-forward validation.
- No Monte Carlo on the equity curve.
- No pair-concentration robustness check on this implementation.
- No live order placement testing — the live path is written carefully but has not executed a
  real order.
- Gate thresholds were tuned against a different signal generator and may not transfer.

The prior project's own hardest-won lesson: nearly every hypothesis that showed broad support
collapsed on temporal stability testing. Assume that applies here until proven otherwise.
