# Competition and schedule archival

Issue [#83](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/83)
implements REVIEW-02/B07 and REVIEW-03/R05 with migration
`019_lifecycle_archive.sql`. Deploy through the normal migration and runtime-role
provisioning path; earlier migration files remain unchanged.

## Capacity contract

| Dataset                        | Bound and behavior                                                                                                                                                                                                                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current schedules              | 500 unarchived records, including expired windows. Creating another returns 422; editing an existing current window remains available. The state reader fetches at most 501 records and returns 503 if an owner bypassed the cap.                                                             |
| Schedule membership            | At most 200 distinct pages per window. Historical detail reads at most 201 memberships and returns 503 for unsupported owner-written state.                                                                                                                                                   |
| Current competition identities | 2,000 unarchived identities shared by SKILL and ACTIVITY. New imports return 409 at capacity; refreshing an existing current identity remains available. Current activity/skill metadata reads use a 2,001-row lookahead and fail with 503 above capacity.                                    |
| All-time published XP          | 2,000 distinct contributions, **including archived competitions**. Both importers reject a new contribution with 409 at capacity, including during apply. Existing contributions can still be corrected after restoring their identity. Archival never frees an XP slot or removes earned XP. |
| Public tracker metadata        | Up to 2,000 current SKILL identities plus up to 2,000 archived identities with published XP. Totals, podium and historical event gains retain every published contribution.                                                                                                                   |
| Historical list reads          | At most 20 summaries plus one lookahead. Archived history has no total row-count cap. Receipts and other audit histories retain their separate paginated contracts.                                                                                                                           |

Archiving a selected ended schedule or competition frees one **current** slot.
Expiry alone does not archive anything. The owner command can archive an ended
record even when an unsupported extra current row has made the ordinary state
reader unavailable. Restoring checks the current cap and returns 409 if full.
At the all-time XP limit, new future metadata can use a free current identity
slot, but publishing a new contribution needs a separately reviewed capacity
increase. Do not delete previous credit or receipts to regain capacity.

## Owner operation

Use the deployed `compose.yaml` and `.env`, with the database running. The
`migrate` service supplies the owner credential; the application runtime has
read-only access to the archive journal. There is no HTTP archive write route,
automatic timer or GitHub maintenance job. Each invocation selects one ID.

```bash
# Inspect bounded current/archive pages. Default action=list, view=archived.
docker compose run --rm --no-deps migrate node packages/database/dist/lifecycle.js --resource=competitions --view=current --limit=20
docker compose run --rm --no-deps migrate node packages/database/dist/lifecycle.js --resource=competitions --view=archived --limit=20
# Reuse nextCursor unchanged, with the same resource/view/page size.
docker compose run --rm --no-deps migrate node packages/database/dist/lifecycle.js --resource=competitions --view=archived --limit=20 --cursor=PASTE_CURSOR

# Inspect complete retained source, results, XP and linked schedule evidence.
docker compose run --rm --no-deps migrate node packages/database/dist/lifecycle.js --resource=competitions --action=detail --id=123

# Dry-run is the default. Actor and reason are mandatory for either mutation.
docker compose run --rm --no-deps migrate node packages/database/dist/lifecycle.js --resource=competitions --action=archive --id=123 --actor="Operator name" --reason="Retain the ended competition"
# Review the dry-run report, then explicitly apply the same selection.
docker compose run --rm --no-deps migrate node packages/database/dist/lifecycle.js --resource=competitions --action=archive --id=123 --actor="Operator name" --reason="Retain the ended competition" --apply

# Restore explicitly before a new import/correction; also dry-run first.
docker compose run --rm --no-deps migrate node packages/database/dist/lifecycle.js --resource=competitions --action=restore --id=123 --actor="Operator name" --reason="Correct retained results"
docker compose run --rm --no-deps migrate node packages/database/dist/lifecycle.js --resource=competitions --action=restore --id=123 --actor="Operator name" --reason="Correct retained results" --apply
```

For a schedule, use `--resource=schedules` and its UUID as `--id`. The same
list/detail/archive/restore commands apply. Reports contain private source and
participant data; keep them with operational records rather than public logs.

Only `ends_at <= clock_timestamp()` is eligible for archival, including the
exact end instant. The transaction locks Scheduling, XP state, then the selected
source in the same order as import applies. It checks the deadline after waiting
for those locks, so a concurrent staff extension cannot archive a newly open
window. Statements time out after five seconds and mutation lock waits after
three seconds. Retry an interrupted or timed-out command after inspecting state.

Applying changes only the archive marker, appends an atomic journal entry with
actor/reason and complete before/after snapshots, and advances Scheduling/XP
revisions to invalidate previews. A failed journal insert rolls back everything.
A repeated operation reports `unchanged` without another journal entry. Dry-run
reports eligibility without persisting changes. Runtime grants allow SELECT on
`lifecycle_archive_audit`, with no INSERT, UPDATE or DELETE.

## Retained evidence and staff windows

Original competition/schedule rows, page memberships, activity results, exact XP
snapshots and asset references remain in place. No file is removed. Existing
schedule, competition and XP audits and durable receipts remain untouched.
Original actor/request-key receipt replay still precedes new preview and archive
validation, including after preview cleanup. A new import of an archived
competition returns 409 until the owner explicitly restores it.

Archiving a competition does not change its linked staff schedule, including a
future, running or manually extended window. Archive that schedule separately
only after it ends. Importing current metadata linked to an archived window
preserves that window and its memberships without reopening or recreating it;
the preview explains that the window is retained. Restoring a schedule preserves
its original dates: reopening it still requires an explicit staff window edit.
Database row guards reject ordinary edits/deletes of archived source, membership
and XP rows. Archive maintenance does not replace normal backups or owner access
control.

## Private historical reads

Administrators can use these `no-store` GET endpoints with the normal staff
session. Anonymous access returns 401 and moderators receive 403.

```text
GET /api/v1/admin/lifecycle/schedules?view=archived&limit=20
GET /api/v1/admin/lifecycle/competitions?view=current&limit=20
GET /api/v1/admin/lifecycle/competitions/123
GET /api/v1/admin/lifecycle/schedules/SCHEDULE_UUID
```

List responses contain `revision`, `pageCursor`, `nextCursor` and `records`.
Summaries include ID/title, original start/end and archive time. Detail is a point
lookup with the complete stored record; schedule detail includes page IDs, and
competition detail also includes its XP snapshot and linked schedule/pages.
Public activity listings omit archived identities, while the XP tracker retains
their contributions, event browsing and podium credit.

Use `nextCursor` for the next page; null means the end. Save `pageCursor` for each
visited page, including the first, for previous navigation. Cursors bind resource,
view, page size and a transactional global lifecycle revision. They are opaque
and limited to 1,024 characters. Committed source or membership statements
invalidate previous cursors; uncommitted writes remain invisible and rollback
leaves cursors valid. A stale/malformed cursor returns 409: restart from the
latest first page. Schema-invalid query parameters return 400.

Each list/detail uses a short read-only REPEATABLE READ transaction and five-second
statement timeouts. Lists seek by native UUID/bigint using partial current/archive
indexes, without OFFSET, a full-history fingerprint or a total-count query.
The 10,001-record PostgreSQL fixture traversed every record and revisited first,
middle and final pages; a deep seek returned 21 rows with zero filtered rows,
seven buffer accesses and 0.078 ms execution in the focused local run. These are
fixture measurements, not production latency guarantees. Maintain normal
database statistics.

The local acceptance suite also covers capacity boundaries, exact end/running/
future windows, concurrent archive/import/staff edits, stale previews/cursors,
receipt replay and immutable archived memberships. Production Compose smoke
exercises the owner dry-run/apply/list/detail/restore commands and runtime denial,
checking preserved totals, receipts, source and staff schedules. See
[local testing](local-testing.md).
