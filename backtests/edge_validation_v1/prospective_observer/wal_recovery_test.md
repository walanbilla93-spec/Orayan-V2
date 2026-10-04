# WAL and outcome recovery verification

Local PASS: durable intent interrupted before acceptance recovers exactly once; exact replay deduplicates; conflicting payloads fail; append-only mutation rejects. A new key-free outcome test interrupts after private outcome commit and before public acknowledgement. Restart publishes exactly one safe receipt from the original committed outcome, with no return value in the capture/receipt namespace. Public input reading rejects mutation.

20-test output: verification/observer_tests.txt. These are local mechanics, not live Northflank restart/readiness proof. A mounted-volume observer restart has not run.

## Lossless storage revision

Schema ORAYAN_PROSPECTIVE_OBSERVER_V1.2.0; implementation 48f8a796218073c1e0283e0997be1741007792ab4e7b8bf6177c70a0c9245bf3. RSA remains removed. WAL payloads, normalized bars, and raw response blobs now use lossless zlib encoding; hashes still cover exact original canonical JSON or response bytes. Required metadata/version IDs and every record are retained. Daily Parquet/ZSTD decodes exact original fields/bytes and exports/verifies in bounded batches. No sampling, pruning, or causal/timing change. Measured synthetic full-history intent+acceptance payload budget:1.14GiB for140x96 surfaces, excluding raw data, indexes and snapshots. Dedicated6GB storage is being qualified; previous uncompressed32GiB provisioning is superseded. Minimum4GiB free space and a real mount remain mandatory before capture. Entire60/120-day retention capacity must be independently qualified before activation. Earlier deployed31e5fba self-test proves the v1.1 OS boundary only; this v1.2 image must receive its own build/runtime verification.
