# Frozen acceptance matrix

**MEDIUM IMPLEMENTATION PARTIAL — FROZEN DESIGN GATE FAILED**

The isolated cold-index gate failed before production integration. No frozen A-case is claimed fully passed. Primitive tests passed 12/12 on Linux; 36 existing protection regressions passed locally on Windows. These are supporting checks only.

| Case | Result | Evidence / remaining work |
|---|---|---|
| A01 startup scaling | NOT RUN | No V3 startup; 10×/100× halted after primitive latency failure. |
| A02 physical full startup | NOT RUN | No caller adapters, physical recovery fixture or full backend boot. |
| A03 state parity | NOT RUN | No migration. |
| A04 payload preservation | NOT RUN | No canonical payload transformation performed. |
| A05 dedupe boundary | NOT RUN | Primitive replacement tested; no V3 emit/restart/counter contract. |
| A06 collision/negative proof | PARTIAL | Forced digest collisions and corrupt search/key/proof/header tests passed; root/family descriptor chain not implemented. |
| A07 event WAL crash matrix | NOT RUN | V3 active WAL absent. |
| A08 native/scalar LSN | NOT RUN | No V3 transactional reducer. |
| A09 tail/base boundary | NOT RUN | No V3 tail/checkpoint. |
| A10 open episodes | NOT RUN | No O/P adapters. |
| A11 episode width | NOT RUN | No normalized child projection. |
| A12 AI recovery | NOT RUN | No V3 attempt/obligation integration. |
| A13 provider recovery | NOT RUN | No V3 V/O projection integration. |
| A14 extrema/management | NOT RUN | Existing protected code unchanged; no V3 restore. |
| A15 historical export | NOT RUN | No archive/export integration. |
| A16 concurrent export | NOT RUN | No snapshot/lease integration. |
| A17 corruption | PARTIAL | Primitive page/header/size tests passed; full evidence/root/segment checks not built. |
| A18 torn publication | NOT RUN | No generation/CURRENT publication. |
| A19 migration interruption | NOT RUN | No migration tool. |
| A20 incomplete legacy source | NOT RUN | No source reconciliation. |
| A21 rollback | NOT RUN | No selectable V3 runtime; procedure states required future rules. |
| A22 pressure/capacity | PARTIAL | Overlay bound/LSN conflict tests passed; no WAL reserve or ENOSPC recovery. |
| A23 native/PAPER | PARTIAL | Baseline protected fingerprints and existing related regressions pass; no V3 market-input replay. |
| A24 resource/provider protections | PARTIAL | Existing regression cases pass locally; no V3 projection semantics tested. |
| A25 status/readers | NOT RUN | No compact V3 endpoints or paged caller adapters. |
| A26 ownership | PARTIAL | Atomic lock-directory refusal tested, including incomplete lock; no two-process mixed-selector acceptance. |
| A27 offline sustained timing | FAILED PRE-INTEGRATION GATE | 1× synchronous distributed fold 34.13s >15s supported management interval; sustained same-load native reference and larger scales not run. |

No canary or production test was performed or proposed. Full-service maxRSS, heap, cgroup, status-size and retained-history growth gates remain unqualified.
