# Groq shadow production runbook

This is append-only, prospective research. It observes immutable New Orayan `candidate_birth`
events. Its return values are unavailable to signal creation, gates, ranking, sizing, risk, SL/TP,
portfolio limits, orders, Marci, Gemini/Market Intelligence, or execution. H1/H2 remain frozen.

## Mandatory first deployment: dark

Do not enable live Groq during the first deployment. Pin the reviewed hardening commit, use exactly
**one Northflank replica**, and retain the existing persistent volume.

```text
GROQ_SHADOW_ALLOW_LIVE=false
GROQ_SHADOW_LEDGER=/app/backend/data/groq-shadow/decisions.jsonl
GROQ_API_KEY=<Northflank secret; retained but unused while dark>
GROQ_SHADOW_MODEL=openai/gpt-oss-120b
GROQ_SHADOW_TIMEOUT_MS=15000
GROQ_SHADOW_MAX_OUTPUT_TOKENS=1024
GROQ_SHADOW_MAX_REQUESTS_DAY=900
GROQ_SHADOW_MAX_TOKENS_DAY=180000
GROQ_SHADOW_MAX_REQUESTS_MINUTE=20
GROQ_SHADOW_MAX_TOKENS_MINUTE=7200
GROQ_SHADOW_MAX_DEFER_SECONDS=75
GROQ_SHADOW_MAX_QUEUE=32
```

These defaults retain 10% headroom below the observed organization ceilings of 8,000 TPM,
1,000 RPD, and 200,000 TPD. The 20 RPM cap is deliberately unchanged and remains below 30 RPM;
with the observed roughly 2,000 tokens per call, TPM is the binding limit. The 1,024 completion
allowance includes GPT-OSS reasoning tokens and replaces the undersized 220-token cap. Keep these
values configurable, one replica only, and do not raise them above the organization limits. A call
reserves its conservative estimate before I/O, then successful responses reconcile the minute/day
ledger to Groq's reported total tokens. Errors and interrupted/unknown outcomes retain the full
reservation rather than assuming unused capacity.

The V2 prompt/response contract became effective 2026-09-29 in implementation commit
`e50edf4eae5ef1f233328b9c8e496e990fdd7be0`. H1/H2 and candidate eligibility are unchanged.
The only scheduling change is that an otherwise eligible snapshot may wait up to 75 seconds from
candidate birth for minute capacity. No later market observation or post-birth outcome is added.

Historical V1 rows cannot reveal the exact 400 subtype because V1 discarded the response body.
The request used supported GPT-OSS fields, but its 220-token completion ceiling also covered hidden
reasoning and was far below Groq's documented 1,024-token default; intermittent exhaustion before
the strict JSON object completed is the principal code-level cause. V2 uses 1,024 and records future
400s as `API_400_SCHEMA` or `API_400_REQUEST` with sanitized detail, so this diagnosis is directly
verifiable after activation rather than inferred.

`GROQ_SHADOW_SNAPSHOT_LOG` is optional; its safe default is
`/app/backend/data/groq-shadow/candidate-snapshots.jsonl`. `GROQ_SHADOW_EXPORT_TOKEN` is optional.
When it is set, the download endpoint requires that value as either
`X-Groq-Shadow-Export-Token` or a Bearer token; the Dashboard prompts for it only when downloading
and does not store it. Without it, download behavior remains backward-compatible and
unauthenticated. The status endpoint exposes metadata only, never the Groq API key or export token.

Exactly one replica is required because the durable queue and rate-budget index are process-local
over one append-only ledger. Do not scale this research producer horizontally.

## Preflight before deploying

Record the exact SHA approved by the test report and configure Northflank to deploy that SHA, not a
moving branch tip. In the built container:

```sh
EXPECTED_SHA='<approved hardening commit SHA>'
ACTUAL_SHA="$(git rev-parse HEAD)"
printf 'expected=%s\nactual=%s\n' "$EXPECTED_SHA" "$ACTUAL_SHA"
test "$ACTUAL_SHA" = "$EXPECTED_SHA"
```

Verify the service has exactly one replica in Northflank. Then prove the volume is mounted,
writable, and is the intended persistent mount without deleting or truncating existing evidence:

```sh
test -d /app/backend/data
mount | grep ' /app/backend/data '
probe="/app/backend/data/.groq-shadow-volume-probe-preflight"
printf 'preflight\n' > "$probe"
sync
ls -l "$probe"
```

Redeploy the same dark commit, then confirm that exact probe still exists. Remove only that named
probe after survival is proven:

```sh
ls -l /app/backend/data/.groq-shadow-volume-probe-preflight
rm -- /app/backend/data/.groq-shadow-volume-probe-preflight
```

If the mount, write, or redeploy-survival check fails, stop. Do not enable live mode.

## Dark-deploy verification

Confirm configuration and deployed identity:

```sh
git rev-parse HEAD
env | grep -E '^GROQ_SHADOW_(ALLOW_LIVE|LEDGER|MODEL|MAX_QUEUE)='
test "$GROQ_SHADOW_ALLOW_LIVE" = false
test "$GROQ_SHADOW_LEDGER" = /app/backend/data/groq-shadow/decisions.jsonl
```

Open the default Dashboard. **Groq Shadow Research** and **Download Groq Shadow Data** must be
visible. Before a ledger exists, the button must be disabled with `No Groq decisions yet`.

Trigger or wait for a genuine `NEW_ORAYAN` candidate birth. Do not fabricate a row in production.
Verify its durable snapshot and verify dark mode made no request:

```sh
test -s /app/backend/data/groq-shadow/candidate-snapshots.jsonl
tail -n 10 /app/backend/data/groq-shadow/candidate-snapshots.jsonl
if test -f /app/backend/data/groq-shadow/decisions.jsonl; then
  ! grep -q '"record_type":"REQUEST_STARTED"' /app/backend/data/groq-shadow/decisions.jsonl
fi
```

The audit must contain `QUEUED`, then `PROCESSING`, then `LIVE_DISABLED` for the handoff. There must
be no `REQUEST_STARTED`, no new external Groq request, and no API usage increase attributable to the
service while `GROQ_SHADOW_ALLOW_LIVE=false`.

## Restart durability drill while dark

Observe a new `QUEUED` snapshot row and copy its `handoff_id`. Restart the single container without
clearing or replacing the volume. After restart, prove the same row survived and gained a terminal
processing event (normally `LIVE_DISABLED` in dark mode):

```sh
HANDOFF_ID='<observed handoff_id>'
grep -F "\"handoff_id\":\"$HANDOFF_ID\"" /app/backend/data/groq-shadow/candidate-snapshots.jsonl
```

There must be one original `CANDIDATE_SNAPSHOT`/`QUEUED` row and a later terminal
`PROCESSING_EVENT`; there must still be no external request. A restart that loses the queued row,
fails to recover it, or creates a request in dark mode is a stop condition.

Inspect ambiguous requests at any time with:

```sh
node -e 'const fs=require("fs"),p="/app/backend/data/groq-shadow/decisions.jsonl";if(!fs.existsSync(p))process.exit(0);const m=new Map;for(const l of fs.readFileSync(p,"utf8").trim().split(/\n/)){if(!l)continue;const r=JSON.parse(l);if(r.record_type==="REQUEST_STARTED")m.set(r.request_id,r);if(r.record_type==="SHADOW_DECISION")m.delete(r.request_id)}for(const r of m.values())console.log(JSON.stringify(r))'
```

On process startup, every orphan `REQUEST_STARTED` is append-terminalized as
`INTERRUPTED_UNKNOWN_OUTCOME`/`ABSTAIN`. It is never automatically retried, because the original
call may have been billed. Re-run the inspection after startup; it must print nothing.

## Separate live activation

Only after every dark check passes and an operator explicitly approves activation, change only:

```text
GROQ_SHADOW_ALLOW_LIVE=true
```

Keep one replica and all budgets/model/prompt values unchanged. After redeploy, verify:

```sh
test "$(git rev-parse HEAD)" = '<approved hardening commit SHA>'
test "$GROQ_SHADOW_ALLOW_LIVE" = true
tail -n 20 /app/backend/data/groq-shadow/candidate-snapshots.jsonl
tail -n 20 /app/backend/data/groq-shadow/decisions.jsonl
```

For one causally complete genuine birth, the snapshot audit must show `QUEUED` before processing,
and the decision ledger must show one `REQUEST_STARTED` followed by one terminal
`SHADOW_DECISION` with the same request ID. Missing/stale/future evidence must produce a local
ABSTAIN without `REQUEST_STARTED`. Confirm the Dashboard status and download a copy:

```sh
curl -fsS https://p01--min-service--2c624d5p4kgs.code.run/api/journal/research/groq-shadow
if test -n "$GROQ_SHADOW_EXPORT_TOKEN"; then
  curl -fsS -D - -o /tmp/groq-shadow-check.jsonl \
    -H "X-Groq-Shadow-Export-Token: $GROQ_SHADOW_EXPORT_TOKEN" \
    https://p01--min-service--2c624d5p4kgs.code.run/api/journal/research/groq-shadow/export
else
  curl -fsS -D - -o /tmp/groq-shadow-check.jsonl \
    https://p01--min-service--2c624d5p4kgs.code.run/api/journal/research/groq-shadow/export
fi
wc -l /tmp/groq-shadow-check.jsonl
```

The Dashboard summary is backed by the process's bounded ledger index (one initial scan, then
incremental updates). Verify new rows after activation:

```sh
node -e 'const fs=require("fs"),p="/app/backend/data/groq-shadow/decisions.jsonl";for(const l of fs.readFileSync(p,"utf8").trim().split(/\n/)){const r=JSON.parse(l);if(r.schema_version==="ORAYAN_GROQ_SHADOW_RECORD_V2")console.log(r.status,r.http_status||"",r.api_error?.code||"",r.api_error?.message||"")}'
```

- New valid requests should end in `OK`, not unexplained `API_400_REQUEST` or `API_400_SCHEMA`.
- Any non-2xx row must show bounded `api_error.type`, `code`, and `message` plus request, prompt,
  input, and response-schema hashes. It must never contain a key, authorization header, or raw body.
- The Dashboard exposes model decisions, local abstains, API errors, malformed and normalized
  outputs, deferred/stale counts, last HTTP error summary, and token totals.
- During a burst, look for `BUDGET_DEFERRED` followed by `REQUEST_STARTED`/`SHADOW_DECISION` for the
  same request ID. If freshness expires first, expect `ABSTAIN_BUDGET_STALE` and no API call.
- `BUDGET_EXHAUSTED` for a daily limit remains terminal with no `REQUEST_STARTED`.

## Rollback and stop conditions

Immediately set `GROQ_SHADOW_ALLOW_LIVE=false` and redeploy if any of these occurs: more than one
request for a request ID, an orphan not terminalized after restart, repeated upstream calls,
budget-limit violation, queue growth beyond its configured bound, volume/path error, event-loop or
trading latency regression, Groq output reaching trading logic, or malformed/corrupt evidence.

If code rollback is also required, deploy the pre-V2 baseline
`687ca26440b6aae2535a1e5b1c56e502c15b72cc` with live mode false. Do not delete, truncate, rewrite,
or detach `/app/backend/data`; append-only evidence must survive rollback. Restoring the hardening
commit later will recover nonterminal snapshots and freeze ambiguous requests without retry.
