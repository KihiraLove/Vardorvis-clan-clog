# Staff guide

Use **Admin panel** in the website header, or open `/admin` directly. **Main site**
returns to the collection log; leaving unsaved edits asks for confirmation.
The administrator can create moderator accounts; each
person changes their temporary password at first login. By default, moderators can review
submissions, enter manual claims, manage the catalog and import competitions.
Only the administrator changes site settings, shared keys and enforcement switches,
and manages accounts. Both roles can edit automatic review rules.

On **Access control**, the administrator chooses which pages all moderators can
access. Changes take effect on subsequent API requests; open moderator tabs refresh
their navigation within 25 seconds or when refocused. Turning off a page also blocks
its actions and direct API requests. Shared catalog reads remain available to allowed
submission and scheduling tools. Access control, account management and existing
administrator-only actions cannot be delegated. Granted Site settings, Hardcore worlds
and Discord bot pages are read-only for moderators; secrets are never redisplayed.

The public **Collection log** is at `/`; **Xp tracker** at `/xp` contains skill
competitions and XP results. The buttons preserve the selected catalog page.
Hardcore mode has its own collection log and hides the public page buttons;
switching to hardcore from XP opens that log. Page links use `?page=<page-id>`;
`hardcore=1` selects hardcore only when the feature is enabled in settings.

## Submissions

The Pending and Reviewed queues show 20 submissions per page. Next appears when
another page exists. Changing filters starts again at page one. A stale queue
offers a fresh load instead of combining different snapshots.

Open a card to see evidence, item identity, source, original chat message and
audit history. Save corrections and staff notes separately. Approval requires
a saved matching item and proof acknowledgement. Rejection, revocation and
corrections to an approved credit require a reason. The revision prevents
concurrent reviewers from overwriting each other; reload after a conflict.

Manual submission accepts a collector, catalog item, collection date and optional
PNG/proof URL/note. Choose **Regular collection** or **Event collection**;
Approve immediately is on by default. Hardcore forces Regular and has independent
credit. Its checkbox appears when hardcore worlds are enabled.

Normal-world items can have one approved Event collection and independent Regular
collections. **Filter out regular duplicates** blocks another Regular credit in
the same world mode when on. When off, Regular collections can repeat, including
the same collector. Re-enabling it preserves existing history. Staff approval and
corrections enforce the same rules. Revoke a credit to remove that entry only.

## Catalog

Sections contain pages, and pages can share canonical items. Moving or removing
one membership does not create another item or erase credits elsewhere.
Manual items may omit a game ID; RuneLite matching needs an unambiguous game ID.
Use the inspector to edit names, icons and memberships. Deletion retains audit
and submission history. Section, page and item order stays local until you click
**Save changes**. Leaving a page with unsaved edits asks whether to discard them.

RuneLite items missing from the catalog appear in **Submissions → Unmatched**.
Check the submitted name, original **Game item ID**, chat message and optional
screenshot. Select the correct canonical item and **Save corrections**, then
review and approve separately. Notes and rejection do not require a match.
Catalog items and game-ID aliases are managed separately in **Items catalog**.

## Scheduling and competitions

Every page accepts submissions. With scheduling enabled, a normal-world drop is
an **Event collection** when at least one associated active page has a timed
window covering its server receipt time and is not permanently open. Otherwise
it is **Regular collection**. Starts are inclusive and ends exclusive, in UTC.
The date picker accepts local time and shows UTC alongside.

**Permanently open pages** always produce Regular collections, including when a
window overlaps. Another timed page can still qualify a shared item for Event.
Search/select pages and click **Save changes**; **Discard changes** restores saved
selections. Only the administrator changes the global scheduling switch.
Disabled scheduling and all hardcore claims are Regular.

Intake saves timing and page membership. Later schedule/catalog changes cannot
reclassify a claim. Unmatched claims resolve from that saved evidence when staff
save a canonical match. **Use saved intake timing** keeps that behavior; an explicit
Regular/Event correction is audited. Manual date-only claims use the selected type.
Approved Event credit has a gold item outline and a gold-bordered history block.
The hover/tap menu shows Event first, then every Regular credit oldest first.

[WOM imports](wom-competitions.md) can create activity windows or publish skill
results. Importing does not enable scheduling automatically. RuneLite stores
valid submissions even when a policy automatically rejects them; they appear
under Reviewed with the reason.

## Settings

Set displayed clan names, copy and logos independently for regular/hardcore.
The hardcore switch controls public visibility; disabling it preserves records.
The public XP tracker is hidden in hardcore mode until hardcore competitions
are supported. Set the actual in-game clan match under RuneLite submissions,
independently of the displayed site name. See [RuneLite](runelite-submissions.md).
