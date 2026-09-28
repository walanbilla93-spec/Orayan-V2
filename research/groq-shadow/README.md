# New Orayan Groq shadow advisor V1

Research only. This directory is deliberately independent from `backend/lib/engine.js`,
`executor.js`, gates, risk, sizing, SL/TP, Marci, and Gemini. It consumes newline-delimited,
decision-time candidate snapshots produced by an independent join/export path. Nothing here can
enter, skip, size, modify, or close a trade.

## Fair V1 input

The original ten fields remain the compact core. V1 additionally requires only evidence needed
to make them causal and interpretable:

- stable candidate ID and birth timestamp;
- source observation/availability timestamps and ages;
- planned entry, SL, TP, RR, risk, heat, and normalized stop distance;
- decision-time bid/ask/mark evidence (maximum age 15 seconds);
- total open, same-side, and same-side/same-regime exposure;
- frozen H1/H2 state, version, abstain reason, and raw H2 features;
- source status and breadth sample size.

Any key suggesting post-birth outcome, realised P&L, winner/exit/close, or forward/future data is
rejected before an API request. Missing/stale inputs, absent execution evidence, H1/H2 abstention,
or non-OK sources produce a persisted local `ABSTAIN` and consume no Groq budget.

## Commands

Each input line must be one `ORAYAN_GROQ_CANDIDATE_V1` JSON object.

```text
node cli.js --input candidate-snapshots.jsonl --ledger decisions.jsonl --dry-run
node cli.js --input candidate-snapshots.jsonl --ledger decisions.jsonl --mock
```

`--dry-run` builds and prints the exact request without making or recording an API request.
`--mock` exercises persistence and validation without network access.

A real one-shot call has two deliberate locks and must not be used without explicit approval:

```text
GROQ_SHADOW_ALLOW_LIVE=true node cli.js --input one-approved-candidate.jsonl --live
```

## Environment

```text
GROQ_API_KEY=                         # secret-backed only; never written to logs/ledger
GROQ_SHADOW_MODEL=openai/gpt-oss-120b
GROQ_SHADOW_ALLOW_LIVE=false
GROQ_SHADOW_LEDGER=/app/backend/data/groq-shadow/decisions.jsonl
GROQ_SHADOW_SNAPSHOT_LOG=/app/backend/data/groq-shadow/candidate-snapshots.jsonl # optional fixed-root override
GROQ_SHADOW_TIMEOUT_MS=15000
GROQ_SHADOW_MAX_OUTPUT_TOKENS=220
GROQ_SHADOW_MAX_REQUESTS_DAY=700
GROQ_SHADOW_MAX_TOKENS_DAY=150000
GROQ_SHADOW_MAX_REQUESTS_MINUTE=20
GROQ_SHADOW_MAX_TOKENS_MINUTE=6000
GROQ_SHADOW_MAX_QUEUE=32
```

The backend automatically observes the canonical `candidate_birth` row and appends its causal
snapshot to `candidate-snapshots.jsonl`. With live calls disabled the audit still grows, proving
the producer is connected. With live calls enabled, eligible snapshots enter a bounded one-worker
queue. Queue failures and every Groq failure are fail-open and cannot reach trading decisions.

The endpoint is fixed to the official OpenAI-compatible Groq Chat Completions endpoint. There are
no automatic retries. Timeout, 429, 5xx, malformed output, absent key, and budget exhaustion are
persisted as `ABSTAIN` statuses. A `REQUEST_STARTED` row is fsynced before network I/O; after a
restart, its deterministic request ID prevents a silent repeat request.

## Append-only ledger

Records contain schema, model, frozen prompt variant/hash, input snapshot hash, request/completion/
availability timestamps, latency, token usage, status, and the strict decision object. Existing
records are never edited. Exact duplicate request IDs are ignored and reported to the caller.

## Prospective evaluation

Join outcomes only after decisions are immutable and `available_to_system_at_utc` precedes the
candidate outcome. Compare unchanged Orayan, frozen H1, frozen H2, and Groq on the same closed
candidates. Report avoided losses, missed winners, net R/USDT delta, profit factor, maximum
drawdown, coverage, abstention, confidence calibration, latency, tokens, and six-hour/day blocks.
Keep API failures and budget abstentions in denominators. Do not promote from historical replay.

Production deployment and verification commands are in
[`docs/GROQ-SHADOW-RUNBOOK.md`](../../docs/GROQ-SHADOW-RUNBOOK.md).
