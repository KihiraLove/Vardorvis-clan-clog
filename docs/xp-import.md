# XP imports and projections

The lifecycle, source validation, role boundaries, common registry, schedule
rules and upgrade procedure are documented in [WOM competition imports](wom-competitions.md).
This supersedes the earlier XP-01-only import flow from [issue #27](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/27).

`GET /api/v1/xp/tracker` is one PostgreSQL repeatable-read snapshot with a revision
and ETag. It returns exact decimal-string skill totals, SKILL event metadata and
gains, the top-three Total podium, and each event's top-three podium. Full player
rosters, staff identities, tokens and import history remain private. Metadata-only
SKILL events have unavailable gains and no podium. ACTIVITY never enters XP.

Finished SKILL contributions use stable WOM player IDs and individual skill
amounts. A refresh replaces that competition's prior snapshot; unchanged or
retried imports cannot add XP twice. Overall expands into the supported skill
deltas without counting the aggregate total. Zero-sum participants are discarded;
unavailable data rejects the import. Overlapping competitions count independent
reported contributions, rather than deduplicated lifetime gains.

The shared preview/apply form is available from Scheduling and XP imports.
Future/running SKILL imports use `import-metadata`, persist their original dates
without a schedule, and appear publicly with unavailable gains and an empty
podium. Moderators can apply these imports. Crossing the source end requires a
fresh finished-results preview; future-to-running apply stays metadata-only.
Existing linked staff windows are preserved for reviewed management in Scheduling.
Administrators and moderators can import finished XP results and view history. Legacy
`/api/v1/admin/xp/imports/preview` and `/api/v1/admin/xp/imports` remain available
for finished SKILL imports, with the existing session, Origin, CSRF, optimistic
revision, correction acknowledgement and UUID request-key contracts. Legacy
preview payloads need only `competitionUrl`; an optional `kind: "SKILL"` hint
remains compatible with older clients, while WOM scope validation and the
staff authorization stay authoritative. Private history is available at
`GET /api/v1/admin/xp/imports`.

Migration 014 backfills all existing XP identities as SKILL and preserves the
ledger, source snapshots and immutable history. New imports share its registry
and enforce SKILL through a composite foreign key. Runtime-role bootstrap must
be rerun after migration. Take a coordinated backup before upgrading; older
images require their matching pre-upgrade database for XP writes.

Validation covers exact large gains, filtered zeros, multi-skill and overall
breakdowns, complete source rosters, deterministic podium ties, reconciled
refreshes, durable retries, stale/time-boundary previews, atomic rollback,
metadata-only storage, authorization and shared-page scheduling. CI uses a
disposable PostgreSQL database and controlled WOM fixtures, never production
clan data. Public renders never fetch WOM.
