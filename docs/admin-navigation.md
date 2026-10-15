# Admin route preparation

[Frontend loading acceptance](frontend-loading.md) adds a production-build browser
gate after the ordinary Chromium suite. It verifies entry-byte/module budgets,
parallel code/data preparation and chunk-failure/cancellation recovery. Reports
include `web-bundle.json`, `loading.log` and per-test loading measurements.

Staff navigation prepares the authorized destination before changing the visible
page. Queue/catalog, XP tracker/history, schedules/catalog, site settings/logo,
RuneLite settings/key and moderator accounts each have a route loader. The shell
reuses its verified session; moderators never request administrator-only data,
and mandatory password setup prepares only the account form. Destination modules
are already available in the current application bundle. Bundle splitting is
tracked separately in #101.

Prepared snapshots initialize the mounted forms directly. Initial reads are not
repeated after mount, and catalog consumers share one snapshot. Later refreshes,
polling and mutation reconciliation still use the live clients and their existing
revision/CSRF/receipt safeguards. These snapshots are scoped to the current page
and session; there is no persistent private route cache.

During a link transition the current page, active navigation, focus, scroll and
document geometry remain in place. A fixed accessible status offers Cancel.
Superseding navigation aborts the old generation, so a late response cannot mount
its editor. A failed read or ten-second timeout retains the current page and
offers Retry/Cancel. Deep links and refreshes use a stable loading shell without
mounting hidden editable forms. Cancelling an initial load leaves that shell and
an explicit retry action.

Successful preparation commits the page, active navigation and pushed/replaced
history together. Focus then moves to the destination heading after its DOM
commits, without scrolling it into view; link transitions start at the top.
Back/Forward reprepare their destination and restore the entry's saved scroll.
The browser changes its URL when a native history traversal starts; the current
content stays visible until preparation completes. Cancelling restores the
original entry without rewriting or deleting the traversed entry. New link
navigation during an unfinished traversal restores the original position before
pushing a new entry. Ordinary modified clicks retain browser behavior.
Scroll bookkeeping updates only history metadata, never the URL, and skips
entries whose native location has already moved. Route commits use the prepared
destination explicitly. This prevents a scroll before a native history event
from replacing its destination and leaving the current page visible.

Mounted forms register dirty drafts and active writes. Leaving a dirty page asks
whether to discard its changes only after the destination is ready, including
edits made while the destination was loading. Active staff operations block the
commit until they finish; loading never mounts a second editable copy. Reloads
and document exits use the browser's unsaved-change prompt. Logout and a 401 clear
all prepared private content and cancel in-flight route loads. A denied XP-history
read keeps the authenticated import screen available, exposes no old history and
offers an explicit history retry.

Coverage includes delayed success/failure, timeout, rapid destinations, history
cancellation, scrolling during native history changes, repeated page switching,
dirty forms, logout/access loss, refresh and deep links. Desktop and
320px checks compare the current panel, navigation, footer, focus and scroll
through delayed settings transitions. Browser evidence uses controlled API
fixtures; it does not substitute for a deployed production-data test.
