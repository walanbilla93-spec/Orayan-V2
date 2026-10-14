# Meta-Lite V1: frozen birth-packet shadow comparator

This is a new deterministic experiment, not the original Meta Brain evaluator.
No output has execution authority or learning influence. No weights adapt.

## Architecture

The canonical `researchCapture.birth` hook builds the existing shared packet once,
before its existing native birth append. `metaLite.evaluate` makes a strict scalar
projection and returns one result. `minimalCapture.native` embeds `meta_lite` in
that same canonical `decisions` row. Both existing provider handoffs reuse the
same immutable shared packet afterward. No extra append/fsync, retained state,
history, cache, queue, timer, worker, fetch, subscription or provider call is added.
The result is deliberately excluded from cached native snapshots and subsequent
admission records. The native capture key and journal supply atomicity and replay
deduplication within the existing retained epoch; no old/pruned birth is backfilled.

## Exact input allowlist

Paths relative to the existing packet's `snapshot`:

- `candidate_birth_at_utc`
- `side`
- `planned_trade.entry`, `planned_trade.sl`, `planned_trade.tp`
- `planned_trade.quote_evidence.bid`, `.ask`, `.observed_at_utc`, `.available_to_system_at_utc`
- `regime.label`, `regime.observed_at_utc`, `regime.available_to_system_at_utc`

Identity references come only from `packet.identity`: `cohort_id`,
`shared_context_hash`, `opportunity_id`, `source_epoch`, `birth_cutoff`.
These label the result and do not score it. The common hash may cover more
evidence than Meta-Lite reads; the persisted `input` records its exact projection.
No verdict, admission, gate result, outcome, score, reason/risk flags, H1/H2
decision, market intelligence, or unlisted field enters the policy.

Every required number must be finite and every required clock valid. Observation
and receipt must both be <= cutoff, and observation <= receipt. Quote maximum age
is 15 seconds, regime maximum age is 20 minutes, measured at original birth.
Required missing, future, invalid or stale sources produce `INPUT_UNAVAILABLE`
with `ABSTAIN`, confidence zero and no persisted input values. No source is fetched.
Invalid side-correct geometry or quote prices produce `OK_ABSTAIN`.
Only the five existing labels BULL_TREND, BEAR_TREND, BULL_RANGE, BEAR_RANGE and
CHOP are accepted; an unknown label is unavailable.

## Prespecified V1 policy

Use side-correct price risk and reward. `SKIP` if any of:

1. reward / risk < 1.5;
2. (ask - bid) / risk >= 0.10;
3. BUY with BEAR_TREND, or SELL with BULL_TREND.

Otherwise `RETAIN`: no risk condition in this small contract justifies a shadow
skip. This is not a claim that the candidate is profitable or fully admissible.
Fixed confidence is 0.65 for SKIP and 0.55 for RETAIN, explicitly marked
`UNCALIBRATED_FIXED_V1`; it is not a probability of profit. ABSTAIN confidence is 0.
Thresholds are research hypotheses, not fitted or validated trading recommendations.

Statuses: `OK_RETAIN`, `OK_SKIP`, `OK_ABSTAIN`, `INPUT_UNAVAILABLE`,
`CENSORED_OPERATIONAL`. A shared builder failure has a reconstructible cohort but
null context hash; an evaluator exception preserves packet identity and records
`CENSORED_OPERATIONAL`. Capture failure remains authoritative capture loss; it
cannot truthfully persist a successful comparator status. Operationally lost
births must be treated as censored during analysis, never fabricated decisions.

Bounded reason enum: EVIDENCE_ACCEPTABLE, LOW_REWARD_RISK,
SPREAD_STOP_FRACTION, OPPOSING_REGIME, INPUT_MISSING, SOURCE_NOT_CAUSAL,
SOURCE_STALE, INVALID_GEOMETRY, UNKNOWN_REGIME, SHARED_PACKET_UNAVAILABLE,
EVALUATOR_ERROR. At most three scoring reasons, or one abstention reason.

## Pairing and outcomes

The birth's native admission (`ELIGIBLE`/`REJECTED`) is a gate state, not a
Meta-Lite RETAIN/SKIP decision and not proof of trading. Group observations by
`source_epoch` + `opportunity_id`; join provider ledgers by cohort/hash. Require
matching identity/hash before considering a shared-evidence comparison.

Find actual native PAPER trades through existing lifecycle records sharing the
source episode, then distinct trade ID. Orayan-traded means an actual fill, not
an order intent or gate pass. Report filled + Meta-Lite RETAIN, filled + SKIP,
and ABSTAIN/unavailable/censored separately. Native realized outcomes are usable
only when a genuine filled PAPER trade has a complete closed endpoint. Pending,
rejected, cancelled, expired and unfilled candidates have no inferred profit.
Existing registered forward experiments retain their own labels and must not be
silently used as native results. Multiple native trades retain separate trade IDs;
cohort analysis must disclose its denominator rather than declaring a winner.

## Resource budget established before implementation

Expected: O(1), fewer than 100 scalar checks/arithmetic operations plus bounded
date parses; <= a few KiB temporary working objects; one result; <=4 KiB added
persisted bytes per birth. No new per-birth index or retained payload is introduced.
The existing canonical writer retains its own resource/retention policy. Its
already-existing synchronous append is unchanged in count; only the compact
embedded result increases its byte size. Targeted tests benchmark pure policy,
exercise 100,000 births with forced GC, canonical replay and existing PAPER smoke.
