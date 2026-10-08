# Meta Brain Research Data frontend plan

Prepared 2026-10-08 before implementation; finalized after read-only inspection. Implemented and deployed to the existing free service; final state is in META_BRAIN_FRONTEND_REPORT.md.

## Inspected system

Repository `walanbilla93-spec/Orayan-V2`, observer branch `feature/meta-brain-prospective-shadow-v1`, frozen commit `6b99b620435717bc360d3d9b5ca4d42b88f6ffef`. Northflank project `orayan-v2`, service `meta-brain-shadow-v1`, private PostgreSQL addon `meta-brain-research-db`. The current health endpoint confirms the frozen commit, healthy shadow-only operation, execution disabled, and zero write errors.

The inspected writer declares `predictions`, `labels`, `boundary`, `capture_chunks`, `capture_status`. Live catalog inspection confirmed this exact schema; the API revalidates it before exporting. `capture_chunks.payload` contains gzip JSONL, not ordinary flat records. `capture_lookup(stream,last_ms)` supports stream/time reads. Labels link to prediction IDs and lack their own timestamp/symbol columns.

## Implementation

Add an optional small aiohttp research app to the existing image, with a separate async read-only database connection and no model imports in the API module. The additive launcher starts exactly one unchanged observer plus the research app on port 8081; observer health stays on 8080. Existing observer source, config, models, writer and immutable boundary remain byte-identical. Record overlay revision separately from original observer provenance; do not silently replace the boundary's frozen commit with the overlay commit.

UI: status and dataset cards; UTC start/end, BTC/ETH/SOL, dataset and capture stream filters; range estimate; CSV / CSV.GZ downloads. Preserve original JSON in a `record_json` column so nested features and decimal strings survive. Capture exports expand original gzip records with chunk ID/hash provenance and receipt-clock filtering. Labels use their linked prediction's event clock, explicitly stated in UI. A completion trailer in gzip is absent on failed exports; interrupted responses must not be treated as complete.

No full-table scan at page open: catalog sizes and approximate row counts, indexed per-stream oldest/latest chunks, primary-key latest status. Statistics are marked approximate. Missing/unexpected schema fails closed. No schema creation, indexes, writes, delete or reset endpoints.

## Protection and workload limits

Masked access-key form exchanged by same-origin HTTPS POST for an eight-hour HttpOnly/Secure/SameSite=Strict cookie. No tokens in URLs, static assets, artifacts or access logs; missing/weak token fails closed. Existing health access remains unchanged.

Parameterized filters; fixed dataset/stream/symbol allowlists; schema-qualified relations; fixed UTC range, maximum 1 hour; one export/metadata request at a time; server-side cursor fetched one chunk at a time; bounded gzip line/chunk decoding; maximum 8 MiB compressed input, 32 MiB output, 25,000 rows, 120-second total deadline and per-query timeout. Range estimates are conservative and cheap; guard unknown estimates rather than assuming zero. Export duration can be extended only after live load testing. No research ZIP initially: it would add processing and storage to a memory-constrained observer.

## Deployment outcome

Completed within the existing free 0.2 CPU / 512 MB allocation following explicit user restart/deploy authorization. Aggregate memory included reclaimable file cache and audit-shell overhead; paid capacity was unnecessary for this rollout. Allocator trimming and >=64 MiB working-set export guards were added without shrinking scientific windows. Controlled single-writer restart, build, readiness, authenticated CSV.GZ download and unauthorized API rejection were verified. See META_BRAIN_FREE_DEPLOYMENT_REPORT.md and META_BRAIN_FRONTEND_REPORT.md for measurements and the cold-cache limitation.

Live frontend: https://p02--meta-brain-shadow-v1--2c624d5p4kgs.code.run/research/ . No extra resource or billing change; capture redesign remains plan only.
