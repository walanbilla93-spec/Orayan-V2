# Daily immutable snapshot verification

Local fixture PASS: canonical JSON fields (including null, Unicode and numeric values), raw exact bytes and IDs survive Parquet/ZSTD export/decode; record/response counts, file and logical hashes reconcile; repeat export verifies the existing immutable snapshot; intentional corruption fails verification.

This is a synthetic durability/roundtrip fixture with a patched clock, not a market day or readiness audit. No deployed daily capture snapshot has been created. All140-symbol retention capacity, volume permissions and immutable artifact backup must be verified before PASS.
