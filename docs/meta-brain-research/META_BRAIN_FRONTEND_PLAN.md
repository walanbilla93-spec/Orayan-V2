# Meta Brain Research Data frontend plan

Prepared 2026-10-08 before implementation; finalized after read-only inspection. Implementation is complete locally; live deployment awaits paid capacity approval.

## Inspected system

Repository `walanbilla93-spec/Orayan-V2`, observer branch `feature/meta-brain-prospective-shadow-v1`, frozen commit `6b99b620435717bc360d3d9b5ca4d42b88f6ffef`. Northflank project `orayan-v2`, service `meta-brain-shadow-v1`, private PostgreSQL addon `meta-brain-research-db`. The current health endpoint confirms the frozen commit, healthy shadow-only operation, execution disabled, and zero write errors.

The inspected writer declares `predictions`, `labels`, `boundary`, `capture_chunks`, `capture_status`. Live catalog inspection confirmed this exact schema; the API revalidates it before exporting. `capture_chunks.payload` contains gzip JSONL, not ordinary flat records. `capture_lookup(stream,last_ms)` supports stream/time reads. Labels link to prediction IDs and lack their own timestamp/symbol columns.

## Implementation

Add an optional small aiohttp research app to the existing image, with a separate async read-only database connection and no model imports in the API module. The additive launcher starts exactly one unchanged observer plus the research app on port 8081; observer health stays on 8080. Existing observer source, config, models, writer and immutable boundary remain byte-identical. Record overlay revision separately from original observer provenance; do not silently replace the boundary's frozen commit with the overlay commit.

UI: status and dataset cards; UTC start/end, BTC/ETH/SOL, dataset and capture stream filters; range estimate; CSV / CSV.GZ downloads. Preserve original JSON in a `record_json` column so nested features and decimal strings survive. Capture exports expand original gzip records with chunk ID/hash provenance and receipt-clock filtering. Labels use their linked prediction's event clock, explicitly stated in UI. A completion trailer in gzip is absent on failed exports; interrupted responses must not be treated as complete.

No full-table scan at page open: catalog sizes and approximate row counts, indexed per-stream oldest/latest chunks, primary-key latest status. Statistics are marked approximate. Missing/unexpected schema fails closed. No schema creation, indexes, writes, delete or reset endpoints.

## Protection and workload limits

Passwordless secret link using URL fragment, exchanged by same-origin POST for an HttpOnly, Secure, SameSite=Strict HMAC session cookie. Fragment is removed from browser history immediately; no token in query strings, static assets, artifacts or access logs. Server startup refuses a missing/weak token. A localhost-only development mode supports preview; it cannot bind publicly. Additive access protects only the new research routes and cannot lock out existing health endpoints.

Parameterized filters; fixed dataset/stream/symbol allowlists; schema-qualified relations; fixed UTC range, maximum 1 hour; one export/metadata request at a time; server-side cursor fetched one chunk at a time; bounded gzip line/chunk decoding; maximum 32 MiB compressed input, 128 MiB output, 100,000 rows, 120-second total deadline and per-query timeout. Range estimates are conservative and cheap; guard unknown estimates rather than assuming zero. Export duration can be extended only after live load testing. No research ZIP initially: it would add processing and storage to a memory-constrained observer.

## Deployment gate

No additional service or addon is needed. Live observer memory measured 487.83 MB / 512 MB (95%); cgroup usage 491,417,600 / 512,000,000 bytes, including about 107 MB file cache. This does not establish safe headroom for continuous additional API work. Northflank disables 1,024 MB compute under this free project's limits. No resource, billing or deployment setting was changed.

Proposed deployment after separate paid-capacity approval: upgrade the EXISTING observer to nf-compute-50 (0.5 shared CPU, 1,024 MB), use the additive research.Dockerfile/launcher, preserve port 8080 health and every original shadow setting, and add authenticated research port 8081. Published compute price is $12/month ($0.0167/hour); other project resources might also become billable after leaving the free project, so total cost must be checked before activating any upgrade. Pricing: https://northflank.com/pricing .

An image replacement requires one planned observer restart and therefore a capture gap. Preserve the boundary, IDs and writer advisory lock; verify no duplicate writer/predictions and execution false afterward. Stage authenticated API and export smoke/load checks before sharing the private access link. Never hot-inject into the active observer.

Current delivery: 19 tests pass; frozen source/model hashes match; live read-only audit is complete; local browser preview and sample CSV.GZ download verified. Production API-to-database integration and load testing remain pending deployment capacity. No live frontend URL exists yet. The preview is sample data and is labeled accordingly.
