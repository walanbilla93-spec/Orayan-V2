# Crash matrix — not qualified

Only the isolated cold primitive exists. No exception-injection test is presented as a process/power interruption.

| Durable boundary | Status |
|---|---|
| WAL part write/fsync | NOT IMPLEMENTED / NOT RUN |
| WAL commit rename/directory fsync | NOT IMPLEMENTED / NOT RUN |
| Canonical segment partial write/fsync | NOT IMPLEMENTED / NOT RUN |
| Receipt append/fsync and overlay apply | NOT IMPLEMENTED / NOT RUN |
| Native/scalar LSN exactly-once replay | NOT IMPLEMENTED / NOT RUN |
| WAL completion marker and active pointer clear | NOT IMPLEMENTED / NOT RUN |
| Shard/proof creation process interruption | NOT RUN; files use exclusive creation, no root can select them in this slice |
| Multi-family manifest/root publication | NOT IMPLEMENTED / NOT RUN |
| Checkpoint/CURRENT rename and directory fsync | NOT IMPLEMENTED / NOT RUN |
| Migration stage interruption/resume | NOT IMPLEMENTED / NOT RUN |
| Corrupt positive/negative lookup pages | Primitive corruption tests PASS; not a crash test |
| Exclusive writer lock contention | Same-process lock tests PASS; mixed-v2/v3 and killed-process matrix NOT RUN |

The frozen A07/A18/A19 crash matrices remain mandatory after High resolves the earlier fold gate. No new storage can be activated from this package.
