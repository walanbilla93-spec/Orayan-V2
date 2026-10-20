# Meta Brain V1 optional evidence persistence and recovery

This namespace is observational. It does not mutate native trades or influence
execution. The learner and both provider feedback flags remain disabled.

## Close feedback obligations

The first store open publishes an immutable activation timestamp. On startup
and on health reads, the optional store checks persisted `trades.json` for
closed native PAPER trades. A close is in scope when its frozen birth evidence
exists, or it closed after activation. An absent feedback record produces an
immutable gap receipt with the trade ID, close time, epoch, opportunity (if
known), and a hash of the canonical close identity. No feedback is generated
from a restart scan. Missing birth evidence produces an explicit gap. Health
is `DEGRADED` while any gap lacks a matching valid feedback record; storage or
evidence corruption fails the optional module closed. A later valid feedback
record resolves the gap without deleting either record.

The reconciliation source is the retained canonical `trades.json` snapshot.
Older trades outside the activation boundary without Meta Brain birth evidence
are not retrospectively claimed as feedback obligations. A corrupt canonical
trade snapshot fails the optional module closed. Retained history and any
capture/archive completeness limits remain separately governed by their
existing systems.

## Provider experiment assignment

The route file is read before current lesson eligibility or quota. It pins
the experiment version, provider, day, cohort, source identity, BASE or
FEEDBACK arm, original request hash, and (for FEEDBACK) the digest and lesson
IDs. Both arms are persisted before dispatch. A retry in BASE returns the
original request object. A retry in FEEDBACK reconstructs the same decoration
from the pinned digest and requires the same base request and identity. Missing
or inconsistent inputs publish a censor receipt and block the optional path;
they cannot turn an assigned FEEDBACK request into BASE. No additional provider
call is introduced.

## Publication, validation, and export

Every evidence kind uses an exclusive staged file, file fsync, rename to its
final name, and directory fsync where supported. A stranded stage is retained
and makes startup fail closed; it is not auto-deleted or silently promoted.
Startup validates every final file's canonical JSON, kind schema, and
filename/identity hash. Invalid files are preserved for review. Export
revalidates from disk before streaming and refuses an invalid namespace. Its
first NDJSON row is a compact manifest with record count, kind counts, and an
ordered name/content SHA-256 summary. It is followed only by validated final
records.

## Rollback

Keep this PR draft until re-review. If a later deployment is rolled back,
redeploy the prior Orayan build without restoring an older data volume over
newer evidence. Preserve the optional evidence directory, gap/censor receipts,
native trade history, and all capture archives. Leave learner and provider
feedback flags disabled. No production rollback is needed for this review-only
branch.
