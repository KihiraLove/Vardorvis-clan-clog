# Site customization and account/catalog management

Visual references from the passing Chromium preview tests: [desktop homepage](site-customization/homepage-desktop.png)
and [320-pixel Site settings](site-customization/settings-mobile.png), plus
[mobile item management](site-customization/item-management-mobile.png). The account
and key shown in the mobile capture are disposable preview fixtures.

The administrator's **Site settings** navigation entry opens `/admin/settings`.
It contains the clan name (default **Clan name**), hardcore release flag, logo and RuneLite API key
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
The footer links to KihiraLove's GitHub and Ko-fi pages with blue banners,
using the official GitHub mark and Ko-fi button. README badges show support, GitHub release-asset downloads and the
main CI workflow status; release downloads do not count container pulls.

## Shared API key form

The current key is a single editable field. **Generate new key** fills that field
with 32 random hexadecimal characters locally. Custom keys accept any characters
and must contain at least 8; whitespace and line breaks are preserved.
**Save API key settings** persists the field and
the requirement checkbox together in one revision-checked, audited operation.
Leaving without saving discards the draft. The field and generation remain
available when the requirement is disabled. Requirement-only changes do not
claim a key rotation in the audit. The API continues to support direct generation
for existing clients. See [RuneLite submissions](runelite-submissions.md).

## Item management

The catalog page lets staff add items to existing pages and manage each page's
items. The Add item page search is inside the page selector. Each Item management
row has reorder buttons and a Delete button. Saved changes appear immediately
on the public page; the former Catalog maintenance refresh section has been
removed. A source update remains a separate reviewed import workflow.

Deleting requires confirmation in a dialog and removes only the selected page's
membership. The API checks the catalog revision and selected page's version,
uses the import/catalog lock, compacts that page's remaining slots while
preserving order/origin, and records an audit event in one transaction. Other
pages and collection credits remain intact. If this was the item's last page,
its stable record is deactivated and removed from staff selectors, bot matching
and the public catalog/credits. Existing claims and credits remain in storage
for history; an inactive item cannot receive
new approved credit. Intake and approval hold item locks so a concurrent deletion
cannot slip past the active-item check. Normal bootstrap does not reactivate
deleted items. Staff can still open these historical claims to reject, revoke or
correct them to an active item.

`DELETE /api/v1/admin/catalog/pages/:pageId/items/:id` accepts JSON
`{ "expectedRevision": "catalog-N", "expectedVersion": "page-N" }`
with the staff session, exact Origin and CSRF token. Both staff
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
fields and audit action constraints. `008_default_clan_name.sql` changes the
default to **Clan name** and upgrades the untouched Vardorvis default, preserving
names administrators explicitly selected. Existing custom keys of at least 8
characters survive startup unchanged. Historical shorter keys rotate once,
preserving enforcement and recording an audit entry. Update clients with the
displayed replacement if a short key was upgraded.
No new volume or secret is needed. Existing
database/image backups cover all of these settings; preserve the full database
and image archives together during restore. Disabling moves the salted password
verifier to a private disabled-account field and clears the login verifier;
enabling restores it. This also prevents login through older images that do not
understand the disabled flag. Deletion clears both verifier fields. Older images
retain the new copy fields but do not expose the new management controls.
