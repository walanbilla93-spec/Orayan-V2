# Meta Brain decision-first epoch

This isolated research image has no execution interfaces or Orayan database connection. Orayan is consumed only through its existing authenticated GET canonical export; the adapter validates the bundle and retains selected candidate, lifecycle, advisory and experiment evidence. No Orayan configuration or trading code is changed.

The frozen volatility/two-sided-risk model is unchanged. The independent structural-direction baseline is a registered, unvalidated experiment using confirmed structures from public completed OHLC. Confidence is explicitly uncalibrated. It abstains with stale/missing inputs; working market coverage is BTC plus at most three current candidate symbols. Other source episodes remain observable with explicit independent abstentions. No online weights change and nothing feeds back to Orayan.

## Canonical evidence

Nine allowlisted streams: definitions, orayan_signal_observed, meta_decision, decision_comparison, lifecycle_outcome, loss_attribution, lesson, integrity and registered_experiment. Decision snapshots freeze actual inputs, feature hashes, freshness/availability clocks, model and policy lineage, exact bounded historical-summary versions and reasons. Lifecycle records join exact immutable source decision references. Active trade versions are pinned in bounded episode state. Historical/outcome-known signals never receive retroactive predictions. Loss attribution preserves causal evidence and uncertainty; insufficient evidence remains unknown/ambiguous. Counterfactual, paper/live and experimental outcomes remain separate statistical families.

Seven compact PostgreSQL tables hold events, bounded state, immutable daily archives and externalization receipts, bounded performance buckets, resolution deduplication and bounded pending joins. Raw ticks/depth are neither subscribed nor persistently recorded. Completed OHLC and auxiliary data live in bounded rings; only a recent restart/label checkpoint persists. Expired/unrecoverable labels receive explicit censors.

## Downloads and retention

Daily ZIP ownership follows actual observation time in Asia/Colombo. The first maintenance cycle after midnight publishes the completed day, verifies CRC, counts and entry/event hashes, and thereafter returns identical bytes. Manifests include schema/epoch/model/build/provider lineage, coverage, dependencies and integrity records. SHA-256 for the complete ZIP is supplied separately in status/download headers and external sidecars.

The current endpoint generates the exact most recent 30 hours from canonical hot rows plus overlapping daily material, deduplicating immutable event identities. Hot evidence is compacted only after verified daily publication. At most seven completed daily ZIPs remain on-service. Removal requires the independently verified external-copy receipt matching the archive hash; absence pauses capture instead of deleting the only copy. Local backups are retained outside the production database without a seven-day deletion policy. If the computer is unavailable for an extended period, retention fails closed; the local receiver can recover only that specific retention pause after successful copying.

Read/download endpoints: `/research`, `/research/api/status`, `/research/api/current.zip`, `/research/api/daily/{date}.zip`, `/research/api/reset-receipt`. Protected acknowledgement/resume POSTs use `META_ARCHIVE_ACK_TOKEN`, falling back to the existing `RESEARCH_ACCESS_TOKEN`; public download configuration never authorizes writes. Orayan tokens use `ORAYAN_GROQ_EXPORT_TOKEN` and `ORAYAN_ALIBABA_EXPORT_TOKEN`. No credentials belong in source or artifacts.

## Migration gate

The historical launcher is the paused, read-only export image. `reset_epoch.py` is a separate explicit operation: require complete off-volume verification inventory, compare the frozen source watermark and exact five-table population, reject unexpected objects/files, and take exclusive locks. Legacy deletion, compact schema creation and the durable reset/boot receipt commit atomically. The new launcher refuses an unverified receipt, mismatched build hashes or remaining legacy store. Initial capture stays paused until the controlled epoch/preflight resume request.

Qualification covers immutable snapshots, clocks/no leakage, exact and pinned outcome joins, loss uncertainty, idempotency, source projection/hash validation, current deduplication, Colombo boundaries, external-copy retention gates, protected API mutations and PostgreSQL DDL rollback. Synthetic memory qualification and observed production resource/storage measurements must be reported separately.

Official public-market pagination limits: [open interest](https://bybit-exchange.github.io/docs/v5/market/open-interest), [long/short ratio](https://bybit-exchange.github.io/docs/v5/market/long-short-ratio), [premium OHLC](https://bybit-exchange.github.io/docs/v5/market/premium-index-kline). Only the fixed public market endpoint allowlist is callable.
