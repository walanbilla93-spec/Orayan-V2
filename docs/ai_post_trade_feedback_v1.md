# AI_POST_TRADE_FEEDBACK_V1

Generated only for a CLOSED native PAPER trade, after the existing canonical
outcome append. Not generated for live trades or Marci simulations. Immutable
record id derives from contract/trade/close/epoch. Repeated close observation
returns the first durable record. Separate namespace never rewrites native
trades or history.

Fields: contract, feedback_id, available_at, resolved_at, identity (source
epoch/opportunity/cohort/shared hash/cutoff) or explicit unavailable linkage;
original Meta/Meta-Lite/Qwen/Groq decisions/statuses; native admission, fill,
close, realized R, net P&L, fees and funding availability; available MFE/MAE,
path precision and ordering caveats; deterministic lesson category.

Native outcome is authoritative. The first terminal provider response observed
for that shared cohort/hash is included if present when feedback is created.
Later/retry responses remain in the canonical AI ledger; they do not rewrite
feedback. Missing or late responses are UNAVAILABLE. Birth model inference uses
no asynchronous provider verdict. Native order-created admission does not
claim a signal was valid. Fee availability does not imply complete costs.

Categories: POSITIVE_NET_R / NEGATIVE_NET_R / FLAT_NET_R /
OUTCOME_UNAVAILABLE. They describe the recorded result only. False signal
taxonomy is AMBIGUOUS_UNSUPPORTED with NO_VALIDATED_CAUSAL_PATH_ORDERING.
Bad entry/immediate false signal, no follow-through, valid signal failed later,
and successful signal cannot be asserted from the available OHLC bounds. Do
not infer these from a win/loss or MFE alone. Early path is UNAVAILABLE,
intrabar order UNKNOWN and terminal minute may contain post-exit extrema.

Records with unavailable birth linkage do not enter reflection memory.
No historical backfill/acquisition runs automatically. No completeness claim
across disabled periods, capacity failures or the canonical/optional-write gap.
Export via protected /api/meta-brain/export; retain original canonical capture.
