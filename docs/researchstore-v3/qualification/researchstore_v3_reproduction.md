# Reproduce the stopped primitive gate

Apply the supplied patch onto prerequisite commit `582d9056c1fbc10dad342bf71e60169e86969b88`. No runtime imports use the new module. Do not run the backend against a production data directory.

Run inside an isolated Node 20 Alpine container with no provider credentials, network execution, production volumes or source evidence mounted. Use one CPU quota of 20,000/100,000 microseconds, memory.max=512,000,000 bytes and V8 old-space=352 MiB. The measured Northflank scratch disk was ephemeral and does not certify production-volume fsync durability.

```sh
node --max-old-space-size=352 --test backend/test/researchV3Primitive.test.js
V3_SCALES=1,10,100 node --max-old-space-size=352 backend/tools/research-v3-benchmark.js /tmp/unique-new-scratch
```

The scratch directory must be new. The tool creates immutable synthetic fixture files and deterministic record keys. It deliberately keeps all generated evidence through this qualification attempt. Ensure capacity before larger runs; the 2-GB temporary free-project allowance is insufficient for a complete 100× physical fixture. Do not delete canonical history or reduce test populations to evade capacity gates.

The benchmark stops after a distributed fold exceeds the 15-second conservative gate. It does not implement a service scheduler or replay live market management. Output is results.json, identity.json and memory.jsonl, plus physical shards and sort runs. A first Linux run emitted a failed gate while the outer process exited 0 to preserve artifacts: **process exit 0 is not a qualification pass**. Inspect latencyGate and the acceptance matrix.

The bootstrap wrapper adds 50-ms kernel/cgroup samples from a parent process and packages only result/trace/test/source-hash files into a gzip JSON artifact. Its final log records carry SHA-256, numbered base64 chunks and a byte count. Use chunks <=500 characters because the observed Northflank viewer truncated log lines at 1,000 characters. Reassemble all numbered chunks, check byte count and gzip SHA-256 before decoding. A successful artifact transfer is not a migration receipt or storage activation.

The test transport uses the same fixed source bundle on both Linux attempts. The repeat changes artifact chunk size only. Package source hashes permit comparison with the exact tested bytes, including line endings.
