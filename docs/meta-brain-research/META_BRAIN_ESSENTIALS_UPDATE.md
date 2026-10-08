# Single-tap essential history and optional keyless access

Deployed 2026-10-09 (Asia/Colombo) after the user explicitly confirmed “Yes, deploy without the key”. Keyless access and the single-tap full essential-history ZIP are live on the existing free service.

## User experience

A prominent **Download all essentials** button downloads `meta_brain_essentials.zip`. No date/dataset selection or consecutive hourly downloads are needed. It contains the entire available history for BTCUSDT, ETHUSDT and SOLUSDT:

- `predictions.csv`: all predictions and exact frozen features/provenance.
- `labels.csv`: all linked available outcomes, with the prediction event clock.
- `boundary.csv`: the one immutable prospective experiment boundary.
- `manifest.json`: snapshot time, scope/symbols, event range, exact population counts, pending outcomes, per-file byte counts and SHA-256 checksums, completion flag and exclusions.

Dense market capture and repetitive status rows are excluded from this small essential bundle. They remain available through the existing individual selectors. The default individual dataset is now predictions rather than raw trades. A successful browser transfer saves the ZIP; an interrupted transfer reports failure.

## Data and memory contract

`GET /research/api/essentials` accepts no query filters. A read-only repeatable-read transaction freezes all three populations at one snapshot; streaming cursors fetch one row at a time. Labels without a linked prediction and a missing/ambiguous boundary fail closed. Pending labels are explicitly counted rather than treated as completed. No raw capture table scans or decompression occur for the bundle.

Preflight bounds each essential table's total allocated size to 32 MiB and checks exact row counts/record sizes before HTTP success. Whole-bundle limits: 25,000 data rows, 32 MiB uncompressed CSV, one MiB per CSV row, 120 seconds. The existing two-second query deadline, one global query gate and >=64 MiB estimated working-set headroom guard remain, with memory rechecked every 256 rows. Non-seekable ZIP output is drained per row; neither the ZIP nor whole tables are held in server memory. Four fixed ZIP members keep directory overhead bounded. The browser buffers this small bounded ZIP before saving so failed transfers produce a visible error. ZIP central directory and manifest completion are delivered only after all populations/counts/checksums verify.

No data deletion, capture/schema changes, model/risk changes or execution enablement. Original source/config/model byte hashes remain unchanged. No new resource or spending.

## Keyless deployment behavior

Explicit `RESEARCH_PUBLIC_ACCESS=true` makes research metadata, individual exports and essential ZIP downloads accessible without a key or cookie. The public URL is https://p02--meta-brain-shadow-v1--2c624d5p4kgs.code.run/research/ . Anyone who obtains or discovers that URL can read/download the exposed research data. The application remains read-only and retains query, output and memory guards; credentials and service configuration are never exported. This is an intentional loss of authentication, not private access through an obscure URL.

The setting defaults to false, invalid values fail startup, and protected mode remains available for rollback. No access token needs to be deleted/rotated; keep the existing private token for restoring protection. The keyless setting was applied to Northflank after the required explicit confirmation. No-cookie requests to status and the full essentials download returned HTTP 200; the UI opens without a login form.

## Verification and rollout

27 tests passed, including full multi-day/all-symbol bundle, exact nested decimal values, ZIP CRC and manifest SHA checksums, read-only snapshot, preflight bounds, aborted archive, streaming before completion, shared query gate, cursor cleanup and explicit public-mode opt-in. Existing protected authentication, SQL/export and frozen-observer tests also pass; JavaScript syntax passes.

Local browser preview uses clearly marked synthetic data. One click produced a ZIP with all four files; it is not a live research export. The synthetic sample and preview screenshot are in outputs. Container build valid-mint-17 succeeded in 30 seconds for e05837e0bc785300db2e1fbdef7cb03063a1543a. GitHub research CI 37822419892 and shadow safety CI 37822419913 passed. Live no-cookie and browser single-tap ZIP downloads both completed: 33 predictions, 33 labels and one boundary; CRC, SHA-256 hashes, exact counts, unique/linked IDs, boundary and pending-outcome count verified. The HTTP smoke-test bundle was 52,034 bytes; browser bundle 52,033 bytes due to its different snapshot timestamp.

The console already showed a rolling deployment of the prepared image when work resumed. Its extra pod was repeatedly blocked by the original advisory writer lock (“another shadow writer owns the database”); the old writer remained active until the controlled pause. The rollout was paused to zero, only RESEARCH_PUBLIC_ACCESS=true was added using Update only, and one instance resumed at 2026-10-09 00:14:26 Asia/Colombo (2026-10-08 18:44:26 UTC), retaining CI/CD disabled, original image provenance and the 0.2 CPU / 512 MB free allocation.

The new instance encountered one bootstrap runtime failure from public market feed response 10006 (rate limit). It recovered on the platform's retry without source/model changes. Recording was interrupted approximately 18:42–18:48 UTC during pause/startup; exact persisted gap endpoints were not independently enumerated. At 18:48:43 UTC health was true, execution_enabled=false, shadow_only=true and write_errors=0, original boundary unchanged. Northflank then showed one running instance, 1/1 passing, with the one earlier startup restart. No OOM, paid resource change or data deletion/reset was performed.

The export preflight memory snapshot reported 268,722,176 cgroup bytes, 167,174,144 estimated working-set bytes and 344,825,856 estimated headroom bytes. These are startup measurements, not long-duration memory guarantees. The 64 MiB export reserve and other existing limits remain active.

Live URL: https://p02--meta-brain-shadow-v1--2c624d5p4kgs.code.run/research/ . Click **Download all essentials**. The real verified full-history snapshot is also saved locally as outputs/meta_brain_essentials.zip; raw research exports are excluded from Git and review packages. Population counts in the ZIP are durable totals; the UI's observer counters start fresh after a restart.

Evidence: essentials_live_verification.json, essentials_live.jpg, essentials_service_ready.jpg and rollout_health_essentials_after.json. The public mode can be reversed with RESEARCH_PUBLIC_ACCESS=false and a controlled restart; the existing private token was retained for that rollback. No capture redesign or TTL was executed.
