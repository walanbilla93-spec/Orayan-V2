# Capture verification amendment

Created 2026-10-08T02:16:30.782Z, after the authorized first reset and before the final capture-only rollout. The frozen pre-reset plan and schema have not been rewritten.

Live measurement found 96,111 bytes of candidate growth over approximately 161 seconds during a no-main-trade period. The initial trigger still treated changing quote geometry as a rejected-candidate refresh. That extrapolated to roughly 49 MiB/day and would hit the initial 10 MiB cap; it was unsuitable for the requested minimal dataset.

Final trigger: first candidate; first observation of a new strategy bar; change in admission, enabled gate pass states or rejection reason; exact current frozen features at ORDER_INTENT. NO_ORDER with the same source episode and reason is recorded once. Disabled-gate details, including unused funding values, are dropped. These changes only alter capture, not gate calculations or execution.

The emergency daily cap is 20 MiB (4 MiB reserved for lifecycle/arms/health), instead of the planning cap 10 MiB. This allows necessary decision transitions while bounding an error loop. The 256 MiB space limit rotates complete old segments with explicit retained/pruned counters; 180 days is the maximum age. Missing/truncated segments make completeness false. Tiny durable trade-ID counter keys prevent repeated funding/fill updates from double-counting and distinguish inherited outcomes.

Same clean epoch continues through this code-only restart; no second telemetry wipe is planned. The first reset receipt remains authoritative. Revised daily volume must be measured after rollout, not inferred from the original 2.8 MiB/day planning scenario.
