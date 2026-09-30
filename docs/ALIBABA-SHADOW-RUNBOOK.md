# Alibaba Shadow V1 runbook

Alibaba Shadow is research-only and has no trading authority. Deploy with
`ALIBABA_SHADOW_ALLOW_LIVE=false`; do not enable a canary without explicit operator approval.

## Dark environment

```text
ALIBABA_API_KEY=<secret>
ALIBABA_SHADOW_ALLOW_LIVE=false
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

The workspace-specific Singapore endpoint is preferred over the legacy shared DashScope endpoint.
Keep one replica and the existing persistent `/app/backend/data` volume.

## Dark checks

1. Start with live disabled.
2. Confirm the Alibaba panel is present.
3. Wait for a genuine New Orayan birth.
4. Confirm `candidate-snapshots.jsonl` grows.
5. Confirm the provider ledger contains no `REQUEST_STARTED` record and Model Studio usage remains zero.
6. Restart and verify the snapshot audit remains available.

## Canary gate

Changing `ALIBABA_SHADOW_ALLOW_LIVE` to `true` requires explicit operator approval after the dark
checkpoint. The first canary must be a single eligible birth with JSON Object mode and
`enable_thinking:false`.
