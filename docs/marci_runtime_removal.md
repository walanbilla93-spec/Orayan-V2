# Marci runtime retirement

Removed from engine.js: algorithm imports, eager ledger loading, shadow trade
management and counterfactual loops, per-symbol independent setup discovery,
Marci gating/ranking/sizing/admission, periodic ledger writes, maintenance
checkpoint overwrite, panic mutations and active funnel counters. The existing
native scan timer remains; no new timer/worker/queue was added.

Removed from the frontend: active Marci tab/rendering/state, refresh-time shadow
request, export/clear button bindings. Other UI controls remain unchanged.

Kept: marciShadow.js and marciIndependent.js as dormant historical source,
journal/research Marci field definitions, historical files and archives,
GET /api/shadow/trades and GET /api/journal/shadow/export. Reads load the
historical JSON only on demand, do not price positions, mutate evidence, rename
malformed evidence, or write the file back. POST clear returns ok:false with
MARCI_HISTORY_READ_ONLY. Status reports RETIRED / READ_ONLY_ON_DEMAND.
Historical exports are still available by their existing URLs.

Open/pending historical simulations and tracking flags remain exactly as stored.
They are frozen incomplete observations, not newly cancelled/closed trades.
Research must censor these at the retirement deployment timestamp; never treat
their lack of subsequent progress as a strategy result. The deployment receipt
is the operational cutoff; there is no fabricated historical lifecycle event.
Existing maintenance inspection still counts unresolved historical Marci and
canonical obligations conservatively. Full snapshot sealing may remain blocked
by those frozen rows. This pass does not relabel them resolved or weaken the
snapshot-safety gate; explicit retirement/censor accounting needs Sol High review
before rollout. Normal PAPER management and research sealing remain available.

Expected savings: one setup discovery per scanned symbol, all active Marci
paper/counterfactual candle acquisition, Marci history rewrites and resident
ledger objects; one HTTP request per frontend refresh per open console. Exact
RSS/CPU and storage-write savings require a deployment measurement. Existing
historical storage size intentionally remains unchanged.

Native signals.js/gates.js/risk.js/executor.js and Meta-Lite/researchPayload
are byte-identical to deployed c66f1d7 (normalized LF fingerprints in tests).
Native trade management/admission engine spans also retain baseline hashes.

Rollback: redeploy existing build brave-gold-9811 / commit c66f1d7 with the same
orayan-data mount. No migration restoration is required. Before restarting the
old Marci loops after a long gap, review frozen unresolved simulations and mark
the observational gap; do not infer missing paths. Keep the evidence files.
