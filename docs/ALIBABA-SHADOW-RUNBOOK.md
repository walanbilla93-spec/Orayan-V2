# Alibaba shadow runbook

This is a new prospective, append-only experiment. It has no trading authority and does not alter
H1, H2, Groq history, Marci, Gemini Market Intelligence, or any execution behavior.

## 1. Account and region

1. Complete the Alibaba Cloud account profile and activate Model Studio in **Singapore**.
2. Confirm `qwen3.7-flash` is available and inspect the account's actual quota/expiry.
3. Enable **Free Quota Only** during initial validation if the console offers it.
4. Create a general pay-as-you-go Singapore API key. Do not use Token Plan/Coding Plan keys.
5. Prefer a workspace-specific Singapore base URL for production; the shared international URL is
   the reviewed default.

## 2. Dark-deploy environment

```text
ALIBABA_SHADOW_ALLOW_LIVE=false
ALIBABA_API_KEY=<secret>
ALIBABA_SHADOW_MODEL=qwen3.7-flash
ALIBABA_SHADOW_BASE_URL=https://ws-8fj48454cwchxwq2.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1
ALIBABA_SHADOW_LEDGER=/app/backend/data/alibaba-shadow/decisions.jsonl
ALIBABA_SHADOW_SNAPSHOTS=/app/backend/data/alibaba-shadow/candidate-snapshots.jsonl
ALIBABA_SHADOW_TIMEOUT_MS=20000
ALIBABA_SHADOW_MAX_OUTPUT_TOKENS=600
ALIBABA_SHADOW_BUDGET_COMPLETION_TOKENS=450
ALIBABA_SHADOW_MAX_REQUESTS_MINUTE=10
ALIBABA_SHADOW_MAX_TOKENS_MINUTE=100000
ALIBABA_SHADOW_MAX_REQUESTS_DAY=500
ALIBABA_SHADOW_MAX_TOKENS_DAY=3250000
ALIBABA_SHADOW_MAX_COST_USD_DAY=1
ALIBABA_SHADOW_MAX_QUEUE=32
ALIBABA_SHADOW_MAX_DEFER_SECONDS=75
ALIBABA_SHADOW_EXPORT_TOKEN=<optional separate secret>
```

Use one replica and the existing persistent `/app/backend/data` volume. Do not deploy this branch
without reviewing `ALIBABA_SHADOW_V1.freeze.json` and the test results.

## 3. Dark checks

1. Start one replica with live disabled.
2. Confirm the existing Groq status and tests are unchanged.
3. Open the default dashboard and confirm the separate Alibaba panel appears.
4. Wait for a genuine New Orayan birth; do not fabricate a production candidate.
5. Confirm `candidate-snapshots.jsonl` grows and contains a bounded causal snapshot.
6. Confirm `decisions.jsonl` has no `REQUEST_STARTED` row and Alibaba usage did not increase.
7. Verify no future timestamp, outcome/PnL key, credential, raw log, or full symbol-state dump exists.
8. Exercise the optional-token NDJSON export and confirm it streams rather than buffering.

## 4. Canary

Only after dark checks pass, set `ALIBABA_SHADOW_ALLOW_LIVE=true` on one replica. Watch the first
eligible birth. A successful canary must have HTTP 200, valid local normalized output, actual token
usage, an estimated cost, and evidence paths that exist in the frozen snapshot. Confirm the request
used `enable_thinking:false` and JSON Object mode. Inspect daily request/token/cost counters and the
Alibaba console. Do not retry ambiguous `REQUEST_STARTED` rows; restart recovery terminalizes them
as unknown outcomes to prevent duplicate billing.

429/5xx responses are recorded once with bounded sanitized details. There are no automatic network
retries. Minute pressure may defer within the configured causal freshness window; expiry becomes an
abstention. Daily request/token/cost exhaustion is terminal for that candidate.

## 5. Rollback

Set `ALIBABA_SHADOW_ALLOW_LIVE=false` and restart. If necessary, remove the Alibaba API key. Keep the
append-only ledger and snapshot audit for prospective evaluation. Do not delete or rewrite Groq,
H1, or H2 data. Because execution never reads Alibaba output, disabling the sidecar requires no
trading rollback.

## Go/no-go gates

- **Dark deploy:** GO only when all tests pass, persistent paths are mounted, live is false, and the
  snapshot audit grows without provider calls.
- **Live canary:** NO-GO at code handoff. It requires operator completion of the dark checks,
  account/privacy acceptance, verified console quota/billing controls, and explicit enablement.
