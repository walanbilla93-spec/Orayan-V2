# Groq shadow production runbook

This experiment is prospective and research-only. It observes the same immutable New Orayan
`candidate_birth` event already written by the compact research journal. Its return value is not
available to gates, sizing, ranking, order placement, Marci, or the executor.

## Northflank environment

Set the API key as a Northflank secret. The remaining values may be ordinary environment values:

```text
GROQ_API_KEY=<secret>
GROQ_SHADOW_MODEL=openai/gpt-oss-120b
GROQ_SHADOW_ALLOW_LIVE=true
GROQ_SHADOW_LEDGER=/app/backend/data/groq-shadow/decisions.jsonl
GROQ_SHADOW_TIMEOUT_MS=15000
GROQ_SHADOW_MAX_OUTPUT_TOKENS=220
GROQ_SHADOW_MAX_REQUESTS_DAY=700
GROQ_SHADOW_MAX_TOKENS_DAY=150000
GROQ_SHADOW_MAX_REQUESTS_MINUTE=20
GROQ_SHADOW_MAX_TOKENS_MINUTE=6000
GROQ_SHADOW_MAX_QUEUE=32
```

`GROQ_SHADOW_SNAPSHOT_LOG` is optional. Its safe default is
`/app/backend/data/groq-shadow/candidate-snapshots.jsonl`. Both paths are constrained to the
backend persistent data root. Parent directories are created on the first candidate append, so no
manual `mkdir` or `touch` is required. A GET request never creates either file.

After the tested change is deployed, `GROQ_SHADOW_ALLOW_LIVE=true` is safe for this shadow-only
experiment: processing is a bounded one-worker queue, has no retries, and every failure is caught
outside the trading path. This statement does not authorize changing any trading or risk setting.

## Runtime verification

Run these inside the deployed container:

```sh
env | grep -E '^GROQ_SHADOW_(MODEL|ALLOW_LIVE|LEDGER|TIMEOUT_MS|MAX_OUTPUT_TOKENS|MAX_REQUESTS_DAY|MAX_TOKENS_DAY|MAX_REQUESTS_MINUTE|MAX_TOKENS_MINUTE|MAX_QUEUE)='
```

```sh
wc -l /app/backend/data/groq-shadow/candidate-snapshots.jsonl && tail -n 1 /app/backend/data/groq-shadow/candidate-snapshots.jsonl
```

```sh
wc -l /app/backend/data/groq-shadow/decisions.jsonl
```

```sh
tail -n 3 /app/backend/data/groq-shadow/decisions.jsonl
```

```sh
curl -sS https://p01--min-service--2c624d5p4kgs.code.run/api/journal/research/groq-shadow && printf '\n'; curl -sS -D - -o /dev/null https://p01--min-service--2c624d5p4kgs.code.run/api/journal/research/groq-shadow/export
```

Before the first birth, missing files are expected. With live mode off, the snapshot audit grows
but no Groq request is made. With live mode on, a causally complete eligible snapshot also creates
`REQUEST_STARTED` and `SHADOW_DECISION` ledger rows. Missing/stale evidence creates a local
`ABSTAIN` without consuming Groq budget.

## Frontend result

The default Dashboard always shows **Groq Shadow Research** with enabled/disabled state, model,
snapshot-audit availability, decision-ledger availability, sizes, and update times. **Download
Groq Shadow Data** remains visible but disabled with `No Groq decisions yet` until the first ledger
record exists. Once available it downloads the append-only NDJSON stream in one click.

The server sends static assets with `Cache-Control: no-store`; versioned asset URLs are also used
for this release. A normal Northflank rebuild from the target commit is sufficient—there is no
separate frontend build step.
