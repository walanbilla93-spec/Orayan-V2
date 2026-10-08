# Meta Brain storage audit

Measured 2026-10-08 by read-only PostgreSQL queries through the existing service shell. No tables, indexes, triggers, capture rows or deployment settings were changed. Byte units below are decimal MB/GB; database size differs from physical addon volume usage.

## Measured logical database and tables

Logical DB: **1,263,105,715 bytes (1.263 GB / 1.176 GiB)** at 06:10:59 UTC (11:40:59 Asia/Colombo). Queries used `pg_database_size`, `pg_relation_size`, `pg_table_size`, `pg_indexes_size`, `pg_total_relation_size`. The table totals include TOAST storage; do not add TOAST again.

| Table | Heap MB | Table + TOAST MB | Index MB | Total MB | Row count |
|---|---:|---:|---:|---:|---|
| capture_chunks | 894.181 | 1097.196 | 133.587 | 1230.782 | 846,561 catalog estimate |
| capture_status | 11.256 | 23.560 | 0.238 | 23.798 | 9,872 exact |
| predictions | 0.008 | 0.139 | 0.016 | 0.156 | 21 exact |
| labels | 0.016 | 0.049 | 0.016 | 0.066 | 21 exact |
| boundary | 0.008 | 0.016 | 0.016 | 0.033 | 1 exact |

`capture_chunks` is 97.44% of logical DB bytes. Predictions and labels together occupy only 216 KiB including indexes. The 23.8 MB status table is repetitive but not the main storage contributor.

| Index | MB |
|---|---:|
| capture_chunks_pkey | 97.288 |
| capture_lookup | 36.299 |
| capture_status_pkey | 0.238 |
| predictions_pkey | 0.016 |
| labels_pkey | 0.016 |
| boundary_pkey | 0.016 |

Capture primary key + lookup indexes alone occupy 133.6 MB. Many one-row gzip chunks incur UUID/text-key, row, index and gzip header/dictionary overhead. Flushing every ~1 second trades durability for poorer compression and index efficiency. This is separate from unnecessary cadence; reducing both can help in a future epoch.

## Actual schema and population

Live schema matches the inspected writer: predictions(id TEXT, event_ms BIGINT, symbol TEXT, record TEXT); labels(id TEXT, record TEXT); boundary(id INTEGER, record TEXT); capture_chunks(id TEXT, stream TEXT, symbol TEXT, first_ms/last_ms BIGINT, rows INTEGER, sha256 TEXT, payload BYTEA); capture_status(id BIGINT, at BIGINT, record TEXT). Additional PostgreSQL statistics views are not research datasets.

All-stream aggregate at 07:13:26 UTC counted **888,778 chunks** and **2,285,690 source records**, with **900.830 MB** of already-gzipped payload. Source records are envelopes/derived samples; raw_trades rows are publicTrade message batches, not individual fills. Catalog count above predates this exact count. Existing observer counters are session-local; they must not be advertised as the full durable population.

All captured receipt range: **2026-10-07T01:45:34.982000+00:00 → 2026-10-08T07:13:17.851000+00:00**. Initial bootstrap predates prospective boundary 2026-10-07T01:50:01.328Z. The current measured history is roughly 29 hours, not an assumed three-day recording interval.

| Stream | Exact chunks | Source rows | Existing gzip MB | First receipt UTC | Latest receipt UTC |
|---|---:|---:|---:|---|---|
| depth_1s | 276,708 | 276,708 | 322.142 | 2026-10-07T01:46:51.187000+00:00 | 2026-10-08T07:13:17.503000+00:00 |
| raw_trades | 203,515 | 1,600,046 | 313.553 | 2026-10-07T01:46:54.579000+00:00 | 2026-10-08T07:13:17.851000+00:00 |
| derived_1s | 276,708 | 276,708 | 190.975 | 2026-10-07T01:46:51.187000+00:00 | 2026-10-08T07:13:17.503000+00:00 |
| derived_5s | 63,588 | 63,588 | 44.697 | 2026-10-07T01:46:51.187000+00:00 | 2026-10-08T07:13:15.475000+00:00 |
| feature_pipeline_status | 30,684 | 30,684 | 12.981 | 2026-10-07T01:46:51.187000+00:00 | 2026-10-08T07:13:07.511000+00:00 |
| derived_60s | 5,304 | 5,304 | 3.788 | 2026-10-07T01:46:51.187000+00:00 | 2026-10-08T07:13:00.404000+00:00 |
| aux_oi_5m | 6,384 | 6,384 | 2.397 | 2026-10-07T01:46:52.496000+00:00 | 2026-10-08T07:13:06.479000+00:00 |
| aux_long_short_5m | 6,384 | 6,384 | 2.370 | 2026-10-07T01:46:52.907000+00:00 | 2026-10-08T07:13:06.808000+00:00 |
| aux_funding | 6,384 | 6,384 | 2.327 | 2026-10-07T01:46:53.564000+00:00 | 2026-10-08T07:13:07.465000+00:00 |
| live_ohlc | 5,301 | 5,301 | 2.283 | 2026-10-07T01:47:00.215000+00:00 | 2026-10-08T07:13:01.096000+00:00 |
| aux_premium_1m | 6,384 | 6,384 | 2.277 | 2026-10-07T01:46:53.234000+00:00 | 2026-10-08T07:13:07.135000+00:00 |
| raw_liquidations | 1,425 | 1,797 | 0.648 | 2026-10-07T01:52:41.180000+00:00 | 2026-10-08T07:08:20.601000+00:00 |
| bootstrap_ohlc | 9 | 18 | 0.393 | 2026-10-07T01:45:34.982000+00:00 | 2026-10-07T01:46:28.177000+00:00 |

## Recent measured rates

Six complete UTC hours: **2026-10-08 01:00–07:00 UTC** (06:30–12:30 Asia/Colombo). Total gzipped payload **186.356 MB**, **31.059 MB/hour**, projected **0.745 GB/day** if that workload persists. This excludes row/index/status/WAL overhead. Grouping assigns a chunk to its last receipt hour, so a small boundary shift is possible. Actual complete-hour SQL aggregates avoid undercounting the current partial hour.

| Stream | Rows/hour | Gzip MB/hour | Projected gzip MB/day | Share |
|---|---:|---:|---:|---:|
| depth_1s | 9,463.5 | 11.041 | 264.983 | 35.55% |
| raw_trades | 56,890.2 | 10.976 | 263.425 | 35.34% |
| derived_1s | 9,463.5 | 6.542 | 157.001 | 21.06% |
| derived_5s | 2,159.5 | 1.522 | 36.519 | 4.90% |
| feature_pipeline_status | 1,046.0 | 0.433 | 10.394 | 1.39% |
| derived_60s | 180.0 | 0.129 | 3.088 | 0.41% |
| aux_oi_5m | 217.5 | 0.082 | 1.960 | 0.26% |
| aux_long_short_5m | 217.5 | 0.081 | 1.938 | 0.26% |
| aux_funding | 217.5 | 0.079 | 1.897 | 0.25% |
| aux_premium_1m | 217.5 | 0.078 | 1.862 | 0.25% |
| live_ohlc | 180.0 | 0.078 | 1.862 | 0.25% |
| raw_liquidations | 55.8 | 0.021 | 0.495 | 0.07% |

Depth + raw trades + derived 1s = 91.95% of recent payload. Including derived 5s = 96.85%. No capture stream was assumed dominant without measurement.

## Bounded payload inspection and duplication

Latest samples were checksum-verified, decoded one line at a time and inspected by field names/serialized byte lengths only. No raw market records or credentials were included in the audit output. Depth sample: 3,291 decoded bytes, 1,294 gzip bytes; bid_levels 1,034 bytes + ask_levels 1,032 bytes = 62.8% of decoded row. Derived 1s sample: 1,398 decoded bytes, 719 gzip bytes, repeats receipt/continuity/CVD-anchor/wall/book summaries each second. Feature status sample: 706 decoded bytes, 431 gzip bytes; live_feature_snapshot 235 bytes, repeated no-event explanation 78 bytes, hash 66 bytes. One raw-trade sample had 711 decoded row bytes inside a 755-byte multirow gzip chunk; this is not a representative compression ratio.

Recent maximum raw-trade gzip chunk 135,177 bytes; maximum raw chunk receipt span 1,137 ms. Sampled depth/derived rows typically persist one row per chunk. Auxiliary OI/long-short/funding streams repeat around every 47 seconds despite source publication periods of 5 minutes/8 hours; in-memory LiveAux deduplicates timestamps, but the capture writer still saves repeated source payloads. Frozen base predictions do not consume order-flow features; separate future flow research requirements must be decided before changing that acquisition contract.

## Independent logical growth and smaller datasets

Health readings 05:42:28–07:21:06 UTC: 1,241,847,475 → 1,314,944,691 bytes, an increase of 73,097,216 bytes over 5,917.877 seconds. Recent logical growth: **44.467 MB/hour, projected 1.067 GB/day**. This includes table/index/status costs, excludes WAL, and is distinct from the six-hour gzip-only rate. Current ceiling is 3,221,225,472 bytes (3 GiB); about 42.9 hours of headroom at this slope from 07:21 UTC. Capture stops at that ceiling without deleting data. Volume exhaustion and this logical ceiling are different conditions.

Additional read-only small-table aggregates at 07:25:22 UTC:

| Dataset | Rows | Earliest UTC | Latest UTC | Serialized record bytes |
|---|---:|---|---|---:|
| predictions | 21 | 2026-10-07T04:15:00+00:00 | 2026-10-08T03:30:00+00:00 | 164,755 |
| labels | 21 | 2026-10-07T04:15:00+00:00 | 2026-10-08T03:30:00+00:00 | 8,453 |
| capture_status | 10,308 | 2026-10-07T01:43:16.169000+00:00 | 2026-10-08T07:25:21.588000+00:00 | 32,664,397 |

Label times above are linked prediction event times; labels have no independent maturation timestamp column. Boundary is one immutable row with prospective start 2026-10-07T01:50:01.328Z, so a row/hour growth projection is inappropriate. Smaller-dataset startup averages over the approximately 29.70-hour captured interval: predictions/labels each about 0.707 rows/hour; status about 347.1 rows/hour. Serialized record averages: predictions 5547 B/hour (~0.133 MB/day), labels 285 B/hour (~0.007 MB/day), status 1.100 MB/hour (~26.394 MB/day). These are startup averages of uncompressed JSON, not recent measured logical table growth or an assertion of constant prediction cadence. Small-table record bytes can exceed allocated logical bytes due to PostgreSQL TOAST compression. Exact table growth requires successive per-table snapshots; the reliable recent whole-database and per-stream rates are reported separately above.

## Physical volume and WAL limits

Northflank screenshot supplied by user showed 1.73 GB of a 6 GB volume at an unspecified timestamp. PostgreSQL logical size is 1.263 GB at the audit timestamp. Those are different measurements and times; their subtraction is not an exact WAL figure. Volume also includes WAL, other databases/system catalogs, logs/configuration and filesystem overhead. Dedicated-role access to `pg_ls_waldir()` was denied (42501), so current physical WAL bytes could not be measured. No permissions were broadened. Current addon volume reading is recorded separately when available; logical DB size never includes WAL directory size.

## Safety and reproducibility

Read-only connection option `default_transaction_read_only=on` verified via SHOW; fixed SELECT/catalog queries, 5–10 second statement timeouts and 1 MB work_mem; no INSERT/UPDATE/DELETE/DDL. Sequential measurements advance while writer runs and are labeled with separate timestamps. The observer remained on its frozen build; execution false, shadow true, original immutable boundary retained. Final live health and restart status are recorded in the frontend report.

Machine-readable evidence: storage_measurements.json and storage_stream_rates.csv. Screenshots and captured terminal text support the measurements. WAL is explicitly unknown, not zero. Current→proposed retention and sizing are in META_BRAIN_CAPTURE_REDESIGN_PLAN.md.

## Query references

PostgreSQL 17 database/object size functions: https://www.postgresql.org/docs/17/functions-admin.html . Streaming cursor documentation: https://www.psycopg.org/psycopg3/docs/advanced/cursors.html .
