# WAL and outcome recovery verification

Local PASS: durable intent interrupted before acceptance recovers exactly once; exact replay deduplicates; conflicting payloads fail; append-only mutation rejects. A new key-free outcome test interrupts after private outcome commit and before public acknowledgement. Restart publishes exactly one safe receipt from the original committed outcome, with no return value in the capture/receipt namespace. Public input reading rejects mutation.

19-test output: verification/observer_tests.txt. These are local mechanics, not live Northflank restart/readiness proof. A mounted-volume observer restart has not run.
