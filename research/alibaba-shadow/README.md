# Alibaba Qwen shadow advisor V1

Research-only sibling to the Groq shadow advisor. The backend copies genuine `NEW_ORAYAN`
candidate-birth evidence into a frozen `ORAYAN_ALIBABA_CANDIDATE_V1` snapshot, durably audits it,
and optionally sends it through a bounded single-worker queue. No return value is consumed by gates,
ranking, sizing, orders, execution, Marci, Groq, or Gemini.

Singapore currently lacks provider-enforced JSON Schema output, so requests use JSON Object mode
with thinking disabled. The prompt carries the frozen response contract; local normalization and
strict validation are authoritative. Unknown reason labels normalize to `OTHER_MODEL_REASON`.

The snapshot contract rejects future timestamps and outcome/PnL/fill/exit keys, caps the canonical
payload at 96 KiB, makes missing/stale data explicit, and includes a Gemini briefing only when its
generation and availability timestamps precede birth. There are no post-birth joins.

```text
node cli.js --input candidate-snapshots.jsonl --ledger decisions.jsonl --dry-run
npm test
```

Live requests require both `ALIBABA_SHADOW_ALLOW_LIVE=true` and an API key. Keep live false during
dark deploy. The exact environment, official-source research, cost model, canary procedure, and
rollback are in `docs/ALIBABA-SHADOW-RUNBOOK.md` and `docs/ALIBABA-MODEL-STUDIO-RESEARCH.md`.

The experiment freeze is `ALIBABA_SHADOW_V1.freeze.json`. Existing H1/H2/Groq history is not
rewritten.
