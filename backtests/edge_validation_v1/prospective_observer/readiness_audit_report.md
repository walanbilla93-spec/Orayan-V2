# 24-hour capture readiness audit

INCOMPLETE —0/24 live hours. Attempted0, accepted0, skipped0. No scheduled audit surfaces have been observed; strict+1ms late-input rate is null. No readiness_receipt.json or activation_receipt.json exists; actual_start_utc is null.

RSA/public-key custody is no longer a blocker. The key-free OS boundary is implemented and local mechanics pass20 tests. Real deployed Linux UID separation is being qualified independently. Synthetic unit/build/job checks do not contribute readiness hours.

External blocker: Northflank free-project service quota2/2 is reached; only6GB volume sizes are enabled. Dedicated storage sufficient for all140 symbols with lossless payload/receipt/WAL retention is unavailable. Trading service capacity and its existing data volume have not been repurposed. No false audit start, sampling, skip, pruning, or ephemeral-only retention is used to bypass the requirement.

Live WAL restart/snapshot/unresolved-reference accounting is unmeasured. Local WAL and private-outcome acknowledgement crash recovery and immutable snapshot tests pass. Timing-study v2 need is UNDETERMINED until an actual strict+1ms audit demonstrates impracticality. No frozen timing or predicate was changed. NO production behavioral trading rule promoted.

## Lossless storage revision

Schema ORAYAN_PROSPECTIVE_OBSERVER_V1.2.0; implementation 48f8a796218073c1e0283e0997be1741007792ab4e7b8bf6177c70a0c9245bf3. RSA remains removed. WAL payloads, normalized bars, and raw response blobs now use lossless zlib encoding; hashes still cover exact original canonical JSON or response bytes. Required metadata/version IDs and every record are retained. Daily Parquet/ZSTD decodes exact original fields/bytes and exports/verifies in bounded batches. No sampling, pruning, or causal/timing change. Measured synthetic full-history intent+acceptance payload budget:1.14GiB for140x96 surfaces, excluding raw data, indexes and snapshots. Dedicated6GB storage is being qualified; previous uncompressed32GiB provisioning is superseded. Minimum4GiB free space and a real mount remain mandatory before capture. Entire60/120-day retention capacity must be independently qualified before activation. Earlier deployed31e5fba self-test proves the v1.1 OS boundary only; this v1.2 image must receive its own build/runtime verification.
