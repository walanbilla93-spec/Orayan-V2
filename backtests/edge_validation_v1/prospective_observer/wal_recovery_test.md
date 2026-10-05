# WAL recovery verification

Local and cloud Docker build tests PASS: interrupted durable intent recovers once; exact replay deduplicates; conflicting replay and append-only mutation reject; partial-surface restart accounts for remaining symbols. Private outcome commit interrupted before public acknowledgement replays the original record once without exposing values or recomputation. Compression exactly roundtrips original response bytes/JSON and hashes. Read-only outcome input access rejects writes.

All 20 tests passed locally and in acoustic-spark-2930. The deployed Linux role probe can read a live SQLite WAL read-only. This is not a deployed mounted-volume restart of the live observer: that readiness requirement remains NOT RUN.
