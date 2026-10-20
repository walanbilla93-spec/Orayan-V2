# Resource reset: implementation plan

Audit performed 2026-10-20 (Asia/Colombo), before code changes.

## Baselines and live evidence

Orayan repository walanbilla93-spec/Orayan-V2, active branch paper-safe-ba5726f,
commit c66f1d7494635030e3871ed78529f83ea1080ff1. Northflank min-service:
build brave-gold-9811, deployment min-service-5d98495697; 0.2 vCPU / 512 MB,
observed 0.164 vCPU / 463 MB, 2 restarts over 5 days. CD enabled.

Heavy Meta: same repository, feature/meta-brain-decision-first-v2,
78e0820c9cef79537b11f0f73314d5d753e9304e; build mint-ants-3373,
deployment meta-brain-shadow-v1-5c88d4b667; 0.2 vCPU / 512 MB,
observed 0.032 vCPU / 444 MB, no restarts over 8 days; CD disabled.
No attached volume. Dedicated addon meta-brain-research-db: PostgreSQL 17,
6 GB NVME, TLS/private networking, observed 658 MB storage and 288 MB RAM.
Production decision_store.py connects using PG* environment variables and owns
mb_events, mb_state, mb_archives, mb_external, mb_performance, mb_resolved,
mb_pending; PostgreSQL also stores boot/reset receipts. No credentials copied.
Existing legacy tables and externally verified archives may also exist; their
inventory/backup completeness has NOT been independently verified in this pass.
No database, addon, epoch, or service mutation is planned.

Orayan has the separate orayan-data volume (6 GB, about 0.91 GB used).
Repository Dockerfile expects /app/backend/data; verify actual mount before deployment.

## Runtime audit

backend/lib/engine.js imports marciIndependent and marciShadow, eagerly loads
marciShadowTrades.json, scans Marci for every symbol on every native scan,
manages Marci pending/open trades, acquires extra candles, tracks post-invalidation
counterfactuals, sorts/admit/sizes paper shadow candidates, writes Marci history
on every scan and maintenance checkpoint, calculates status summaries, and
mutates Marci through panic/reset paths. These run on the native scan timer;
there is no separate Marci worker to terminate. shadowCandidates/shadowFunnel
and history are the Marci working state. Journal/research schemas and exports
also contain historical Marci fields; keep those.
frontend/app.js polls /api/shadow/trades on every refresh and renders an active
Marci tab, counters, exports and destructive clear button.
Historical-only: JSON history, canonical archives, journal schema fields,
existing exported artifacts and dormant Marci algorithm source.

## First pass

1. Remove Marci discovery/management/admission/persistence/panic writes and
   active UI/polling. Keep on-demand historical reads/exports, prohibit clear.
2. Add a pure frozen scalar feature contract, frozen model validator and
   shadow inference. Default ABSTAIN until a reviewed development-trained
   artifact is explicitly installed. Supply a reproducible offline fit pipeline.
3. Tap the existing shared packet and native CLOSED outcome once. Add immutable
   compact birth/AI/feedback records under a new quota-limited research directory;
   do not duplicate market acquisition, alter execution, or rewrite old stores.
4. Derive a bounded lesson digest with causal availability clocks, structured
   categories and explicit missing values. Add disabled-by-default provider
   routing infrastructure with one call per candidate, no automatic arm activation.
5. Targeted validation of retirement, PAPER simulation, canonical capture,
   frozen comparators, causal/bounded reflection and no-authority inference.
6. Commit and prepare reviewable changes. Deploy only if persistence and
   validation make it safe; Heavy Meta replacement remains deferred.

## Protected behavior

No edits to native signals/gates/risk/executor, Meta-Lite rules, provider base
prompts/thresholds, historical evidence, or clean epoch
c7a2bbe1-cefa-4221-8e1a-5d98e4dbd7af. No online model fit or weight update.
No historical order-flow acquisition. No provider calls in validation.

## Sol High gate

Review persistence/export coverage and unresolved obligations before service
pause/replacement; feature causality/training split; experiment economics;
learned influence; deployment and rollback. No learned trading authority in this pass.
