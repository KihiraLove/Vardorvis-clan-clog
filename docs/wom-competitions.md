# Wise Old Man competition imports

Import a `https://wiseoldman.net/competitions/<id>` link from **Scheduling** or
**XP imports**. Staff must choose **SKILL** or **ACTIVITY**; WOM does not provide
this application flag. Each WOM ID has one persisted identity, and its kind and
supported metric scope cannot be changed by importing a duplicate. A mismatched
kind or changed scope requires staff reconciliation instead of silently changing
the ledger. Both roles can import ACTIVITY competitions and prepare SKILL
schedules. Only administrators can import finished SKILL results.

The [official competition API](https://docs.wiseoldman.net/api/competitions/competition-endpoints)
returns all participants in the details response. Its bulk metrics override
provides individual skill deltas for overall competitions. The supported integer
boss/activity metrics follow the
[official metric definitions](https://docs.wiseoldman.net/api/global-type-definitions).
Computed EHP/EHB and mixed or weighted activity scopes are unsupported. SKILL
supports any nonempty subset of the supported skills; overall expands to all
skills, without adding the aggregate/weighted total again.

## Lifecycle and schedules

PostgreSQL's clock is authoritative. A competition is future before its start,
running from its start until its end, and finished at or after its end.

| Source state | Persisted import                                       | Opening schedule                  |
| ------------ | ------------------------------------------------------ | --------------------------------- |
| Future       | Link, title, explicit kind, metrics and original dates | Source start to source end        |
| Running      | The same minimal metadata                              | Database apply time to source end |
| Finished     | Metadata plus validated, filtered final results        | None created                      |

Future/running responses may contain live participant rows, but the importer
discards those fields immediately. No live roster, gains, upstream update
snapshot or full source response enters preview storage, audit values, receipts
or result tables. Source start is retained separately from a running schedule's
effective opening start. Imports never enable the scheduling switch.

Boss/activity mappings use current page IDs, including shared Wilderness boss
pages, Dagannoth Kings, raid variants and the corrected clue taxonomy. Proposed
pages are validated against active catalog pages and visible in the preview.
Staff can correct them; changing pages requires an updated preview. Skills and
ambiguous metrics such as collections logged require explicit page selections.
No import silently opens all pages. Existing overlapping windows and the
**any associated active page open** rule remain in force.

Re-importing a linked competition preserves the existing window and any staff
edits. Deleting it leaves a persistent marker: importing again preserves the
deletion. Staff can create a manual replacement through Scheduling. Final
results can be imported after the competition ends without recreating a window.
If a metadata-only preview reaches the end before apply, the API returns 409;
fetch a fresh preview containing final results. A future preview that becomes
running can apply with an immediate opening start.

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

`POST /api/v1/admin/competitions/preview` takes `{competitionUrl,kind,pageIds?}`.
It returns a ten-minute actor-bound token, XP and schedule revisions, original
dates, lifecycle, proposed/selected pages, effective start, exact action and
filtered finished results when applicable.

`POST /api/v1/admin/competitions/imports` takes
`{previewToken,expectedRevision,scheduleRevision,acknowledgeCorrections?}` with a
UUID `Idempotency-Key`. Both routes require a staff session, configured Origin
and CSRF token. Apply checks the current role, clock, preview expiry and both
revisions. Receipt retries survive expiry/restarts; changing a request under the
same key returns 409. Every import is audited, including unchanged imports.

The established legacy XP routes remain administrator-only, require an explicit
`kind: "SKILL"` preview field, accept finished results only and write the same
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
