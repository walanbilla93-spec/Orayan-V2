# Daily immutable snapshot verification

Local and cloud build fixture checks PASS: exact JSON (null/Unicode/numbers), binary raw bytes and IDs survive Parquet/ZSTD; file/logical hashes and references reconcile; repeat export verifies the immutable existing artifact; intentional corruption rejects. Streaming export/verification retains complete payloads.

These are synthetic fixtures, not an audited market day. No deployed daily market snapshot exists; full live snapshot and retention capacity requirements remain unverified. No records have been sampled or pruned.
