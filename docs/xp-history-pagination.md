# XP import history pagination

Issue [#82](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/82)
addresses REVIEW-02/B07 and REVIEW-03/R05. Migration
`018_xp_history_pagination.sql` removes the 2,000-receipt history outage through
bounded SQL reads. Existing migration SQL and stored receipts remain unchanged.
Deploy through the normal migrator/runtime-role provisioning path.

## Private contract and navigation

`GET /api/v1/admin/xp/imports` requires an administrator or moderator session;
anonymous clients cannot read history. Responses remain private
and `no-store`. Optional query parameters are `limit=1..20` (default 20) and an
opaque `cursor` of at most 1,024 characters. The response is:

```json
{
  "revision": "xp-history-7",
  "pageCursor": "opaque-current-page-token",
  "nextCursor": "opaque-next-page-token-or-null",
  "imports": []
}
```

`nextCursor` is null at the end, not a string containing null. Each import keeps
its ID, competition ID, title, actor, import timestamp, applied/unchanged outcome
and complete exact `changes` array. Before/after/delta values remain decimal
strings, including values larger than JavaScript's safe integer range. Private
request keys, token hashes and internal receipt fields are not added to the wire
projection.

Save `pageCursor` for every visited page, including the first, and send it back
unchanged for previous navigation. Clients must use the same page size. The XP
screen prepares only the first page before navigation, then browses one page at
a time with Older/Newer imports. It labels the displayed count as a page count,
shows receipt identity, actor/outcome and exact before/after/delta values, and
keeps the competition import form and its draft mounted while paging. Preview
mode follows the same page, revision and access contract.

## Transactional revision policy

Each page reads `xp_state.history_version` and at most 21 history rows in one
short read-only REPEATABLE READ transaction. The existing
`xp_history_latest(imported_at DESC,id DESC)` index supports native timestamp/UUID
keyset seeks. Cursors retain all six PostgreSQL timestamp fractional digits, so
ties and sub-millisecond differences neither duplicate nor omit receipts. There
is no OFFSET, full-ledger fingerprint or count query in the production read.

The new history revision advances transactionally after every
`xp_import_history` INSERT, UPDATE, DELETE or TRUNCATE statement, including owner
writes and both the legacy and competition importers. Crucially, **unchanged
imports advance history without advancing the public XP tracker revision**.
Their durable requests remain recorded even though the total contribution stays
the same. Runtime access to the history table remains SELECT/INSERT only; the
trigger uses the existing UPDATE grant on `xp_state`. No new table grants or
security-definer functions are introduced.

A cursor binds the history revision, page size and exact last key. Any committed
history write invalidates all existing cursors, including the first-page token.
Uncommitted inserts are invisible to readers; rollback leaves a cursor valid.
No long-lived transaction, application cache, wall-clock expiry or maximum
history length is required. New receipts are never silently spliced into an old
traversal. Invalid/stale cursors return 409; schema-invalid parameters return 400. Explicitly retry from the latest first page after a conflict.

Failed page reads clear private history rows and disable paging. Retry XP history
starts a fresh traversal. A 401 revokes the shared admin session and removes
private content; 403 preserves the authenticated import screen with denied-read
guidance. Network errors and the ten-second browser timeout also settle into an
explicit retry state, and canceled/late responses cannot restore old rows. A
successful import reloads the latest first history page after its acknowledged
result. It does not replay a write while recovering a read.

## Retention, limits and measured cost

Pagination never rewrites or deletes receipts, including unchanged imports.
Their actor/request-key lookup still precedes preview validation, so replay works
after expiry or owner maintenance deletes a preview and after history exceeds
2,000 rows. Exact original outcomes/revisions remain replayable across process
restarts. Existing append-only grants remain enforced.

This change removes the **receipt-count** cap. The separate capacity contract is
2,000 current competition identities and 2,000 all-time published XP contributions.
[Competition and schedule archival](lifecycle-archive.md) frees current identity
slots while retaining every XP contribution, receipt and historical result.
Each page statement has a five-second timeout. Two data SELECTs return at most
22 rows in total: one revision plus 21 receipts for a 20-row page. Authorization
and transaction commands are additional fixed work. PostgreSQL chooses its plan,
so the page limit bounds returned rows, not arbitrary physical I/O; maintain
normal database statistics.

Local PostgreSQL 17 measurements on 14 October 2026 compared **2,001** and
**50,001** receipts. First, deep and final-page probes all sought
`xp_history_latest`, returned 21/21/1 rows, removed zero rows by filtering, and
accessed 3–6 shared buffers. Execution took **0.045–0.119 ms**. Full local store
reads, including driver round trips and projection, took **3.3 ms** and **5.4 ms**
respectively. These development samples are not service-level guarantees; the
integration test emits fresh plans, row/buffer counts and timings on every run.

Tests traverse all rows across the 1,999/2,000/2,001 boundary, revisit first,
middle and final pages, exercise timestamp ties and fractional precision,
concurrent unchanged imports, in-flight commit/rollback and malformed cursors,
and verify applied/unchanged receipts replay after preview deletion above the
old cap. Desktop/320px Chromium tests cover exact values, traversal, import-draft
preservation, concurrent appends, 401/403/503, timeout and late responses. Run the
[complete local acceptance command](local-testing.md) before pushing.
