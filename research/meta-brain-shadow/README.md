# Meta Brain Phase 3B public-only shadow observer

This is a separate Python service/image. Build context must be research/meta-brain-shadow, Dockerfile Dockerfile. It includes no production backend, trading simulator, broker client or order execution endpoint. Root application Dockerfile and min-service branch remain unchanged.

## Frozen base

Latest chronological Phase3A fold 3 A/B binaries are copied byte-for-byte and verified against the original effective_model_parameters.json. No final fit, refit, tuning or performance-based fold winner selection. C remains diagnostic only; D OOD and daily prior14-day drift are interface diagnostics with unconfigured policy. Direction is not an output. Original 58-feature order/preprocessing/calibrators stay frozen. Public market order flow is separately namespaced and never feeds the base. Generic snapshots do not get model predictions: the frozen models were trained on BOS/SWEEP events.

Feature math, detector and indicators are extracted from audited Phase1 source bundled in Phase3A, with AST equality tests for the math. Frozen BOS/SWEEP detector requires 200 completed 15m bars. Initial 6000 completed 1m OHLC observations are bootstrap-only warmup, in a separate storage partition. No historical trades/depth/liquidations are backfilled. Live auxiliary rows use observed receipt clocks and historical minimum availability lag, with missing values preserved for frozen imputation. OI/premium z-scores require 96 prior publications and will be missing initially. Head C realized labels are omitted because its reference UT target is diagnostic only; A/B 60m labels mature separately and censor gaps/bootstrap.

## Northflank deployment

- Existing free project orayan-v2, Europe West London. Existing min-service remains on its original branch, unchanged.
- New combined free service meta-brain-shadow-v1, one replica, nf-compute-20 (0.2 shared vCPU / 512 MiB RAM). No attached volume and no shared RWO mount.
- Included free PostgreSQL 17 addon meta-brain-research-db, 0.2 vCPU / 512 MiB RAM / 6 GB NVMe, private TLS networking. This addon is the durable store. No paid upgrade or new paid volume.
- Build context /research/meta-brain-shadow, Dockerfile /research/meta-brain-shadow/Dockerfile (Northflank locations are repository absolute). Image contains only the standalone observer.
- Git branch feature/meta-brain-prospective-shadow-v1, reviewed commit; leave PR unmerged and disable automatic deployment updates after initial build.
- Build argument GIT_COMMIT=actual reviewed 40-character commit. Runtime inherits image revision.
- Runtime EXECUTION_ENABLED=false, SHADOW_ONLY=true, DEPLOYMENT_ENV=northflank, SHADOW_STORAGE=postgres, DATA_ROOT=/tmp/shadow-cache, PORT=8080, SHADOW_DEPLOYMENT_ID=phase3b-v1-<commit-short>.
- Link only this new addon connection details, mapped to PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, PGSSLMODE=require. Do not copy production secret groups or exchange credentials. Credentials remain inside Northflank's secret links, absent from reports.
- Health/readiness GET /healthz; process liveness GET /livez. Require 180 continuous healthy seconds, fresh trades/depth on all symbols, acknowledged subscriptions, writable database, exchange timestamp <= raw receipt for last 100 messages, absolute measured clock offset <1000ms and half-RTT uncertainty <2000ms.
- Boundary is the immutable PostgreSQL boundary row; local prospective_start_manifest.json is only a cache regenerated from that row after restart. Commit/config/model mismatch fails closed. Advisory lock prevents simultaneous writers.
- Compressed raw/derived partitions commit approximately each second, with a 1 MiB RAM bound. Predictions flush all source buffers before publication. Sudden death can lose at most the bounded uncommitted tail; startup/transport gaps explicitly invalidate continuity. No missing interval is represented as complete or zero flow. No deletion occurs.
- Stop at 3 GiB database size to retain WAL/system headroom on 6 GB disk. This is a bounded launch design; measure growth before extending the evidence period. No automatic storage scaling/purchase.
- Receipt timestamps are never adjusted. Negative lags prevent the prospective start. Clock-adjusted lag is labelled diagnostic only.

Before declaring deployed, inspect several minutes of remote health/logs and samples for BTC and another symbol, depth, derived rows, feature snapshots/predictions if eligible, disk writes, sequence/gap behavior, matched frozen hashes and no execution. Approval of cost does not itself establish readiness.

## Verification

Python 3.12 + exact scikit-learn 1.9.1. Install requirements.txt, run python test_shadow.py. Portable fixed prediction fixtures validate A/B/C unchanged weights; optional PHASE3A_LOCK_ROOT enables broader independent replay against original records and AST source equality. Run python service.py --duration 240 --data <local-trial-root> with DEPLOYMENT_ENV=qualification for a bounded live trial. Qualification never creates a prospective boundary and all trial data is excluded from Northflank study. No event is fabricated to make a test appear live.

See orderflow_feature_contract.md and storage_retention_plan.md for exact proxy and retention limits.
