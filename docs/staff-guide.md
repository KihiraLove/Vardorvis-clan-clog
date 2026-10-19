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
PNG/proof URL/note. Approve immediately is on by default. Hardcore claims have
independent credit; the checkbox appears when hardcore worlds are enabled.
Duplicate filtering rejects a new claim for an item already credited in that mode.

## Catalog

Sections contain pages, and pages can share canonical items. Moving or removing
one membership does not create another item or erase credits elsewhere.
Manual items may omit a game ID; RuneLite matching needs an unambiguous game ID.
Use the inspector to edit names, icons and memberships. Deletion retains audit
and submission history. Section, page and item order stays local until you click
**Save changes**. Leaving a page with unsaved edits asks whether to discard them.

## Scheduling and competitions

When scheduling is off, normal intake rules apply. When on, a regular item needs
at least one associated page open in a saved window or selected under
**Permanently open pages**. Search and select pages there, then click **Save changes**;
**Discard changes** restores the saved selection. These selections survive changes
to timed windows and the scheduling switch. Removing a catalog page removes its
permanent opening too. Moderators with Scheduling access can manage selections;
only the administrator changes the scheduling switch. Windows overlap as a union
and use UTC on the server. The UI accepts local times and shows UTC alongside.
Hardcore pages remain open. Manual staff intake bypasses closed windows.

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
