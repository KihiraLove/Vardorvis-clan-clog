# Site customization and account/catalog management

[Collection log scheduling](collection-log-scheduling.md) is available to both
staff roles from **Scheduling and Competitions**. The administrator controls enforcement; both
roles can create, edit and delete overlapping page windows. Local date/time
entry shows UTC previews, and disabled mode retains ordinary submission behavior.

Visual references from the Chromium fixture tests: [desktop homepage](site-customization/homepage-desktop.png)
and [320-pixel Site settings](site-customization/settings-mobile.png), plus
[historical mobile item management](site-customization/item-management-mobile.png). The account
shown in the mobile capture is a disposable test fixture.
The former [mobile Page management panel](site-customization/page-management-mobile.png) is superseded by the collection-log catalog editor.
Additional references show [independent hardcore branding](site-customization/hardcore-desktop.png)
and [hardcore settings while disabled](site-customization/hardcore-settings-mobile.png).
The [historical mobile XP imports page](site-customization/admin-xp-mobile.png)
has been replaced by the import form under **Scheduling and Competitions**.

The administrator's **Site settings** navigation entry opens `/admin/settings`.
The clan logo is the first setting, followed by **Displayed clan name** (default
**Clan name**) and text. The shared API key controls have their own
**RuneLite submissions** page at `/admin/runelite`. Three labels are editable:

- Collection log title (also used in the browser title).
- Collection log caption, above the log window and the same size as the XP heading
  (the hardcore view adds its world-mode label).
- XP section title.

Labels accept 1–160 printable characters. They are stored as text and rendered
through React's escaping, with revision-checked updates and before/after audit
records. The saving browser updates immediately; other visible public pages poll
within 25 seconds. Moderators cannot read/write these private settings.

Settings forms and responsive logo previews keep their space while private data
loads. Controls remain disabled until the settings are available, including after
a failed read. The admin gradient is anchored to the viewport so switching
between pages of different heights does not cause a background flash.

The supplied `clan-logo.png` is the default logo and favicon source. The old GIF
and its derived first-frame image have been removed. Uploaded GIF and animated
WebP replacements continue to animate. See [clan branding](clan-branding.md).
The footer links to KihiraLove's GitHub and Ko-fi pages with a white **GitHub** banner and blue Ko-fi badge,
using the official GitHub mark and Ko-fi button. README badges show support, GitHub release-asset downloads and the
main CI workflow status; release downloads do not count container pulls.

The **Hardcore worlds** navigation entry opens `/admin/settings/hardcore` even
when hardcore visibility is disabled. **Enable hardcore worlds** has its own
section above **Hardcore worlds settings**, with an On/Off toggle that saves
immediately without saving or discarding draft appearance edits. The appearance
section contains its own logo/favicon, displayed clan name and the same three
text labels.
The regular and hardcore appearances start identical and save independently.
The public skull switches the name, logo, browser title/icon and text together.
Disabling the release flag hides the public switch while retaining all appearance
settings and collections. Moderators cannot use either settings page.

The submission clan name and API key remain shared; the hardcore displayed name
does not change RuneLite validation. XP totals and event data remain shared.
RuneLite settings now provide a separate in-game clan name, an API-key-only
matching option, world-policy dropdowns and a player whitelist. Displayed clan
names do not change submission matching. See [automatic review rules](runelite-submissions.md).
The public XP section is hidden in Hardcore worlds until hardcore WOM
competitions are implemented. Selected regular-world events retain their source link.

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
Disabling the key requirement applies to clan-name matching mode. API-key-only
matching always requires a valid key.

## Items catalog and navigation

The catalog settings page is an editable collection log. Section tabs, pages and item grids use six-dot drag handles; Alt + arrow keys and contextual Move earlier/later buttons also arrange the local draft. **Save changes** publishes the pending order. Small gear buttons open the right-hand editor, which stacks below the log on mobile.

Add section asks for a name. Section settings can rename or delete an empty section; sections containing pages cannot be deleted. Add page asks for a name within the selected section. Page settings can rename or delete the page. Deleting pages removes memberships while preserving items on other pages or as active pageless entries.

Add item offers **Add new item** and **Add existing item**. New items require a name, PNG/WebP icon and in-game item ID and use the current page. Existing items are searchable by name or ID, including pageless items. Item settings edit names, game IDs and icons and list all current pages with membership removal controls. Explicit item deletion requires confirmation and retains submission and collection history. Catalog changes are revision checked, audited and shared by regular and hardcore logs. See the [API and persistence contracts](admin-catalog-backend.md).

Page names and the open page title use orange `#ff981f`; completed page names use `#0dc10d`. Obtained counts use red `#ff0000` at zero, yellow `#ffff00` when partial and green `#0dc10d` when complete. Page rows alternate `#574e43` and `#473d32`, with `#585040` borders. Both world modes retain independent collection counts.

Administrator navigation is ordered **Submissions, Items catalog, Scheduling and Competitions,
RuneLite submissions, Site settings, Hardcore worlds, Moderator accounts, Your
account**. Moderators see Submissions, Items catalog, Scheduling and Competitions,
RuneLite submissions and Your account. Owner settings remain inaccessible to
moderators. The RuneLite page exposes the shared key for viewing and copying,
with key replacement restricted to the administrator.
On Submissions, moderators see the duplicate-filter status and a message that
only the administrator can change it, instead of an interactive toggle.

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

Migration `010_hardcore_appearance.sql` copies current regular branding into
independent hardcore settings, removes the retired caption from current settings
and preserves historical audits. Logo revisions and audits are scoped per mode;
website text uses the shared settings revision to prevent concurrent lost edits.
Existing logo assets and image-volume backups serve both modes. Back up the
database and image volume together before upgrading. A rollback to an image
requiring the retired caption needs its matching pre-upgrade database backup.

Migration `011_catalog_page_management.sql` adds page activation, independent
page-position provenance and durable page creation receipts. It preserves all
existing memberships and histories. Older images do not filter deactivated page
rows; use a compatible image or restore the coordinated pre-upgrade backup when
rolling back after whole-page deletions.
