# Site customization and account/catalog management

Visual references from the passing Chromium preview tests: [desktop homepage](site-customization/homepage-desktop.png)
and [320-pixel Site settings](site-customization/settings-mobile.png). The account
and key shown in the mobile capture are disposable preview fixtures.

The administrator's **Site settings** navigation entry opens `/admin/settings`.
It contains the clan name, hardcore release flag, logo and RuneLite API key
controls, plus four independently editable labels:

- Collection log title (also used in the browser title).
- Collection log caption (the hardcore view adds its world-mode label).
- XP section title.
- XP total caption.

Labels accept 1–160 printable characters. They are stored as text and rendered
through React's escaping, with revision-checked updates and before/after audit
records. The saving browser updates immediately; other visible public pages poll
within 25 seconds. Moderators cannot read/write these private settings.

The supplied `clan-logo.png` is the default logo and favicon source. The old GIF
and its derived first-frame image have been removed. Uploaded GIF and animated
WebP replacements continue to animate. See [clan branding](clan-branding.md).
The footer links to KihiraLove's GitHub and Ko-fi pages using the official blue
Ko-fi button. README badges show support, GitHub release-asset downloads and the
main CI workflow status; release downloads do not count container pulls.

## Shared API key form

The current key is a single editable field. **Generate new key** fills that field
with a random value locally. **Save API key settings** persists the field and
the requirement checkbox together in one revision-checked, audited operation.
Leaving without saving discards the draft. The field and generation remain
available when the requirement is disabled. Requirement-only changes do not
claim a key rotation in the audit. The API continues to support direct generation
for existing clients. See [RuneLite submissions](runelite-submissions.md).

## Catalog maintenance

The catalog page lets staff add items to existing pages, change each page's
item order, delete an item from the active catalog, or reload the currently saved
catalog. **Refresh catalog reloads saved database data; it does not download or
import new OSRS items.** A source update is a separate reviewed import workflow.

Deleting requires selecting a specific item and confirming it. The API takes
the catalog revision, uses the import/catalog lock, removes memberships from
every page, compacts remaining slots while preserving order/origin, deactivates
the stable item record and inserts an audit event in one transaction. Staff
selectors, bot matching and the public catalog/credits stop showing it. Existing
claims and credits remain in storage for history; an inactive item cannot receive
new approved credit. Intake and approval hold item locks so a concurrent deletion
cannot slip past the active-item check. Normal bootstrap does not reactivate
deleted items. Staff can still open these historical claims to reject, revoke or
correct them to an active item.

`DELETE /api/v1/admin/catalog/items/:id` accepts JSON `{ "expectedRevision":
"catalog-N" }` with the staff session, exact Origin and CSRF token. Both staff
roles can use it. Stale revisions return 409; an unauthenticated caller cannot
reach the write.

## Moderator accounts

Only the administrator can disable, enable or delete moderators from
`/admin/accounts`. Disabling prevents login immediately and revokes all sessions;
enabling permits a new login and retains any required first-login password change.
Deletion requires confirmation, removes the account from the account list,
removes its password verifier, releases the username and revokes access. A
deleted account cannot be re-enabled. The permanent ID and audit rows remain,
so old reviews retain the original actor even if the username is reused by a
new account. The administrator cannot be disabled or deleted, enforced by the
route and a database constraint.

`POST /api/v1/admin/accounts/:id/disable`, `/enable` and `/delete` accept
`{ "expectedVersion": N }`, with administrator session/Origin/CSRF checks.
Credential versions prevent stale management changes and late-created sessions
from restoring access. Each action is audited without credentials.

Migration `007_site_customization.sql` adds public copy, account lifecycle
fields and audit action constraints. No new volume or secret is needed. Existing
database/image backups cover all of these settings; preserve the full database
and image archives together during restore. Disabling moves the salted password
verifier to a private disabled-account field and clears the login verifier;
enabling restores it. This also prevents login through older images that do not
understand the disabled flag. Deletion clears both verifier fields. Older images
retain the new copy fields but do not expose the new management controls.
