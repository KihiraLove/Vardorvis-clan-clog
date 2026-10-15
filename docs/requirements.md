# Product requirements

[Collection log scheduling](collection-log-scheduling.md) lets the administrator
enable enforcement and both staff roles manage overlapping windows for one or
more pages. Closed pages reject new submissions, with shared items accepted
when any associated page is open. Disabled mode preserves normal intake. Local
date/time entry includes UTC previews.

Administrator-managed labels, a dedicated site-settings page, moderator disable/delete and page-scoped item management are described in [site customization](site-customization.md). Migration `007_site_customization.sql` preserves existing histories; `008_default_clan_name.sql` sets the generic Clan name default while preserving administrator-chosen names. Generated clan keys use exactly 32 hexadecimal characters; custom keys accept any characters with a minimum length of 8. [RuneLite intake](runelite-submissions.md) rejects irregular world flags and supports private admin world policies, independent in-game clan matching, API-key-only intake and a player whitelist. Both HC placeholder spellings use separate hardcore credit.

> **9 October 2026 DEC-01 review:** [ADR 002](decisions/002-command-date-display.md) records the approved one-credit-per-mode policy, actual password auth and command/date defaults. The sole `/cc-clog submit` command and API receipt-date policy are confirmed. The owner confirmed Traefik/Let's Encrypt using Docker networks `web` and `socknet` and visually approved the frontend on 9 October 2026. Actual domain/DNS, deployed TLS routing/certificate and live login checks remain unverified.

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

## Clan branding

The administrator can upload a clan logo and restore the bundled default.
GIF and animated WebP logos animate, and the website icon uses the same image's
first frame. Logo controls are administrator-only and images persist through
restarts and coordinated backup/restore. See [clan branding](clan-branding.md)
for supported image formats, limits and the API contract.

## Hardcore collection mode

- `hardcore` belongs to an individual submission/approved credit and defaults to false; it is a reviewed condition, not a distinct item identity or inferred account type.
- Ordinary and hardcore logs show **independent** credits, counts and collector details over the same canonical item catalog; one active approved credit is allowed **per item per mode**. An item can appear collected in both modes.
- When the admin enables the hardcore release flag, the public skull switches to the hardcore log and turns red while that mode is active; disabled mode hides the skull without deleting or modifying hardcore credits. Do not release by a hardcoded date.
- In hardcore mode, collected icons show a red silhouette contour and the menu shows the skull and suffix `on hardcore worlds`, e.g. `Collected by KihiraVD on 16/10/26 on hardcore worlds`. Ordinary mode keeps its normal treatment. Do not combine two mode-specific collector lines.
- Pending, rejected or revoked claims never create a collected state. Revoking a credit affects only its mode and retains private audit history.
- The implemented slash command has an optional `hardcore` boolean. See [ADR 002](decisions/002-command-date-display.md) for the confirmed single command and receipt-date policy.

## XP gained tracker below the collection log

[WOM competition imports](wom-competitions.md) share one persisted identity with
a server-detected SKILL/ACTIVITY kind from authoritative WOM metrics. Future/running
SKILL imports store page-free metadata only; ACTIVITY can create a bounded opening
schedule. Neither path credits live results. Finished imports discard zero-gain
participants and reconcile final results. Only SKILL competitions contribute XP;
the selected competition and Total each show a top-three podium. The public
ACTIVITY list sits to the left of the collection log, sorted by end descending,
with local start/end times, status labels and red/green/yellow date colors.

- Display the SOTW/competition XP tracker **below the collection log on the homepage**, not behind a separate public navigation tab. The `/xp` route may remain a compatibility alias; preserve the collection log's five in-window tabs.
- Show site-aggregated skill XP and imported competition events with their titles, source links, and per-skill totals. Detailed participant records are retained for reconciled imports, but **not** presented as a public member table. Show zero or unavailable event values accurately.
- An allowlisted admin supplies a Wise Old Man competition link to import/refresh results. The selected competition provides the participant roster; do not silently omit competitors or require a separate automatic clan sync.
- Use competition gained XP for the appropriate skill, adding every valid competitor contribution to the site's existing total. This total is competition-accumulated XP, not each account's lifetime HiScores XP.
- First import adds the full gains; refreshing the same competition applies only differences from the stored contribution. The same unchanged competition/link cannot add XP twice. Further competitions add their gains to the existing matching skill totals.
- Support individual skill and multi-skill results. Expand overall competitions into explicit per-skill gains when supported by the official metrics-preview endpoint; never count an aggregate score/overall total alongside the individual skill contributions. Reject unsupported mixed scopes and competitions containing no supported XP skill.
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
- Authenticate and audit creation/order writes. Backup/restore must include the uploaded icons as well as the database. Staff can also create, reorder and explicitly delete pages with preserved shared-item identities and history; see [page management](site-customization.md).

These features are implemented; current contracts are in [WOM imports](wom-competitions.md), [XP imports](xp-import.md) and [catalog maintenance](admin-catalog-backend.md). [Planned features](planned-features.md) preserves the historical design.

## Submission and review

Review notes have explicit independent Save/Discard controls and version-checked
note-only persistence, even for unresolved submissions. Claim edits and decisions
do not implicitly save drafts. Access loss clears private state and cancels
outstanding work. Queues, audits and XP history support complete bounded traversal
with revision-bound cursors and explicit stale-page recovery; see
[contracts](contracts.md).

Every submission records raw item input, resolved canonical item when known, collector display name, collection date, hardcore claim, submission timestamp, actor Discord ID, guild ID, proof URL, review state and audit history. Unmatched free text may enter the review queue, but **cannot be approved until linked to one existing item**.

The admin page uses individual staff accounts and server-side session/CSRF checks; Discord OAuth is not used for site administration. A fresh authenticated installation requires an independently generated `ADMIN_BOOTSTRAP_PASSWORD` to create one administrator with username `admin`; no default password or moderators are supplied. Missing bootstrap credentials must prevent authenticated startup on an uninitialized database. Existing administrator accounts survive renaming/restarts and cannot be reset by supplying another bootstrap value. The administrator creates moderator accounts. Every new account must change its password on first login before using staff tools; remove the bootstrap environment value after administrator setup. Both roles can change their own username and password, confirming the current password. Passwords use unique salts and one-way scrypt hashes. Usernames are case-insensitively unique. Moderators have review, submission, catalog and scheduling tools, including metadata-only SKILL schedules and ACTIVITY imports. Finished XP imports, the hardcore release flag and account creator are administrator-only.

The page lists pending submissions with item/match state, collector, date, external proof link and submission time. Staff can resolve an item, correct collector/date, approve, reject with a reason, or revoke an incorrect approval with a reason. All changes are audited with permanent account identities; a public anonymous request cannot perform them.

Proof links must use HTTPS on the allowed Imgur/Gyazo hosts. Link validity is separate from evidence validity: an admin still inspects the evidence. Discord evidence remains an external link without server-side downloading. RuneLite and supported manual uploads instead retain private validated screenshots in durable proof storage; authenticated review is required to read them. A missing external image must be visible as a review limitation; it does not grant automatic approval.

## Discord

The implemented command is `/cc-clog submit item:<item/name> proof:<imgur-or-gyazo-link> [submitter-name:<collector>] [hardcore:<boolean>]`.

- Item and proof are mandatory. Collector name is optional and defaults to the actor's current Discord guild display name, falling back to username; save a snapshot rather than a live reference.
- Item autocomplete searches the complete canonical catalog and returns up to 25 ranked candidates. Selection submits a canonical ID. Free text is accepted; an unambiguous normalized exact name/alias resolves, while fuzzy/ambiguous matches remain suggestions for manual review.
- Restrict submissions to the configured clan guild; do not accept DMs or other guilds. No privileged message-content intent is needed for slash commands.
- Acknowledge/defer promptly and send an ephemeral receipt only after durable persistence. Retry the same Discord interaction ID without creating duplicate submissions. Report API failures accurately.
- Do not overwrite all application commands on every container restart. Use the separate, explicit guild-command registration script; the gateway and durable API intake are implemented.

The owner confirmed **exactly one command**, `/cc-clog submit`. The earlier second-command reference was residual ideation; no additional command should be registered.

## Date policy

`collected_on` is the **UTC calendar date of receipt by the API** and `submitted_at` is the UTC receipt timestamp. The submitting user and bot cannot specify a different collection date; `dateSource` is `submission_default`. Exact interaction retries retain the original timestamp/date. The admin may make a separate, audited correction during review.

The command defines `item`, `proof`, optional `submitter-name` and optional `hardcore`; it does **not** expose `collected-on`. The bot API also rejects a caller-supplied `collectedOn`. Public rendering is `DD/MM/YY`; authenticated admin corrections must be valid, nonfuture calendar dates.

## Deployment scope

Self-host one unified web/API/optional-bot image with a separate PostgreSQL container and owner bootstrap job. Run complete acceptance locally for development; pushes/PRs consume no hosted CI. Published GitHub Releases run acceptance and publish the unified multi-architecture GHCR image. Deployment is explicit and selects a validated release. See [current inventory](current-state.md) for startup credentials, schema/rollback policy, maintenance, readiness, recovery and remaining external launch gates.
