# Single-tap essential history and optional keyless access

Prepared 2026-10-08 following the user's request to remove the access-key requirement and download all essential research files in one tap. Implemented and tested; production activation is pending the required browser confirmation for removing authentication from a public endpoint. The deployed service continues to use its previous protected release until then.

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

The setting defaults to false, invalid values fail startup, and protected mode remains available for rollback. No access token needs to be deleted/rotated; keep the existing private token for restoring protection. The keyless setting has not yet been applied to Northflank. Browser-tool policy requires confirmation immediately before weakening authentication/publicly expanding access, even after an earlier request.

## Verification and rollout

27 tests passed, including full multi-day/all-symbol bundle, exact nested decimal values, ZIP CRC and manifest SHA checksums, read-only snapshot, preflight bounds, aborted archive, streaming before completion, shared query gate, cursor cleanup and explicit public-mode opt-in. Existing protected authentication, SQL/export and frozen-observer tests also pass; JavaScript syntax passes.

Local browser preview uses clearly marked synthetic data. One click produced a ZIP with all four files; it is not a live research export. The synthetic sample and preview screenshot are in outputs. Container build and live bundle integration remain pending rollout.

Build the existing feature branch with `research.Dockerfile`, preserving the frozen original GIT_COMMIT and supplying the additive commit as the per-build argument. After public-access confirmation, add only RESEARCH_PUBLIC_ACCESS=true, pause the one observer instance, select the new successful image and resume one instance with CI/CD disabled. Record the inevitable restart gap; verify original boundary, execution=false, shadow_only=true, health/write errors, no duplicate writer, no-key metadata/download access and live ZIP CRC/hash/count integrity. Revert the public setting and/or image if verification fails. No paid upgrade or capture reset is needed.
