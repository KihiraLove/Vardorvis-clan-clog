# Collection log scheduling

[WOM imports](wom-competitions.md) are available in Scheduling and XP imports.
WOM metrics determine SKILL or ACTIVITY. Future/running SKILL imports save
metadata without opening pages or adding XP. Future ACTIVITY imports open selected
pages for the source period; running ACTIVITY imports open them from database
apply time until the WOM end. Finished imports create no opening window.
Review or correct the proposed pages and refresh the preview before applying.
The import never enables scheduling. Re-imports preserve linked staff edits and
deleted schedules; recreate a deleted window manually if wanted.

**Scheduling** (`/admin/schedules`) is available to administrators and moderators.
Only the administrator can enable or disable enforcement. Scheduling is disabled
by default and disabled mode preserves the existing intake rules. Saved windows
remain available, and both staff roles can prepare or edit them while disabled.
The enable switch has its own section above **Schedule management**.

Each named schedule selects one or more active collection log pages with a start
and end date/time. Multiple schedules can overlap. An active window opens all
its selected pages; the union of active windows determines which pages are open.
The start is included and the end is excluded. When enabled, every other page
is closed, including when no windows are active. If an item appears on multiple
pages, **any associated active page being open permits its submission**. Its
canonical credit still applies wherever that item appears.

Date/time fields use the staff member's browser timezone, shown above the form.
Both the draft and saved schedules display UTC alongside local times. The offset
is calculated for each chosen date, including daylight saving changes. Impossible
local times at a spring clock change are rejected. During a repeated autumn
hour, the browser uses the earlier occurrence; inspect its UTC preview before
saving. UTC instants are persisted, so two staff members in different timezones
see the same window expressed in their own local time.

[Mobile preview with overlapping schedules](collection-log-scheduling-mobile.png)
shows the page picker and local/UTC time review at a narrow screen width.

The API uses the PostgreSQL clock when admitting a new submission. No scheduled
job is needed to open or close pages. The gate applies to **RuneLite and Discord
submissions**, using the resolved canonical item and its current active
page memberships. While enabled, unresolved Discord claims and unpaged items
are rejected because they cannot match an open page. Closed public submissions return
**403** and do not persist a claim or screenshot; staff see the rejection while
remaining signed in. Whitelists and auto allow world policies cannot bypass
closed pages. World, clan/API-key, catalog, proof and credit uniqueness checks
continue to apply.

Administrators and moderators can add manual submissions to closed pages to
record achievements after a window ends. Manual claims still require an active
catalog item and a valid collection date, retain replay receipts and audits, and
enforce one approved credit per item/world. After success the manual form stays
open, clears its fields and shows a confirmation.

Previously saved submission retries retain their original immutable receipt,
even if their page is now closed. Staff may continue reviewing accepted claims
after their window ends. Schedules do not remove credits, hide public collection
log pages, or reopen deleted/inactive pages.

## Private API

All routes require a staff session; writes also require the configured Origin
and CSRF token. Toggle writes additionally require the administrator role.

| Method and path                        | Behavior                                                  |
| -------------------------------------- | --------------------------------------------------------- |
| `GET /api/v1/admin/schedules`          | Read `{ revision, enabled, schedules }`                   |
| `PUT /api/v1/admin/schedules/settings` | Admin sets `{ expectedRevision, enabled }`                |
| `POST /api/v1/admin/schedules`         | Create a window; returns 201 and updated state            |
| `PUT /api/v1/admin/schedules/:id`      | Edit a window; returns updated state                      |
| `DELETE /api/v1/admin/schedules/:id`   | Delete with `{ expectedRevision }`; returns updated state |

Create/edit payloads use canonical UTC ISO timestamps:

```json
{
  "expectedRevision": "schedules-1",
  "title": "Boss week",
  "startsAt": "2026-11-02T08:00:00.000Z",
  "endsAt": "2026-11-09T08:00:00.000Z",
  "pageIds": ["vardorvis", "the-whisperer"]
}
```

Page IDs must identify current active catalog pages. Each window supports up to
200 distinct pages, and the tool supports 500 schedules. An end must be after
its start. Every change advances the global `schedules-N` revision and appends
an audit with the staff identity and previous/new state. Concurrent edits with
an outdated revision return **409** and require explicit review of the latest
state. Schedule changes and the audit commit in one transaction. Intake locks
the scheduling settings before item/page locks, so toggles or schedule edits
cannot race admission. Public settings omit this private schedule data.

## Upgrade and recovery

Apply [migration 013](../packages/database/migrations/013_collection_log_schedules.sql)
and the existing runtime-role bootstrap before starting the updated API. It
adds a default-disabled switch, windows, selected-page links and an append-only
audit. Existing collection credits and submission receipts are preserved. No
new secrets, volumes or cron jobs are required. Take a coordinated database and
image-volume backup before upgrading. Earlier API images do not enforce
scheduling; reverting requires the matching pre-upgrade image and backup.
