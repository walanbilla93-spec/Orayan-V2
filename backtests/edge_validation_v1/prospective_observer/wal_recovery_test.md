# WAL recovery verification

Local PASS. A record intent is durably committed, an injected crash occurs before acceptance, the database is closed/reopened, and recovery accepts exactly one pending record. Exact replay produces one attempt and one acceptance; conflicting payload IDs fail. Append-only triggers reject mutation/deletion. Hash chains and payload references reconcile. These tests are in verification/observer_tests.txt.

Live Northflank process restart, mounted-volume recovery and disk-failure behavior remain NOT RUN and block readiness proof. Do not substitute this local result for the deployed WAL restart requirement.
