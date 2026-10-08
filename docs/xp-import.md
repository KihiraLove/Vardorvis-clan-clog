# XP-01: Durable Wise Old Man event imports

Issue [XP-01 #27](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/27) introduces a **server-backed aggregate event tracker**. Public display is the owner's revised SOTW/BOTW mockup: one skill or all 24 skill gains per event, not the superseded per-member XP table. [WOM documentation](https://docs.wiseoldman.net/api/competitions/competition-endpoints) defines the per-participant `deltas[].values.gained` fields and the bulk `metrics` override.

## Public endpoint

`GET /api/v1/xp/tracker` returns `{revision,totals,events}` as a **single PostgreSQL repeatable-read snapshot**. `totals` includes exactly all 24 supported skills with decimal-string integer amounts, initially zero. Each event has `id`, `title`, `sourceUrl`, `skills` (one or all 24), and `gains` keyed by the event skills. No private player records, admin identities, preview tokens, or history are public. `ETag` and conditional 304 responses allow the frontend to poll without silently advancing an inconsistent cache.

Changes to player identities/names/source rows trigger a version increment even if the sum remains the same. The import totals are **competition gains**, not all-time HiScores XP. Overlapping events are intentionally added separately and identified as a possible overlap in the preview warning.

## Admin import

Admin routes require the existing allowlisted Discord OAuth session. Preview/apply POST requires matching `Origin` and the session-derived `X-CSRF-Token`. The following routes do not accept unauthenticated or bot-token access:

- `POST /api/v1/admin/xp/imports/preview` with `{"competitionUrl":"https://wiseoldman.net/competitions/1001"}`. This validates the input host/protocol/ID, then fetches **only** `https://api.wiseoldman.net/v2/competitions/:id`. For all-skill/overall events, one additional **bulk** `metrics` query collects the explicit individual skill deltas, never weighted `total`. Fuzzy/missing/sentinel, partial rosters, non-XP metrics, unsupported partial multi-skill scopes and imprecise numbers reject the preview without updating prior XP.
- `POST /api/v1/admin/xp/imports` with `{previewToken,expectedRevision,acknowledgeCorrections}` plus a random UUID `Idempotency-Key` header. Only an unexpired server-generated preview bound to the same administrator may be applied. Negative corrections require explicit acknowledgement. A repeated *identical* key returns the same committed receipt even after preview expiry; reused keys with modified parameters return 409. Other stale preview revisions return 409.
- `GET /api/v1/admin/xp/imports` returns private import history with server-recorded admin display names, UTC times, outcomes and before/after/delta values. The frontend refreshes history after applying.

An unchanged source snapshot records a history entry and adds zero XP. A changed/renamed participant or gain increments the tracker revision, replacing that competition's previous contribution in one transaction (new-minus-old). Removing an event's previous scope (single skill versus all skills) is rejected pending manual reconciliation rather than silently losing credit. Null/unavailable delta rows **do not become zero**. Source failures and rate limits do not mutate existing aggregates.

## Storage and operations

Forward-only migration `005_xp_events.sql` adds `xp_state`, `xp_events`, `xp_previews` and `xp_import_history`, independent of submission-specific audit tables. PostgreSQL serializes applies by locking the singleton revision; imports/updates/history commit atomically. Preview TTL is 10 minutes; only token hashes are stored in the database. Expired preview storage can be periodically purged by an operator. Stored snapshots retain private WOM participant IDs solely for discrepancy detection/auditing.

`npm run validate` exercises WOM schemas, exact >53-bit XP string handling, all-skill totals, missing data, public ETags and private-route authorization. `TEST_DATABASE_URL` enables a disposable PostgreSQL test covering concurrent retry, unchanged/incremental/corrected refresh, stale version rejection, history and projection invalidation. CI provides this database. No live WOM/Discord integration tests occur in CI; source fetches are simulated. The public site never contacts WOM.

## Deployment limitations

A real WOM API call is subject to the provider's availability and rate limits. Imports are explicitly admin-initiated and are never automatically refreshed on page load. The backend does not mutate WOM player snapshots or attempt to refresh WOM's upstream competition; it imports currently available source deltas. An unavailable/partial source is rejected, leaving the last committed tracker visible.
