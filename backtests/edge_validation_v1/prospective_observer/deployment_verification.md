# Key-free deployment verification

Separate research job qualification is being prepared in the existing signed-in Northflank project. No keys/passwords are created or requested. Actual job/build/pod/image identities will be appended after verification. A deployed self-test is operational qualification only, not a24h capture audit.

The Northflank console reports Free project, services2/2, existing min-service commit5eb0262e51747d76879d85eac877eec3ced0531a, buildfuzzy-person-5698, deploymentmin-service-887596954, podmin-service-887596954-zxpm8. Only6GB volume sizing is enabled;10GB and larger are disabled. No service/volume is replaced; no plan upgrade is performed.

Production code diff stays confined to the observer directory. Existing PAPER mode, V3executionAllowed=false, V2benchmarkd7f2ba802a4b4204fad70bf502c6f996f76aabc4, V3control9fb7a1e55834dd57f0d0c194dce76178e6a132d3e4fa39bcdc74f627193ad928, implementation45add96f5e48c660f53071dc699caed53542696bf6ca995f10e12bfe379a4944, settings878ea6128e3f18fe5352d248e3f8d8356901e7e8506590ecd66260dac8be8f94 remain unchanged by this task. Read-only comparison is saved in verification/live_control_verification.json.

Observer schemaORAYAN_PROSPECTIVE_OBSERVER_V1.2.0; implementation48f8a796218073c1e0283e0997be1741007792ab4e7b8bf6177c70a0c9245bf3. NO production behavioral trading rule promoted.

## Lossless storage revision

Schema ORAYAN_PROSPECTIVE_OBSERVER_V1.2.0; implementation 48f8a796218073c1e0283e0997be1741007792ab4e7b8bf6177c70a0c9245bf3. RSA remains removed. WAL payloads, normalized bars, and raw response blobs now use lossless zlib encoding; hashes still cover exact original canonical JSON or response bytes. Required metadata/version IDs and every record are retained. Daily Parquet/ZSTD decodes exact original fields/bytes and exports/verifies in bounded batches. No sampling, pruning, or causal/timing change. Measured synthetic full-history intent+acceptance payload budget:1.14GiB for140x96 surfaces, excluding raw data, indexes and snapshots. Dedicated6GB storage is being qualified; previous uncompressed32GiB provisioning is superseded. Minimum4GiB free space and a real mount remain mandatory before capture. Entire60/120-day retention capacity must be independently qualified before activation. Earlier deployed31e5fba self-test proves the v1.1 OS boundary only; this v1.2 image must receive its own build/runtime verification.
