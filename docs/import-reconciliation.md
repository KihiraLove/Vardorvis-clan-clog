# Import reconciliation and correction evidence

`ImportReconciliation` is the single service for legacy XP and unified WOM
competition imports. It owns canonical scope and identity validation, capacity,
preview storage, exact integer diffs, correction acknowledgement, schedule
actions, results, revisions, append-only audits and durable receipts. The skill
registry and metric classification remain authoritative in `@clog/domain`.
`PgCompetitionStore` is its compatibility export; `PgXpStore` keeps XP read
projections and adapts the legacy preview/receipt shape to the same service.

## Compatibility and callers

The browser's shared import form uses the competition endpoints through
`apps/web/src/competition-api.ts`. The XP endpoints and
`apps/web/src/xp-api.ts` remain supported compatibility contracts; the web client,
route tests, database acceptance, production smoke and workload fixtures still
reference them. There is no evidence that every external caller has migrated.
Do not remove these routes or their `xp_previews`/`xp_import_history` storage.

Legacy requests remain administrator-only and finished-SKILL-only, return
`{outcome,revision}`, and require only the XP revision. Unified requests also
bind the schedule revision and return `scheduleId`. Both use ten-minute,
actor-bound previews. Their existing token tables and durable receipt formats
remain readable, including pre-refactor XP-only receipts. Replays validate the
original payload before checking preview expiry; physical preview removal does
not erase a committed result. Changed requests using a reserved actor/key return 409. Current roles still apply to unified receipt replay.

Both apply paths lock scheduling settings, then XP state, then preview/identity
and selected pages. The state locks serialize identity creation, final capacity
slots, stale previews and repeated keys. All result writes and receipts use one
READ COMMITTED transaction; previews use REPEATABLE READ. No automatic write
retry is introduced. A lost COMMIT acknowledgement remains uncertain to the
caller: retry the exact original request/key to recover its durable receipt.
Future/running SKILL metadata never creates or edits a page schedule. Negative
XP corrections require explicit acknowledgement; activity counts remain exact,
nonnegative source values and may be corrected downward without that XP flag.

## Activity evidence retention

Each new activity import stores complete normalized result arrays in the
existing append-only `competition_import_history` JSON audit. `old_values`
contains the prior `activityResults` (or null before results existed);
`new_values.activityResults` contains the applied array, including stable player
IDs, imported names and exact decimal strings. `resultsEvidenceVersion: 1`
identifies this evidence contract. Empty arrays mean a finished zero-result
import; null means no final results. Unchanged imports also retain both sides.
The receipt, actor, competition identity, metadata, lifecycle and revisions are
stored in the same transaction. An evidence insert failure rolls back the
result overwrite and receipt together.

Retain these records for the lifetime of the competition, including after
archive; do not prune them with expiring previews. The runtime role can SELECT
and INSERT history but cannot UPDATE or DELETE it. Coordinated database backups
include the entire history. No schema or grant change is needed: the existing
JSON audit and reviewed append-only privileges support this extension.

An operator can reconstruct every correction made by this version by ordering
its audit records by resulting XP revision and reading both result arrays.
The first correction also captures the currently stored pre-upgrade results.
Older overwritten results absent from historical audits cannot be recovered
retroactively; their available metadata remains intact. Do not imply this code
backfills missing history.

Full result rosters and correction evidence are private database/audit data.
Public activity endpoints continue to return metadata only; public XP endpoints
expose aggregates and limited podium projections. Raw WOM responses, preview
tokens and authentication secrets are never added to correction evidence.

## Acceptance

`import-reconciliation.integration.test.ts` runs against disposable PostgreSQL:
old/new HTTP contract and preview/receipt parity; exact large totals, unchanged/incremental/
negative corrections; cross-route races and key conflicts; current-role replay;
lost commit acknowledgement and removed previews; successive activity result
reconstruction, concurrent replay and audit-failure rollback. Existing XP,
competition, metadata/page-free SKILL and route authorization suites remain
required. Run the complete local gate with `node scripts/check-local.mjs`.
