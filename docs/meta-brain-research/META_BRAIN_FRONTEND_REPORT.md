# Meta Brain frontend implementation report

2026-10-08. **Implemented and verified locally; NOT deployed.** Read-only live storage audit is complete. Capture redesign is a plan only. No data was wiped, deleted or reset, no schema/capture behavior changed, and the observer was not restarted.

## User access and deployment status

Local review: http://127.0.0.1:8766/research/ . The browser preview explicitly says “Local preview · sample downloads”; its download contains synthetic sample rows, not the live research population. Measured audit metadata is included for layout review. This address works only on this computer while the local preview is running.

Production route after deployment: `/research/` on new port 8081 of the EXISTING Meta Brain service. APIs: `/research/api/status`, `/research/api/estimate`, `/research/api/download`; private-link exchange `/research/session`. No production research URL or access token has been created. Existing port-8080 health is unchanged. No extra Northflank service/addon was created.

Live observer memory was 487.83 MB / 512 MB (~95%). A cgroup read found 491,417,600 / 512,000,000 bytes including 106,967,040 bytes file cache. Transient audit queries completed, but this does not prove adequate sustained headroom for an additional API. Northflank marks 1,024 MB compute unavailable under this free project's limits. Resource screenshot is included. Deployment therefore awaits a separate paid-capacity decision, as the user explicitly requires approval for paid resources.

Concrete proposal: upgrade existing meta-brain-shadow-v1 to nf-compute-50, 0.5 shared CPU / 1,024 MB. Published compute price $12/month ($0.0167/hour); leaving the free project can make other existing resources billable, and total project cost is not confirmed. Verify that total before applying billing changes. Reference: https://northflank.com/pricing . No purchase or resource change has been made.

## Files added

All code lives under `research/meta-brain-shadow/` on branch `feature/meta-brain-research-download-v1` based on frozen observer commit `6b99b620435717bc360d3d9b5ca4d42b88f6ffef`:

- research_api.py: guarded async read-only API, estimates, streaming CSV and CSV.GZ, authentication.
- research_launcher.py: starts one original observer plus optional research app.
- research.Dockerfile: additive image recipe; original Dockerfile unchanged.
- research_overlay_lock.json: original source/config/model hash manifest; startup fails on mismatch.
- research_ui/index.html, style.css, app.js: compact responsive interface.
- audit_research_storage.py: read-only catalog, rate and bounded sample audit utility.
- test_research_api.py: 19 regression/security/export tests.
- docs/meta-brain-research/: plans, measured audit and this report.
- .github/workflows/meta-brain-research.yml: export checks on pull requests; no deployment automation.

Original observer code, writer, config, dependencies, models and capture contract remain byte-identical. Overlay revision is recorded separately as RESEARCH_REVISION/image label; original observer GIT_COMMIT and immutable boundary remain the frozen original revision.

## Datasets and download behavior

Actual datasets: capture streams (13 observed), predictions, linked outcomes/labels, prospective boundary, capture status. Filters: UTC start/end, BTCUSDT/ETHUSDT/SOLUSDT, dataset and capture stream. Start included, end excluded. Labels use prediction event time. Boundary always exports its one immutable manifest. Nested JSON and decimal strings remain in record_json with ID/hash/time provenance.

Maximum selection one hour; longer periods downloaded in parts. Stream/symbol filtering reduces work. Catalog sizes and approximate counts appear on page open; no full population scan. Missing/unexpected schema or range index fails closed. Exact chunk metadata estimate must complete within its query timeout before HTTP success. Old ranges may time out due to current index shape; shorten the range or use the supplied audit/export code after index design is separately reviewed. No index is created here.

Server-side cursor fetches one chunk at a time. Limits: 32 MiB compressed input, 2 MiB per compressed chunk, 8 MiB decoded chunk, 1 MiB decoded line, 128 MiB uncompressed CSV, 100,000 rows, 120 seconds, one query/export globally. Incomplete exports abort the connection; CSV.GZ lacks a valid completion footer on failure. Downloads must complete successfully and gzip must verify before analysis. Research ZIP bundle is deferred to avoid extra memory/CPU on the constrained observer; the delivered review ZIP is code/docs/evidence, not a research-data export.

## Security

No credentials in browser code, query URLs, logs or delivered artifacts. Server reads existing private PG environment only; optional dedicated research-role environment is supported. Existing database role was not broadened or altered. Connections default to read-only and explicitly set a read-only transaction; rollback/close on completion. A dedicated SELECT-only role is additional defense if separately configured; application read-only mode alone is not a database-level permission separation from the writer role.

New research routes require a cryptographically random access token (at least 32 random bytes). A URL fragment is removed immediately, exchanged by same-origin HTTPS POST for an eight-hour signed HttpOnly/Secure/SameSite=Strict cookie. No access logging. Existing health access does not change. Parameterized values, fixed identifiers and dataset/symbol/stream allowlists; small login body and throttled failures; self-only content policy and no third-party assets. Local preview can bind only loopback and refuses non-local clients.

## Verification

Draft review: https://github.com/walanbilla93-spec/Orayan-V2/pull/12 . Implementation commit: `4c27d134a0a173ab020a04d449fda53549821205`. GitHub Actions completed successfully for both Meta Brain research export safety (run 37748386424) and the existing Meta Brain shadow safety (run 37748386332). No merge or deployment occurred. Final source/config/model bytes also match the original Git blobs, independently of Windows checkout line endings.

19 tests passed in 1.703 seconds, covering authentication/unauthorized no-query behavior, cookie flags/tampering/expiry/rotation, SQL/time limits, repeated filters, schema rejection, checksum/gzip bomb bounds, clock semantics, long overlapping chunks, exact nested decimals, export caps, interrupted gzip, global gate, read-only connection lifecycle, static asset secrecy and all frozen source/model hashes.

The streaming test consumed 10,000 approximately 1 KiB rows while measuring Python allocation peak below 16 MiB; this is not production process RSS or proof of live memory safety. JavaScript syntax and Python compilation passed. Desktop and 390×844 mobile preview checked; mobile page width was 390 with no horizontal overflow. Browser sample CSV.GZ downloaded and decoded successfully. Sample is clearly labeled. Live schema/table/rate/sample queries ran in read-only transactions and completed without writer errors.

Not performed: container build, authenticated production URL test, live API export integration, sustained observer-plus-export load test. These require approved deployment capacity. No claim of live frontend availability or capture-volume reduction yet.

## Deployment sequence after capacity approval

1. Confirm total project billing and provision existing-service memory only.
2. Build additive research.Dockerfile from reviewed branch and verified commit, with original build context; set RESEARCH_ACCESS_TOKEN securely in Northflank, never embed it in source/logs. Preserve all existing observer PG and safety settings. Original observer SHA remains locked.
3. Keep the existing health port 8080. Route HTTPS research port 8081; research API remains authenticated. Stage the private route before distributing any access link.
4. Replace image in one controlled rollout; record the inevitable capture gap. Do not run a second writer concurrently; original PostgreSQL advisory lock/boundary remain authoritative.
5. Validate original boundary/commit, execution=false, shadow_only=true, no duplicate IDs/write errors, health, actual memory/CPU under bounded downloads, unauthorized API rejection and authenticated CSV/GZ integrity. Observe beyond startup; pause overlay rollout if inadequate capacity.
6. Give the user the verified private frontend address. Any future sparse capture epoch, retention TTL or deletion requires separate authorization.

## Live safety evidence

Northflank still shows original build healthy-brass-7024 / commit 6b99b62, CI/CD disabled, zero restarts. Health at 2026-10-08T07:21:06.063Z: healthy=true, execution_enabled=false, shadow_only=true, model_lock_verified=true, write_errors=0; original prospective boundary 2026-10-07T01:50:01.328Z and increasing uptime retained. Logical DB 1,314,944,691 bytes; existing 3 GiB ceiling still active. No observer restart, risk/model changes or capture deletion occurred.

## Deliverables

META_BRAIN_FRONTEND_PLAN.md; META_BRAIN_STORAGE_AUDIT.md; META_BRAIN_CAPTURE_REDESIGN_PLAN.md; META_BRAIN_FRONTEND_REPORT.md; source code and test output; exact machine-readable measurements/rates; screenshots; synthetic sample download. All are included in meta_brain_research_frontend_review.zip.
