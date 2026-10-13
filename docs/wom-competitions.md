# Wise Old Man competition imports

Import a `https://wiseoldman.net/competitions/<id>` link from **Scheduling** or
**XP imports**. The server derives **SKILL** or **ACTIVITY** from canonical WOM
metric metadata and returns the detected kind in the preview. Both forms need
only the competition link; neither has a kind selector. Each WOM ID has one persisted identity, and its kind and
supported metric scope cannot be changed by importing a duplicate. A mismatched
kind or changed scope requires staff reconciliation instead of silently changing
the ledger. Both roles can import ACTIVITY competitions and save future/running
SKILL metadata. Only administrators can import finished SKILL results.

The [official competition API](https://docs.wiseoldman.net/api/competitions/competition-endpoints)
returns all participants in the details response. Its bulk metrics override
provides individual skill deltas for overall competitions. The supported integer
boss/activity metrics follow the
[official metric definitions](https://docs.wiseoldman.net/api/global-type-definitions).
Computed EHP/EHB, unknown metrics, mixed skill/activity or aggregate-overlap
scopes, multiple activities and weighted activity scopes are explicitly rejected.
SKILL supports any nonempty subset of the 24 skills in
[the shared domain registry](../packages/domain/src/skills.ts); `overall` and
`total` expand to all skills. Classification precedes result validation, so a
missing result never changes a SKILL event into ACTIVITY. Finished skill imports
fetch one complete per-skill batch, preserving exact integer contributions
without adding the aggregate/weighted total again. The registry supplies display
order, names and icon filenames to API/web, including `runecrafting` → `runecraft.png`.

## Lifecycle and schedules

PostgreSQL's clock is authoritative. A competition is future before its start,
running from its start until its end, and finished at or after its end.

| Kind     | Source state   | Persisted import                                       | Opening schedule                       |
| -------- | -------------- | ------------------------------------------------------ | -------------------------------------- |
| SKILL    | Future/running | Link, title, detected kind, metrics and original dates | None created; `import-metadata` action |
| ACTIVITY | Future         | The same minimal metadata                              | Source start to source end             |
| ACTIVITY | Running        | The same minimal metadata                              | Database apply time to source end      |
| Either   | Finished       | Metadata plus validated, filtered final results        | None created                           |

SKILL previews contain no opening time, selectable pages, page links, participants
or XP changes. Apply persists a new SKILL identity with `scheduleId=null` and
does not change scheduling state, its revision or enforcement. Both import
screens hide page selection for SKILL. Supplying nonempty SKILL `pageIds` is
rejected with 422; older stored page-opening previews require a fresh preview.

Future/running responses may contain live participant rows, but the importer
discards those fields immediately. No live roster, gains, upstream update
snapshot or full source response enters preview storage, audit values, receipts
or result tables. Source start is retained separately from a running schedule's
effective opening start. Imports never enable the scheduling switch.

Boss/activity mappings use current page IDs, including shared Wilderness boss
pages, Dagannoth Kings, raid variants and the corrected clue taxonomy. Proposed
pages are validated against active catalog pages and visible in the preview.
Staff can correct them; changing pages requires an updated preview. Ambiguous
ACTIVITY metrics such as collections logged require explicit page selections.
No import silently opens all pages. Existing overlapping windows and the
**any associated active page open** rule remain in force.

Re-importing a linked competition preserves the existing window and any staff
edits. Deleting it leaves a persistent marker: importing again preserves the
deletion. Staff can create a manual replacement through Scheduling. Final
results can be imported after the competition ends without recreating a window.
If a metadata-only preview reaches the end before apply, the API returns 409;
fetch a fresh preview containing final results. A future preview that becomes
running remains metadata-only for SKILL; ACTIVITY can apply with an immediate
opening start. Successful receipt replay remains valid after expiry or the end
boundary and never creates another window or credits XP twice.

Older SKILL imports may already link to staff-edited opening windows. Metadata
and finished-results refreshes preserve those windows and deletion markers;
the preview warns staff to manage an existing window through Scheduling.
Do not automatically unlink or delete them. Review the linked window and its
audit history with staff before any intentional removal. This change needs no
database migration: migration 014 already allows null schedule links and remains
immutable.

## Finished results and public display

All relevant gains must be available exact nonnegative integers. Invalid,
missing, partial, duplicate or imprecise results reject the preview and preserve
stored data. Zero-sum skill participants and zero-score activity participants
are discarded only after validating the complete source roster. A skill player
with one positive contribution retains all individual skill contributions,
including their other zeroes. Refreshing replaces the same competition's
contribution. Negative XP corrections require acknowledgement.

The homepage keeps its five collection-log tabs. The ACTIVITY viewer on the
left lists stored metadata in descending source end order, with source ID
descending as a stable tie-break. Smaller local start/end labels are red for
finished, green for running and yellow for future, with a text status. UTC times
are available on each time label. Links open the canonical WOM page. The viewer
advances status locally using the server clock offset and polls for new metadata.
On narrow screens it sits above the log with a horizontally scrollable list.

The XP tracker includes SKILL only. Future/running entries show unavailable gains
and an empty podium; site totals include stored results only. Podiums rank the
sum of relevant skill gains with exact integer arithmetic, then stable WOM player
ID ascending for ties. Total groups that sum across imported SKILL competitions
by WOM player ID and uses the latest successful imported name snapshot. Up to
three positive players appear in 2–1–3 order; empty/one/two-player states do not
invent competitors. Only this top-three projection is public, never full rosters.
Distinct overlapping competitions still count their reported XP independently.

[Desktop preview](wom-competitions-desktop.png) and
[mobile preview](wom-competitions-mobile.png) show the activity viewer and podium.

## API and transactions

`GET /api/v1/competitions/activities` returns `{serverNow,competitions}` with
ACTIVITY metadata only. `GET /api/v1/xp/tracker` retains its single repeatable-read
snapshot, revision and ETag, adding a Total `podium` and an event `podium`.

`POST /api/v1/admin/competitions/preview` takes `{competitionUrl,pageIds?}`.
An optional legacy `kind` is checked against WOM metadata and a mismatch is
rejected; it never authorizes XP writes. Finished SKILL previews and applies
require an administrator even if the caller supplies `kind: "ACTIVITY"`.
It returns a ten-minute actor-bound token, XP and schedule revisions, original
dates, lifecycle, proposed/selected pages, effective start, exact action and
filtered finished results when applicable.

`POST /api/v1/admin/competitions/imports` takes
`{previewToken,expectedRevision,scheduleRevision,acknowledgeCorrections?}` with a
UUID `Idempotency-Key`. Both routes require a staff session, configured Origin
and CSRF token. Apply checks the current role, clock, preview expiry and both
revisions. Receipt retries survive expiry/restarts; changing a request under the
same key returns 409. Every import is audited, including unchanged imports.

The established legacy XP routes remain administrator-only, accept an optional
checked `kind: "SKILL"` preview hint, accept finished results only and write the same
registry identity. The shared form uses the new routes. Schedule enforcement
and audit lock ordering are unchanged: scheduling settings precede XP state,
competition identity and page locks. Results, metadata, schedules, revisions,
audits and durable receipts commit together; an audit failure rolls everything
back. Competition capacity is 2,000; schedule capacity remains 500.

## Upgrade and recovery

Apply [migration 014](../packages/database/migrations/014_wom_competitions.sql)
after scheduling migration 013 and rerun runtime-role bootstrap. Existing XP
rows become SKILL registry entries without changing their gains, identities,
snapshots or history. Their foreign keys enforce the common identity and SKILL
isolation. Legacy live previews are invalidated. New competition import history
is append-only for the runtime role. No secrets, volumes or cron jobs are added.

Take a coordinated database and image-volume backup first. Older images cannot
write new XP rows without the new registry identity; recovery to an older image
requires its matching pre-014 backup. Do not edit applied migrations or delete
result/history rows to work around an upgrade. The public viewer uses local
stored data; real imports remain subject to WOM availability and rate limits,
and finished results are refreshed by an explicit staff action.
