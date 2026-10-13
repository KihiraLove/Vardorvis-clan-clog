# Clan logo and website icon

After completing first-login password setup, the administrator can upload a
logo from **Site settings → Clan logo** on `/admin/settings`. Moderators cannot use
these controls or their private API endpoints. The bundled clan logo is
the default; **Restore default logo** restores it without erasing the history.

The service detects image content instead of trusting extensions or browser
MIME metadata. Supported formats are JPEG, PNG, GIF, WebP, SVG, AVIF and TIFF.
Uploads may be up to 10 MiB, 8192 pixels per side, 300 animation frames and
64 megapixels across all frames. Logos are fitted within 1024 × 1024 pixels
without enlargement. Multipage TIFFs use the first page. Unsupported or
corrupt files are rejected without changing the current logo.

The public logo is a decoded and re-encoded WebP, preserving transparency,
GIF/WebP frames, delays and loop count. SVG is rasterised; uploaded source
markup and embedded metadata are never served. A matching 64 × 64 PNG website
icon uses the first frame with transparent padding to preserve proportions.
The browser updates both icon links when branding changes. The saving admin
sees the change immediately; other visible pages refresh within 25 seconds,
and hidden pages refresh when they become visible.

## API

- `GET /api/v1/branding` returns `revision`, `logoPath`, and `faviconPath`.
- `GET /api/v1/admin/branding` reads the same saved branding for an administrator.
- `PUT /api/v1/admin/branding/logo` accepts one multipart file named `logo`.
  Send the current revision as `If-Match: branding-N`, the staff session cookie,
  exact site `Origin` and `X-CSRF-Token`.
- `DELETE /api/v1/admin/branding/logo` restores the default, accepting JSON
  `{ "expectedRevision": "branding-N" }` with the same session/origin/CSRF checks.

Hardcore appearance uses `GET /api/v1/branding/hardcore`,
`GET /api/v1/admin/branding/hardcore` and
`PUT` / `DELETE /api/v1/admin/branding/hardcore/logo` with the same contracts.
The two modes have independent revisions, logos, favicons and audit histories.
The bundled Nginx proxy permits up to 11 MiB of multipart body on exactly
these two logo upload routes, leaving room for the documented 10 MiB file.
Other API routes retain their normal 3 MiB proxy limit. Fastify separately
rejects logo files larger than 10 MiB, and continues to enforce staff auth,
CSRF, image decoding, dimensions and frame limits. A disposable Compose CI
check uploads real images larger than 4 MiB through Nginx to **both** routes,
then exercises oversize, malformed, and unauthorized requests.
Hardcore logo controls remain available while its public release flag is off.
The public website switches both logo and icon with its selected world mode.

Successful writes advance the branding revision. Concurrent or stale writes
return 409 and do not overwrite a newer change. Account setup, role, session,
origin and CSRF are checked before consuming an upload. Public asset paths
use generated UUIDs and immutable caching with SHA-256 ETags; client-provided
filenames never become paths. Logo and favicon files are checksummed on read.

## Persistence and recovery

Migration `006_clan_logos.sql` adds immutable logo/favicon metadata, the current
branding pointer and an audit record for each upload or reset. The two files
are synced to disk before their database references and audit are committed
together. The runtime role may insert/read asset and audit rows, but cannot
update/delete them. Retired logos remain readable for cached pages and audit
history. Failed writes clean up files when the database confirms that no asset
was committed; uncertain commit outcomes retain files rather than break a
potentially successful save.

Files live under `ICON_STORAGE_PATH/branding` in the existing `catalog-icons`
volume. No new environment variable or volume is required. `infra/backup.sh`
already includes that directory in `icons.tar.gz`; restore it with the database
dump and screenshot archive from the same coordinated backup. Keep the volume
when recreating the application container. Normal bootstrap applies the new
additive migration without resetting existing accounts, submissions or branding.
