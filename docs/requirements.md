# Product requirements

> **9 October 2026 DEC-01 review:** [ADR 002](decisions/002-command-date-display.md) records the approved one-credit-per-mode policy, actual password auth and command/date defaults. The second Discord command, optional slash date, and proxy/TLS/visual sign-off remain owner decisions.

## Public collection log

- Recreate the OSRS collection-log layout 1:1 at its reference desktop size: window frame, five top-level tabs, page navigation, scrollbars, item grid and ordering, labels, counters, font, spacing and icon treatment. Preserve the original proportions when adapting to small screens.
- A catalog import creates item/page definitions only. Every item starts uncollected; missing credits mean uncollected.
- Pending/rejected submissions never change the public log. Approved submissions visibly change the item's original dim/uncollected appearance into its collected appearance. Include an accessible state label in addition to color.
- Each item's status is shared across all pages where the same item appears. Distinct legitimate item variants stay distinct unless an explicit canonical mapping says otherwise.
- A custom OSRS-style mini menu appears on pointer hover and keyboard focus. On touch it opens on tap and closes on outside tap/Escape. It stays inside the viewport and does not obscure the triggering item unnecessarily.
- In the selected ordinary or hardcore mode, display the one active approved credit's saved collector name and collection date, e.g. `Collected by KihiraVD on 16/10/26`. Each canonical item may have one separate credit **per world mode**, not multiple publicly displayed collectors. Preserve all prior submissions and audit events privately; never erase history when an approval is revoked or corrected.
- Use a versioned, complete catalog snapshot with source revisions and locally served icons/assets. Do not hard-code a timeless total item count or depend on a live external site to render the log.
- Global progress counts unique canonical items. Page progress counts the page's own slots. An item shared by two pages can increment both page counters but only once in the global total.
- After an approval/revocation, an open public page refreshes within 30 seconds. Initial implementation uses ETag-aware polling; reassess push updates only if needed.

## Hardcore collection mode

- `hardcore` belongs to an individual submission/approved credit and defaults to false; it is a reviewed condition, not a distinct item identity or inferred account type.
- Ordinary and hardcore logs show **independent** credits, counts and collector details over the same canonical item catalog; one active approved credit is allowed **per item per mode**. An item can appear collected in both modes.
- When the admin enables the hardcore release flag, the public skull switches to the hardcore log and turns red while that mode is active; disabled mode hides the skull without deleting or modifying hardcore credits. Do not release by a hardcoded date.
- In hardcore mode, collected icons show a red silhouette contour and the menu shows the skull and suffix `on hardcore worlds`, e.g. `Collected by KihiraVD on 16/10/26 on hardcore worlds`. Ordinary mode keeps its normal treatment. Do not combine two mode-specific collector lines.
- Pending, rejected or revoked claims never create a collected state. Revoking a credit affects only its mode and retains private audit history.
- The implemented slash command has an optional `hardcore` boolean. See [ADR 002](decisions/002-command-date-display.md) for the still-open second-command and optional collection-date choices.

## XP gained tab and page

- Add a site-navigation `XP gained` tab leading to a separate `/xp` page. Preserve the collection log's original five tabs inside its recreated window.
- Track imported competition XP for clan participants by skill. Show the skill name/icon, cumulative site skill XP, each member's accumulated XP, and each imported competition's complete participant gains, including zero/unavailable rows.
- An allowlisted admin supplies a Wise Old Man competition link to import/refresh results. The selected competition provides the participant roster; do not silently omit competitors or require a separate automatic clan sync.
- Use competition gained XP for the appropriate skill, adding every valid competitor contribution to the site's existing total. This total is competition-accumulated XP, not each account's lifetime HiScores XP.
- First import adds the full gains; refreshing the same competition applies only differences from the stored contribution. The same unchanged competition/link cannot add XP twice. Further competitions add their gains to the existing matching skill totals.
- Support individual skill and multi-skill results. Expand overall competitions into explicit per-skill gains when supported by the official metrics-preview endpoint; never count an aggregate score/overall total alongside the individual skill contributions. Reject competitions containing no supported XP skill.
- Retain stable WOM player IDs, name snapshots, competition source/date/history and the last successful import time. Failed, partial or rate-limited refreshes preserve published totals; missing source values are labelled unavailable, not invented as XP.
- Public visitors read stored results only. Import/refresh is an admin action, with an authenticated preview/apply flow and audited snapshot reconciliation. Distinct overlapping competitions are shown as overlapping; the displayed ledger counts their reported contributions rather than claiming deduplicated lifetime XP.

## Admin catalog maintenance

- An allowlisted admin can add an item with exactly these required inputs: icon, nonblank name, and one or more existing collection-log pages. A game item ID is optional; adding an item must not require finding its external OSRS ID first.
- Create one stable canonical item and link it to every selected page. All occurrences start uncollected and non-hardcore; later approved collection credits and hardcore state are shared across those pages.
- Upload and preview a validated icon, preserving transparency and pixel clarity. Persist it outside the image/container layer so image upgrades and restarts retain it.
- Append a new item to the end of each selected page. The admin can rearrange a page's items using drag-and-drop or accessible move/position controls, then explicitly save the order.
- Save order independently per page. Reordering must preserve item identity, other page orders, collector/date history and hardcore state. Stale or conflicting edits return a visible conflict rather than overwriting another admin's changes.
- New items become available on public pages, in Discord autocomplete and in manual submission matching after the catalog refresh, without rebuilding the website.
- Preserve manual items, icons, memberships and saved order through catalog source updates. If a source later contains an admin-created item, explicitly reconcile it to the existing canonical identity; never merge automatically by name or discard existing credits.
- Authenticate and audit creation/order writes. Backup/restore must include the uploaded icons as well as the database. Creating new pages is outside this addition.

These features are planned in #26, #27, #28, #30 and #31; detailed data rules and arithmetic examples are in [planned features](planned-features.md).

## Submission and review

Every submission records raw item input, resolved canonical item when known, collector display name, collection date, hardcore claim, submission timestamp, actor Discord ID, guild ID, proof URL, review state and audit history. Unmatched free text may enter the review queue, but **cannot be approved until linked to one existing item**.

The admin page is protected by a server-side shared password and session/CSRF checks; Discord OAuth is not used for site administration. It lists pending submissions with item/match state, collector, date, external proof link and submission time. An admin can resolve an item, correct collector/date, approve, reject with a reason, or revoke an incorrect approval with a reason. All changes are audited; a public anonymous request cannot perform them.

Proof links must use HTTPS on the allowed Imgur/Gyazo hosts. Link validity is separate from evidence validity: an admin still inspects the evidence. V1 stores links, without server-side image downloading or permanent archival. A missing external image must be visible as a review limitation; it does not grant automatic approval.

## Discord

The implemented command is `/cc-clog submit item:<item/name> proof:<imgur-or-gyazo-link> [submitter-name:<collector>] [hardcore:<boolean>]`.

- Item and proof are mandatory. Collector name is optional and defaults to the actor's current Discord guild display name, falling back to username; save a snapshot rather than a live reference.
- Item autocomplete searches the complete canonical catalog and returns up to 25 ranked candidates. Selection submits a canonical ID. Free text is accepted; an unambiguous normalized exact name/alias resolves, while fuzzy/ambiguous matches remain suggestions for manual review.
- Restrict submissions to the configured clan guild; do not accept DMs or other guilds. No privileged message-content intent is needed for slash commands.
- Acknowledge/defer promptly and send an ephemeral receipt only after durable persistence. Retry the same Discord interaction ID without creating duplicate submissions. Report API failures accurately.
- Do not overwrite all application commands on every container restart. Provide a separate, explicit guild-command registration script when the bot feature is implemented.

The user mentioned two commands but named only this one. The second remains **unapproved and unimplemented**; see the [DEC-01 decision record](decisions/002-command-date-display.md) for an explicitly nonbinding suggestion.

## Date policy

`collected_on` is a calendar date; `submitted_at` is a UTC timestamp. Initially, use the submission's UTC calendar date when no collection date is supplied and label the source `submission_default`. The admin can correct it before approval. This avoids pretending delayed submissions describe their actual drop date.

The command currently defines `item`, `proof`, optional `submitter-name` and optional `hardcore`; it does **not** expose `collected-on`. The API supports an explicitly supplied ISO date, but enabling that slash option requires the owner's decision. Until then, the UTC receipt-date fallback and admin correction remain in effect. Public rendering is always `DD/MM/YY`; never parse user input as an ambiguous locale date. Reject future collection dates at the submission/review boundary.

## Deployment scope

Self-host one web, API and bot container with PostgreSQL. CI produces separate private GHCR images for `linux/amd64` and `linux/arm64`. PRs validate without publish/deployment credentials. Home deployment is opt-in and chooses an already validated main commit. Bot, admin credentials, complete catalog and feature implementation remain required before a public V1 launch.
