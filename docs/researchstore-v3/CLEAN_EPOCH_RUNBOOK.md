# Clean V3 production epoch

Historical bulk migration is permanently abandoned. Never resume `migrate` on this production data root. Keep the service stopped during preparation and activation. V2 remains the read-only historical reference at `<DATA_DIR>/research-canonical-v2`.

Run these offline commands in order, with `ORAYAN_V3_OFFLINE=true`:

```sh
node backend/tools/research-v3-migrate.js abandon-audit "$DATA_DIR"
node backend/tools/research-v3-migrate.js remove-abandoned-staging "$DATA_DIR"
node backend/tools/research-v3-migrate.js prepare-clean-epoch "$DATA_DIR"
node backend/tools/research-v3-migrate.js publish-clean-epoch "$DATA_DIR"
node backend/tools/research-v3-migrate.js activate "$DATA_DIR"
```

The auditor verifies source hashes and no shared files before scoped staging removal. Immutable receipts and the permanent bulk-import fence live outside the removed namespace. Preparation creates a fresh UUID epoch and an explicit obligation inventory. It carries only owned unresolved management/funding/private outcomes, exact associated native mappings/extrema, and uncertain requests without retrying them. Completed history, prior AI outputs, lessons and Meta learning state are excluded. Birth/decision evidence for inherited positions remains a reference to V2, with an explicit continuity gap. The old provider budget is conservatively fenced until its next UTC day.

Set `RESEARCH_STORE_BACKEND=v3` and `RESEARCH_IMPLEMENTATION_COMMIT=<candidate SHA>`, then start the normal server. Preserve existing admission, PAPER/native management and provider budgets. Fresh native capture, shadow operational state and feedback memory live inside `research-canonical-v3`. Inherited native positions cannot generate new feedback lessons. `META_BRAIN_V1_SHADOW`, `QWEN_FEEDBACK_ENABLED` and `GROQ_FEEDBACK_ENABLED` retain their existing enablement meanings; enabled learning reads only the new epoch memory. Active Marci background work stays off.

The durable `research-backend-activation.json` records selection and write intent before the first authoritative V3 write. Explicit `rollback-before-write` is permitted only before write intent. After write intent, fix forward on V3; stale V2 fallback is forbidden. Ambiguous activation state fences admission.

Check `/api/capture/status/details`: backend v3, HEALTHY, captureHalted false, accepted and persisted counts consistent. Record startup/current RSS, heapUsed, external and cgroup peak. Confirm zero history dictionaries and bounded caches, overlays, descriptors, handles and cursors; observe health beyond the archive timer under 512 MB. V2 source hashes must remain unchanged.

Targeted validation: `node --test backend/test/researchV3CleanEpoch.test.js backend/test/researchV3Production.test.js`, plus protected PAPER/native, resource-reset, provider and feedback regressions. `research-v3-clean-fixture.js` and `research-v3-startup-probe.js` run the actual server with the V2 constructor/history reads blocked against a new disposable local fixture.
