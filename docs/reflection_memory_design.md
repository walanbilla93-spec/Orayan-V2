# Bounded Qwen/Groq reflection memory

Feedback objects are immutable; the derived in-process index keeps the most
recent 256 linked records, reconstructed on restart. Lookup uses only shared
birth side/regime/symbol; it excludes other epochs, the same episode, outcomes
resolved at/after birth, and feedback first available at/after birth. No future
outcome or recent-response lookup affects the new birth features.

Rank by side/regime matches (2 each), symbol (1), then latest availability and
feedback id. Retrieve at most five lessons. Serialized digest including cutoff
is <=1,024 UTF-8 bytes. Full separated reflection context is <2,048 bytes
(conservative <=2,048-token bound), with digest/version id. Records contain
only structured fields and outcome categories, never raw provider text or
instructions. No automatic prompt rewrite or self-modifying weights.

Modes: QWEN_BASE, QWEN_FEEDBACK, GROQ_BASE, GROQ_FEEDBACK. Defaults preserve
exact request bytes/system prompts/schema/thresholds for both base modes.
Activation requires META_BRAIN_V1_SHADOW=true plus provider-specific
QWEN_FEEDBACK_ENABLED=true or GROQ_FEEDBACK_ENABLED=true, integer
*_FEEDBACK_PERCENT in 1..10, and *_FEEDBACK_MAX_REQUESTS_DAY in 1..20.
Unset/invalid/zero configuration stays base. Groq feedback remains off.

Deterministic cohort hash selects a bounded shadow subset; a durable per-provider
UTC-day reservation caps eligible cohorts and pins the digest for retries/restart.
The feedback context replaces the input context of the existing single call;
there is no second provider request. Existing whole-provider request/token/cost
budget logic runs after decoration and therefore includes added bytes. No paid
calls were made during development. Maximum newly reserved cohorts: 20 per
provider/day, <=40,960 conservative additional context tokens for those initial
calls; normal retry attempts remain subject to existing provider budgets and
may repeat that same context. This is not an additional spend allocation.

Memory is a separate reflection_memory member of the user envelope. Candidate
evidence/hash and system prompt remain frozen. REQUEST_PREPARED / PARSED_RESPONSE
canonical provenance includes experiment mode, digest id and version; exact
request audit retains the full separated context. Feedback records retain arm
provenance of included decisions.

This is budgeted shadow-subset infrastructure, not a validated paired efficacy
experiment. Missing-lesson eligibility, quota censoring, provider retries and
time effects prevent naive BASE-versus-FEEDBACK causal comparisons. Sol High
must register analysis eligibility, assignment/dispatch censor records and
cost policy before activation. No feedback mode was enabled in production.
