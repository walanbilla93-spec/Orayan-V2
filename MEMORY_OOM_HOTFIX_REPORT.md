# New Orayan OOM hotfix — 23 September 2026

## Symptom
Northflank logs show repeated V8 fatal crashes: `Reached heap limit Allocation failed - JavaScript heap out of memory` after one or two scans. The GC trace is failing around ~287–299 MB old-space, which is consistent with V8's conservative heap sizing inside a small container.

## Root cause assessment
This is memory-pressure/OOM, not a trading logic failure. The current process keeps several large rolling research stores in memory at once. The post-V4 instrumentation added more research state and pushed the existing process above the practical heap ceiling. Three avoidable sources of pressure were found:

1. `journal.js` eagerly loaded the old legacy `signalHistory.json` into memory even though current operation/export uses `SIGNAL_EVENTS_COMPACT_V2`.
2. `researchCapture.js` restored the full 48-hour compact prospective archive on every restart. The archive is tens of MB on disk; `readFileSync(...).split('\n')` temporarily materializes the full strings/line arrays and rebuilds indexes from much more history than the live process needs.
3. `researchJournal.js` persisted large research arrays as pretty-printed JSON, increasing temporary stringify allocation during scan-time flushes.

The new structure/liquidation/stop-recovery streams remain bounded and append-only; no evidence of an unbounded Map/list leak was found in those paths.

## Hotfix
- Legacy `signalHistory` is now lazy-loaded only when an explicit legacy export is requested. Current compact signal journaling is unchanged.
- Prospective V4 restart recovery now rebuilds its live semantic index from only the latest 3 hours of hourly files. The complete 48-hour archive remains on disk and is still exported; this changes only process-memory restoration. Three hours covers the 30-minute candidate-continuity window and the ~62-minute forward-label maturity window with restart margin.
- Research environment/event JSON persistence is now minified, lowering transient serialization memory without changing schema/content.
- Docker V8 old-space is set to 352 MB to add modest emergency headroom above the observed ~300 MB auto-limit. This is paired with the memory reductions above rather than used as the sole fix.

## Strategy impact audit — round 1
Changed files are limited to memory/persistence paths plus Docker runtime configuration:
- `backend/lib/journal.js`
- `backend/lib/researchCapture.js`
- `backend/lib/researchJournal.js`
- `Dockerfile`

No gate, score, signal builder, ranker, sizing, entry, stop, target, executor, Marci, or strategy-setting code changed. Existing V4 research files and the new structure/stop supplement remain compatible.

Checks:
- `node --check` passes for journal, research capture, research journal, research supplement, and engine.
- Requiring journal/research/engine modules succeeds locally.

## Adversarial audit — round 2
- Legacy signal export still works; it loads the old store on demand instead of at boot.
- Current compact signal export behavior is unchanged.
- Prospective archive retention/export remains 48 hours; only restart index restoration is shortened.
- A candidate active across restart remains covered because candidate continuity is 30 minutes and 3 hours are restored.
- Unresolved forward labels mature at ~62 minutes and remain covered by the 3-hour restore window.
- Full historical prospective rows are not deleted by this hotfix.
- New BOS/CHoCH, liquidation windows, retrace shadow, and stop-recovery instrumentation are not disabled.

## Deployment / verification
Deploy this repo over the current New Orayan service. Do not clear the persistent volume and do not start a clean experiment.

After deployment, verify:
1. No new `heap out of memory` restart for at least 3–5 scans.
2. Scan duration and memory settle instead of climbing toward the limit each restart.
3. UI remains reachable and engine auto-resumes in PAPER mode.
4. Existing research download buttons still export data.

If memory still climbs after this hotfix, capture the next 10–15 minutes of Northflank memory/restart logs. The next escalation would be moving the two large JSON-array journals to append-only hourly files, not altering strategy logic.
