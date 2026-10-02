# V3.4B capture repair and preregistered prospective holdout

This tranche promotes **no production behavioral trading rule**. V2 benchmark
`d7f2ba802a4b4204fad70bf502c6f996f76aabc4`, its settings/executor/gates/risk,
and the V3.3 evaluator/geometry/outcome core are frozen. V3 cannot execute.
Groq, Alibaba, MI and all context tags remain observers. Alibaba paid/live
behavior remains disabled. Main is left unmerged.

Evidence basis: `Orayan_V3_4A_comprehensive_analysis.md`, its trade/episode,
hourly storage/raw-byte audits, and the verification manifest. The exploratory
sample has 31 closes/24 closed episodes; repeats contributed approximately
-8.01R and five <1ATR fills lost. These motivate research arms, not rules.
Budget-skipped historical identities/bytes cannot be recovered or inferred.

## Capture and reconstruction

Target envelope: 3,407,872 compressed bytes/hour (3.25 MiB), 134,217,728 bytes
(128 MiB) rolling soft cap. Whole UTC hours protect at least 30 hours, including
the partial boundary hour. Standard writes stop before a 20% reserve is consumed.
Priority batches include births/admissions, matched V2 for those admissions,
fills/closes/cancels, funding finalization, paths, arm measurements and errors.
Priority never fails because standard traffic consumed the quota. It can exceed
the soft envelope/cap; overflow is reported and disqualifies clean capture. Disk
failure is still physically possible and is counted, not hidden.

`capture-ledger/` is outside that quota. UTC-hour/channel/type/priority counters
persist attempted, accepted and skipped rows and complete offered UTF-8 JSON
bytes including newline. These are logical offered-byte counters, distinct
from physical gzip block bytes. Lifetime journal counts predate the exact ledger
and remain separately labeled. Pre-hotfix attempted denominators are unknown.
Redo intents converge staged files and accepted counters after a crash;
interrupted uncommitted offers become explicit skips. Definitions are physical
rows, distinct from logical records and unique trades/episodes.

New rows use `V3_LOSSLESS_REFERENCES_V2`. `v34bCodec.decode()` reconstructs the
complete captured JSON from immutable SHA-256 references; arrays/long strings
are fragmented losslessly. Numeric precision and all births/lifecycle/path
fields remain exact. No sampling or lossy delta coding is enabled. Repeated
surfaces retain individual clocks and exposureCount=1 while frozen control
dedupe remains intact. Hour/channel references are self-contained; legacy V1
rows remain in their original representation and schema.

`GET /api/v3/cohort` freezes all seven channels synchronously under one generation,
watermark and per-channel cursor. It returns immutable dashboard state plus
physical/logical/definition retained counts. Pass its generation to each export
and the summary; each gzip starts with the shared manifest. Sessions last ten
minutes and are bounded to three. Expired generations return 410; freeze again.

Completed UTC days are immutable hard-linked gzip blocks with hashes/manifests
under `daily-snapshots/`, outside rolling quota on the existing 6 GB volume.
Download `/api/v3/daily?day=YYYY-MM-DD`. The first day can be partial. Snapshot
files persist; growth is roughly 0.78 GiB/10 days at the full hourly envelope,
plus exploratory evidence. They require eventual disk monitoring/archival.

Quotes alongside historical next-minute-open fills are cached pre-fill quotes
with age/missing reason; `fillBidAskAvailable` never claims synchronized exact
fill bid/ask. Error taxonomy separates timeout/abort/rate-limit/oversize/storage/
unavailable/invalid/unknown, with IDs, retry cursor, first/last occurrence and
recovery status. Raw messages, URLs, headers and credentials are not exported.

## Preregistered paired arms

Episode identity/reset stays the frozen journal definition: config + symbol +
side, reset after >30 minutes without an observed surface. Cancellation/no-fill
does not reset an episode. Control does not read any arm output. Surviving arm
workers use separate storage/capacity and cannot occupy a control slot.

* FIRST_ADMISSION_ONLY consumes the first eligible control admission, including
  cancellation/no-fill; later admissions are suppressed until episode reset.
* FIRST_FILLED_ONLY permits later admissions until the first actual control fill
  has been physically processed; later opportunities are suppressed thereafter.
* ATR1M_BUFFER requires exact causal decision ATR SMA TR14 and control stop <1ATR.
  Use the more adverse of the structural boundary and one ATR from the executable
  fill, fixed causal ATR, original objective, and the same cost-RR threshold at
  admission and next open. Quantity targets control planned cash risk with
  downward lot rounding; recorded risk shortfall is never hidden. Geometry
  failures are REJECTED_BY_BUFFER_GEOMETRY with zero opportunity return.
  STRUCTURE_RELAXED marks any extension beyond structural invalidation.
* RECEIPT_DEFENDED_TRAILING stays dormant until the first 30 consecutive complete
  UTC hours with zero priority skips and complete defended receipt coverage.
  Receipt pulses require coverage near both hour boundaries and no >120s gap;
  missing/failed receipt/path coverage or priority overflow breaks the streak.
  Once achieved, only new admissions enroll; existing dormant fills stay dormant.
  Move after a new active same-side defended boundary is confirmed and physically
  received after fill. Act at the first complete minute open at/after receipt,
  one adverse tick offset, favorable moves only. Never widen. No partials or BE.

All arms use the frozen fees/slippage/tick/quantity/gap/stop-first ambiguity and
funding boundary model. Funding is entry-notional approximation, not exact
mark-notional funding. A fetched window must cover each arm's own close. A buffer
may outlive control and continues receiving complete minute paths. Missing path
or funding remains censored/unresolved; it is never fabricated as zero return.

## Holdout and review

Start a new labeled holdout at the first successful post-validation capture scan,
freeze control/config fingerprints and preregistration metadata, and preserve
exploratory evidence. The capture validation attestation gates start. The trailing
arm separately waits for its observed 30-hour qualification.

Primary milestone: 100 additional unique filled episodes; prefer >=10 days,
>=30 symbols, no symbol >20%. If naturally available, >=20 shorts and >=20
non-BULL_TREND episodes; otherwise conclusions stay scoped. All admissions must
resolve or be explicitly censored. Re-entry minimum: 30 repeat-eligible episodes.
ATR: 20 causally evaluable sub-1ATR filled episodes. Trailing: 30 eligible episodes
and 10 control winners with valid received defended sequences. High-RR tags:
aim for 30 fill cost-RR >=5 episodes with winners and losers before any gate.

Primary paired endpoint: cost/funding-adjusted NET CASH per eligible admission at
equal planned cash risk; rejected/suppressed/no-fill opportunities return zero.
Secondary review uses episode-normalized R, fill/target/immediate-stop rates,
retained upside, winner damage and opportunity loss. UI statistics are descriptive
monitoring, not inference or promotion. Episode/day clustering, leave-best-symbol
checks and scope/diversity review remain analysis work after collection.

## Validation

See `V34B_STORAGE_VALIDATION.json` and the deployment attestation for exact replay,
memory/capacity and full-suite results. All 88,382 available serialized source
rows reconstruct exactly. This does not restore historical skipped records or
remove V3.4A's prior rounding. The stress test fills 33 UTC-hour envelopes, retains
31 hours near 98.3 MiB, verifies restart equality and zero priority skips under
the deployment's 352 MiB V8 heap setting. Live Northflank metrics are verified
separately after deployment; a synthetic test is not a ten-day live holdout.
