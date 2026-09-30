# Alibaba Cloud Model Studio research record

Verified against Alibaba Cloud's official international documentation on **2026-09-30**. Pricing,
quotas, aliases, and dynamic limits can change; re-check the linked tables before enabling a canary.

## Baseline and recommendation

- Repository `main` baseline: `e6fe936396cd08688bac129595ac0d871b5493c1`.
- Default every-candidate model: **`qwen3.7-flash`**, non-thinking. It has a published Singapore
  price of **$0.03/M input tokens and $0.13/M output tokens**, a 1M-token new-user quota, and
  published limits of **15,000 RPM / 5,000,000 TPM**. The older alias is intentional: it is much
  cheaper than `qwen3.8-flash` and has fixed published limits rather than dynamic limiting.
- Medium fallback for a separately frozen future experiment: **`qwen3.7-plus`**, $0.40/M input,
  $1.60/M output, 1M free tokens, 15,000 RPM / 5,000,000 TPM.
- Selective deep-review candidate for a separately frozen future experiment: **`qwen3.8-max`**,
  $2/M input and $6/M output, 1M free tokens. Alibaba documents dynamic rate limiting rather than
  exact RPM/TPM. It is not invoked by V1.

Official sources: [model pricing](https://www.alibabacloud.com/help/en/model-studio/model-pricing),
[rate limits](https://www.alibabacloud.com/help/en/model-studio/rate-limit), and
[free quota](https://www.alibabacloud.com/help/en/model-studio/new-free-quota).

## Current Singapore facts

The international Singapore catalog includes current Qwen Max (`qwen3.8-max`, `qwen3.7-max`,
`qwen3-max`), Plus (`qwen3.7-plus`, `qwen3.6-plus`, `qwen3.5-plus`, `qwen-plus`), and Flash
(`qwen3.8-flash`, `qwen3.7-flash`, `qwen3.6-flash`, `qwen3.5-flash`, `qwen-flash`) families and
dated snapshots. Singapore also lists `qwen-turbo`, the dedicated reasoning model `qwq-plus`, and
Qwen open-source text families including current Qwen3.8/3.6/3.5 variants. The live pricing page is
the authoritative complete model-and-snapshot list; multimodal, coder, audio, and image families
are outside this text-only advisor's scope.

Relevant real-time prices and limits:

| Model | Mode used/available | Input $/M | Output $/M | New-user quota | Singapore rate limit |
|---|---:|---:|---:|---:|---:|
| `qwen3.7-flash` | non-thinking or thinking | 0.03 | 0.13 | 1M tokens | 15,000 RPM / 5M TPM |
| `qwen3.8-flash` | non-thinking or thinking | 0.15 | 0.47 | 1M tokens | dynamic |
| `qwen3.7-plus` | non-thinking or thinking | 0.40 | 1.60 | 1M tokens | 15,000 RPM / 5M TPM |
| `qwen3.7-max` | non-thinking or thinking | 2.50 | 7.50 | 1M tokens | 600 RPM / 1M TPM |
| `qwen3.8-max` | non-thinking or thinking | 2.00 | 6.00 | 1M tokens | dynamic |
| `qwen-turbo` | non-thinking or thinking | 0.05 | 0.20 / 0.50 thinking | 1M tokens | 600 RPM / 5M TPM |
| `qwq-plus` | reasoning | 0.80 | 2.40 | 1M tokens | 60 RPM / 100k TPM |

TPM includes input and output tokens. The rate-limit page does not publish RPD/TPD limits for
these models. Rate limits are account-level and topping up does not increase them. V1 deliberately
uses much lower local caps.

The free quota is limited to International-scope models in Singapore. The account profile must be
completed before Model Studio activation. It is normally granted automatically on first activation,
can take up to two hours to appear, and the model pricing table says it is valid for **90 days from
activation, model release, or application approval, whichever is later**. A general-purpose
pay-as-you-go API key consumes free quota automatically; Token Plan/Coding Plan keys do not. After
quota exhaustion, a completed-profile account moves to pay-as-you-go unless **Free Quota Only** is
enabled in the console. Quota availability and expiry must be checked in the console for the actual
account; code must not assume it exists.

## API, output mode, and token accounting

Alibaba provides an OpenAI-compatible Chat Completions API. API keys are region-specific. The
legacy Singapore pay-as-you-go base URL is
`https://dashscope-intl.aliyuncs.com/compatible-mode/v1`; Alibaba recommends a workspace-specific
production URL, `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`, for
higher throughput and workspace isolation. Trial URLs have lower limits. Token Plan and Coding Plan
URLs/keys are for interactive coding tools and are not appropriate for this backend. See the
[base URL reference](https://www.alibabacloud.com/help/en/model-studio/base-url).

Alibaba supports JSON Object mode for the shortlisted Qwen families. The current structured-output
page says **JSON Schema mode is not yet supported for Singapore models**. V1 therefore sends
`response_format: {"type":"json_object"}`, puts the frozen shape contract in the prompt, disables
thinking, and applies the authoritative strict validator locally. Unknown reason labels are
normalized to `OTHER_MODEL_REASON`; structural violations become persisted abstentions. This is the
closest safe Singapore equivalent to Groq's shape-strict transport without pretending provider-side
JSON Schema enforcement exists. See [structured output](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/qwen-structured-output)
and [error codes](https://www.alibabacloud.com/help/en/model-studio/error-code).

Hybrid Qwen models accept `enable_thinking`; current 3.5/3.6/3.7/3.8 series documentation says it
must be set explicitly. Thinking produces additional output/thinking tokens and increases cost.
Because JSON mode and thinking have model-specific caveats, V1 freezes `enable_thinking:false`.
Provider-reported prompt, completion, and total usage are recorded; cost uses the actual prompt and
completion counts when present, otherwise the conservative pre-call reservation remains charged in
the local budget.

## Privacy and retention assessment

Alibaba's [Model Studio FAQ](https://www.alibabacloud.com/help/en/model-studio/faq-about-alibaba-cloud-model-studio)
states that transmitted data is AES-256 encrypted and is not used for model training. The
[monitoring documentation](https://www.alibabacloud.com/help/en/model-studio/model-telemetry) says
default audit logs contain request ID, time, model, token usage, latency, status, and errors—not
prompt/response content—and are queryable for up to 30 days. Full prompt/response inference logging
is opt-in and writes to the customer's SLS Logstore; do not enable it for this experiment without a
separate review. Alibaba's FAQ defers detailed handling terms to the International Product Terms.
The official pages do not promise zero retention for API processing, so that must not be claimed.
Only bounded non-personal market data is sent; API keys, account details, order credentials, raw
logs, and post-birth outcomes are excluded.

## Cost model

Real-time inference, without cache discounts. Each range shows 300–500 output tokens.

| Model / snapshot | Per candidate | 1,000 candidates | 10,000 candidates |
|---|---:|---:|---:|
| `qwen3.7-flash`, 3k input | $0.000129–0.000155 | $0.129–0.155 | $1.29–1.55 |
| `qwen3.7-flash`, 6k input | $0.000219–0.000245 | $0.219–0.245 | $2.19–2.45 |
| `qwen3.7-plus`, 3k input | $0.00168–0.00200 | $1.68–2.00 | $16.80–20.00 |
| `qwen3.7-plus`, 6k input | $0.00288–0.00320 | $2.88–3.20 | $28.80–32.00 |
| `qwen3.8-max`, 3k input | $0.0078–0.0090 | $7.80–9.00 | $78–90 |
| `qwen3.8-max`, 6k input | $0.0138–0.0150 | $13.80–15.00 | $138–150 |

A 1M combined-token free quota is roughly 303 candidates at 3k+300 tokens or 154 candidates at
6k+500 tokens. This is approximate: the console is authoritative and free-quota accounting can be
model-specific.

Recommended safety posture: **$20 monthly account alert/limit**, local **$1/day**, 500 requests/day,
3.25M tokens/day, 10 requests/minute, and 100k tokens/minute. The $1 local daily cap is intentionally
far below the account-level monthly backstop. A model outside the built-in price table is locally
blocked unless both input and output unit-price environment variables are supplied.

## Research design

Every genuine `NEW_ORAYAN` birth gets one immutable candidate ID, episode ID, and birth timestamp.
The Alibaba snapshot is frozen at that point. It contains available H1/H2 raw state, exposure,
breadth, BTC/ETH 24h returns, short BTC returns already present in the prospective market snapshot,
funding, open interest, plan geometry/heat, quote quality, volatility/regime fields, transition
history, and bounded candidate-market observations. Unavailable ETH short-horizon fields and absent
Gemini/Market Intelligence material are explicit. A briefing is included only if already generated
and available before birth; there is no synchronous Gemini call and no later join.

Evaluation joins outcomes later by candidate/episode ID and birth time. On the same births, report
unchanged Orayan outcome, H1, H2, Groq GPT-OSS, and Alibaba Qwen: RETAIN/SKIP/ABSTAIN coverage,
avoided losses, missed winners, confidence calibration, latency, tokens, cost, and robustness by
time/regime blocks. API errors and local abstentions remain in denominators. Historical replay can
generate hypotheses, but cannot promote any model to trading authority.
