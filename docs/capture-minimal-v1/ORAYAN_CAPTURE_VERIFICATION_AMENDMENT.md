# Capture verification amendment

Created 2026-10-08T02:16:30.782Z, after the authorized first reset and before the final capture-only rollout. The frozen pre-reset plan and schema have not been rewritten.

Live measurement found 96,111 bytes of candidate growth over approximately 161 seconds during a no-main-trade period. The initial trigger still treated changing quote geometry as a rejected-candidate refresh. That extrapolated to roughly 49 MiB/day and would hit the initial 10 MiB cap; it was unsuitable for the requested minimal dataset.

Final trigger: first candidate; first observation of a new strategy bar; change in admission, enabled gate pass states or rejection reason; exact current frozen features at ORDER_INTENT. NO_ORDER with the same source episode and reason is recorded once. Disabled-gate details, including unused funding values, are dropped. These changes only alter capture, not gate calculations or execution.

The emergency daily cap is 20 MiB (4 MiB reserved for lifecycle/arms/health), instead of the planning cap 10 MiB. This allows necessary decision transitions while bounding an error loop. The 256 MiB space limit rotates complete old segments with explicit retained/pruned counters; 180 days is the maximum age. Missing/truncated segments make completeness false. Tiny durable trade-ID counter keys prevent repeated funding/fill updates from double-counting and distinguish inherited outcomes.

Same clean epoch continues through this code-only restart; no second telemetry wipe is planned. The first reset receipt remains authoritative. Revised daily volume must be measured after rollout, not inferred from the original 2.8 MiB/day planning scenario.

Final steady scan verification found secondary gate flips (including floating-point RR boundary flips) while the same main blocker still rejected the candidate. Final capture triggers use admission or the first sorted failed-gate code plus strategy-bar/entry boundaries; complete gate snapshots remain retained at those boundaries. No trading threshold was rounded or changed. Legacy download labels are replaced by a single minimal-dataset export.

Frontend and busy-scan amendment, 2026-10-08T05:53:10.772Z: replaced displayed raw research JSON, verbose skip/control diagnostics and forensic tables with eight counters and four active paired-comparison cards. One canonical download remains. Dormant AI panels and legacy research exports are hidden.

A longer live observation exposed ASYNC_QUEUE_CAP losses in the original 64-message writer queue (873 at the first frontend audit; final count will be reported). Source trading calculations remained isolated. The queue is now bounded at 1024 messages/8 MiB with 128 priority slots; native continuity updates are coalesced and full worker state cloning is limited to control boundaries. A 400-candidate burst plus priority terminal event is verified without loss. Earlier losses remain recorded; the same epoch is not falsely relabeled complete or wiped a second time.

V3 blocked-side rejections are now captured whenever they have a meaningful native candidate, to preserve current-vs-shadow eligibility comparisons. V3 configuration definitions are emitted once per hash. Both changes are observation only.
Paired comparisons also carry the durable native episode ID and native configuration hash, plus explicit missing reason if unavailable. Transient scan candidate IDs remain supplemental. A real writer integration test joins a blocked V3 decision to the exact native admission episode.
