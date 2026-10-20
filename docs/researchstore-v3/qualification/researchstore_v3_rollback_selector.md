# Selector and rollback — blocked implementation

No runtime V3 selector or `research-canonical-v3/CURRENT` is implemented. No migration or production cutover occurred. Keep the existing selector/code and all source evidence unchanged. The known V2 OOM issue remains unresolved by this isolated primitive.

Do not deploy the primitive as a storage replacement. No `VERIFIED_NOT_ACTIVE` receipt exists. The receipt example is deliberately `EXAMPLE_ONLY_NOT_VERIFIED` with null identities and activationAllowed=false.

Future required procedure, not tested in this partial slice:

1. Fence the sole writer; preserve source, destination, journals, WAL, epoch and acknowledged watermarks. Keep CD off and all model/feedback activation off.
2. Before V3 activation/writes, unchanged V2 remains readable. Its memory problem is not fixed by rollback.
3. Activate V3 only after a complete verified migration receipt matches the exact fenced source boundary and every referenced object is durable. No automatic fallback or migration.
4. After any accepted V3 event, native-only or scalar write, refuse stale V2 resume. Fix forward, or produce and verify an additive reconstruction through the latest acknowledged storage LSN and event sequence.
5. Select an older V3 generation only with a verified continuous journal/WAL bridge through acknowledged commits; otherwise remain fenced and reconstruct offline.
6. Preserve old generations and raw evidence. No history deletion, epoch reset, Marci retirement receipt or model activation is part of rollback.

The temporary Northflank runner contains only synthetic scratch data and the isolated source payload. Its artifacts must be downloaded and checked before runner removal. Production min-service, Heavy Meta and PostgreSQL are outside the runner-cleanup scope.
