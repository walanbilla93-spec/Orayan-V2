# Marci observation retirement V1

This is an additive observational censor, not a CLOSED/CANCELLED/EXPIRED trade
or a win/loss. Original ledger bytes and canonical episodes remain unchanged.
The immutable receipt records cutoff, epoch, reviewed implementation commit,
whole-ledger byte checksum, each frozen obligation and exact episode/index
fingerprints. Only exclusively Marci canonical chains proven by checksummed
raw records qualify. Mixed, missing or ambiguous ownership remains unresolved.

Maintenance reports retired rows/episodes separately, subtracting only exact
receipt matches from active obligations. Native, V3, provider, legacy and
uncovered canonical obligations continue to block full sealing. Receipt damage,
changed history, episode mutation, changed event manifests or an epoch mismatch
restore conservative accounting and block sealing. Runtime retirement never
implies successful trade resolution; no strategy outcome is rewritten.

Publication is explicit and authenticated through both existing maintenance
credentials: POST /api/maintenance/marci-retirement with implementation_commit
equal to the exact reviewed deployment SHA. This requires a drained research
seal with fullSealed=false. The canonical watermark must remain stable during
the ownership audit. Publication invalidates the prior seal before writing;
reseal with maintenance enter retry=true, then request full sealing. Missing
provenance is a blocker, not permission to broaden the censor.

The receipt is written once to data/marci-retirement-v1.json, with fsync and
Linux directory fsync. A partial write remains visible and fails closed; no
automatic replacement or deletion. GET /api/maintenance/marci-retirement
exports the complete receipt with the same authorization. Include this receipt,
the byte-identical Marci ledger and canonical source archives in every external
retirement evidence package; the separate receipt is not embedded in canonical
ZIPs. Full volume snapshots include it. Restart reconstructs accounting from
those immutable sources. Native epoch identifiers and trading behavior do not
change. Do not publish a receipt on the old Marci-producing build.

Rollback to a Marci-producing build requires treating any subsequent Marci
mutation as a new observation period. This version will reject the old receipt
on changed bytes; it never silently extends the cutoff. Do not discard or
overwrite the original receipt to make the gate pass.
