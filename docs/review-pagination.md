# Review queues and complete audit history

Issue [#81](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/81)
implements REVIEW-02/B07 and REVIEW-03/R05. Apply forward-only migration
`017_review_pagination.sql` and run the usual runtime-role reconciliation before
starting this image. Earlier checksummed migrations are unchanged.

## Private HTTP contract

Both endpoints require an authenticated staff session. Existing write roles,
CSRF, version checks, receipt replay and public credit projections are unchanged.

| Read                                | Parameters                                                                                                              | Page response                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `GET /api/v1/admin/submissions`     | `status=pending\|reviewed`, optional `unmatched=true` for pending, `limit=1..20` (default 20), optional opaque `cursor` | `revision`, `submissions`, `pageCursor`, `nextCursor`                    |
| `GET /api/v1/admin/submissions/:id` | `limit=1..20` (default 20), optional opaque `cursor`                                                                    | `submission`, `audit`, `auditRevision`, `auditCursor`, `nextAuditCursor` |

A null next cursor means the end of that snapshot. Keep each page's current
cursor, including the first page, for previous traversal. Send it back unchanged
with the same filters, identity and page size. Do not construct or inspect
cursors in clients. Existing clients must adopt the paged detail contract;
`audit.length` now describes the current page, not the entire history.

The queue orders by native `(submitted_at DESC, id DESC)`. Its cursor retains all
six PostgreSQL timestamp fractional digits; JavaScript's millisecond projection
is insufficient for a keyset boundary. Audit pages order by native bigint
`audit_events.id DESC`, never its text response alias. Both reads seek from the
last returned key with `LIMIT page_size + 1`, without OFFSET, total-count scans
or full-ledger fingerprints. Three partial queue indexes and the per-submission
audit index support the predicates, including the sparse final history page.

## Revision and concurrency policy

Each request uses one short, read-only REPEATABLE READ transaction. A singleton
`review_state.version` advances transactionally after any submission or audit
INSERT, UPDATE, DELETE or TRUNCATE statement. This includes bot, RuneLite, manual,
reviewer and owner writes. The runtime role can read/update this counter for the
triggers; it cannot insert/delete its row. Audit and receipt grants stay
append-only. No security-definer routine is introduced.

Cursors bind that revision to the endpoint, selected submission or queue filters,
and page size. **Any committed submission/audit write invalidates every existing
review cursor**, even a write outside the visible filter/history. This deliberate
global policy costs one counter-row update per write statement and can serialize
concurrent writers briefly. No-op statements can also invalidate a cursor.
Uncommitted changes are invisible; rollback preserves the old revision. There is
no long-lived database snapshot or process-local cache. A late audit insert,
including one allocated a lower sequence ID before another transaction commits,
cannot slip into an existing traversal unnoticed.

Invalid/stale cursors return 409. Discard the cursor stack and explicitly reload
the first page; do not silently combine revisions or replay a staff write.
Schema-invalid parameters, such as a page size above 20 or cursor over 1,024
characters, return 400. Cursors from the previous implementation expire at
upgrade. They have no separate clock-based expiry.

The UI retains one audit page plus navigation cursors. Older/Newer events preserve
unsaved claim/note fields and display actor, time, reason and before/after values.
A failed/stale read preserves the displayed page and offers Reload submission;
that explicit reload replaces drafts with saved values. A 401 clears private
content; 403/503 keep the authenticated screen and offer recovery. Writes reload
the latest first history page after their acknowledged result.

## Retained limits and measurements

There is **no total queue or per-submission event cap**. The former 20,000-claim
and 5,000-event failures are removed without deleting any rows. Full receipt and
before/after JSON remain in PostgreSQL and in each returned event. Read statements
have a five-second timeout; the browser bounds a page request at ten seconds.
PostgreSQL still chooses its execution plan, so page size bounds returned rows,
not a universal physical-I/O or production-latency guarantee. The indexes avoid
work proportional to page depth; keep normal database statistics maintained.

Local PostgreSQL 17 measurements on 14 October 2026 used **60,003 claims** and
**105,001 events**, including a 5,001-event selected history and 100,000 unrelated
older events. After ANALYZE, deep queue probes at offset 19,000 (fixture setup
only) returned 21 rows using each partial index, with zero filtered rows, in
approximately **0.07–0.14 ms**. The dense audit probe returned 21 rows in **0.05
ms**; the sparse final-page probe sought `audit_submission_page`, returned one
row with zero filtered rows in **0.31 ms**, without scanning the unrelated
history. Observed shared buffer accesses were 3–48 per probe.

Including local driver round trips and JSON projection, one warmed store call
took **5.8 ms for the queue** and **4.3 ms for detail**. Queue reads use two data
SELECTs (one revision row plus at most 21 claims); detail uses three (one
submission, one revision row, at most 21 events), excluding auth and transaction
commands. These are development samples, not service-level targets. The regression
emits fresh query plans, row/buffer counts and timings into the local validation
log on every complete run.

Coverage traverses all 20,001 claims and all 5,001 events with exact identities,
including equal/sub-millisecond timestamps, revisits first/middle/last pages,
checks below/at/above both old thresholds, concurrent insert/review/audit commits,
rollback, filter/identity/page-size changes and malformed cursor anchors. Receipt
and audit counts/contents are unchanged after browsing. Chromium checks desktop
and 320px traversal, draft preservation, stale recovery and 401/403/503 reads.
Run everything with the [local acceptance command](local-testing.md).
