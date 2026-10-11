# RuneLite submissions and screenshot evidence

`POST /api/v1/runelite/submissions` accepts `multipart/form-data` with exactly
these fields (their order does not matter):

| Field        | Value                                        |
| ------------ | -------------------------------------------- |
| `username`   | Collector name, 1–80 characters              |
| `clanName`   | Website clan name, 1–80 characters           |
| `itemId`     | Positive OSRS game item ID, as decimal text  |
| `screenshot` | One PNG file, MIME `image/png`, up to 10 MiB |

```bash
curl --fail-with-body https://your-clan.example/api/v1/runelite/submissions \
  -H 'Idempotency-Key: 00000000-0000-4000-8000-000000000001' \
  -F 'username=Collector' -F 'clanName=Vardorvis' -F 'itemId=4151' \
  -F 'screenshot=@drop.png;type=image/png'
```

No API key is required. A trimmed, case-insensitive clan-name mismatch returns
**403** and creates no submission or image. This comparison validates the
submitted clan string; it does not authenticate clan membership. All accepted
claims are **pending** and need staff review before they grant credit.

The game ID resolves through `game_item_ids` to an active canonical catalog
item. Variant IDs can resolve to the same item; unknown/inactive IDs return
**422**. A canonical item without a game-ID mapping cannot be submitted by
RuneLite. Receipt `itemId` is the **canonical** ID. The server records receipt
time and UTC collection date; this four-field contract starts in normal worlds.
Staff can correct date and world mode during review.

Success returns **201**, for example:

```json
{
  "submissionId": "00000000-0000-4000-8000-000000000002",
  "status": "pending",
  "itemId": 42,
  "submittedAt": "2026-10-11T12:00:00.000Z",
  "collectedOn": "2026-10-11"
}
```

The optional UUID `Idempotency-Key` should be generated once per drop and reused
on retries. Identical fields and decoded PNG pixels return the original receipt,
including after review/restart. Changing the payload with that key returns
**409**. Without a key, each request creates a new pending claim. Replays must
still match the currently configured clan. A future plugin should retain the
key, payload and PNG until it receives the receipt.

Malformed multipart or invalid PNG returns **400**, oversize uploads **413**,
rate limits **429** with `Retry-After: 60`, and unavailable database/storage
**503**. Uploads are limited to ten requests per client IP per minute and 120
globally per minute, shared across API processes. Configure the existing trusted
proxy chain correctly so the API can distinguish visitor IPs. PNGs must be still
images, at most 8192 pixels per side and 32 megapixels. They are decoded and
re-encoded, discarding metadata and original filenames.

## Website settings and manual submissions

The admin's **Site settings → Clan name** defaults to `Vardorvis`. Saving updates
the public header, footer, admin heading and document title, and immediately
changes intake validation. Public tabs refresh settings every 25 seconds or
when returning to the tab. `GET /api/v1/settings` returns `revision`,
`hardcoreEnabled` and `clanName`. Admin-only, CSRF-protected
`PUT /api/v1/admin/settings` accepts those values with `expectedRevision`.
Concurrent settings writes return **409**; both previous/new clan names are
recorded with the authenticated admin's audit entry. Existing clients can omit
`clanName` on writes to preserve the saved name. Moderators cannot change it.

Admins and moderators can optionally attach a PNG to manual submissions.
`POST /api/v1/admin/submissions/upload` uses multipart fields `submission`
(the existing manual-submission JSON object) and `screenshot` (PNG), with the
same session, origin, CSRF and mandatory UUID `Idempotency-Key` as JSON manual
creation. The JSON route still supports optional Imgur/Gyazo proof or no proof;
Discord intake continues using external links without stored screenshots.
Manual PNGs can be accompanied by an external proof URL. Retries include the
PNG digest in the manual receipt and retain the original uploaded image.

Screenshots appear in the private queue/review editor and are served only to
authenticated staff who completed first-login password setup, at
`/api/v1/admin/submission-images/<generated-uuid>.png` with no-store caching.
Public catalog, credits and XP responses contain no proof URLs, image paths or
uploaded image data. Files remain available after approval/rejection/revocation
for later review; uploads never grant approval privileges.

## Persistence, upgrade and recovery

Forward-only migration
[`004_runelite_submissions.sql`](../packages/database/migrations/004_runelite_submissions.sql)
adds clan settings/audit columns, screenshot metadata/provenance and immutable
RuneLite receipts. Existing Discord/manual rows and receipts remain valid.
Normal bootstrap applies it and reconciles runtime grants; no database reset
is required.

Compose supplies `PROOF_STORAGE_PATH=/data/submission-images` and a separate
durable `submission-images` volume. For standalone API development set an
absolute writable directory; it is required with staff authentication. A
database-backed API with this storage path enables RuneLite intake even when
Discord is disabled. Startup verifies writable storage. Image reads check the
stored size and SHA-256 and return **503** on missing/corrupt files.

Coordinated [`infra/backup.sh`](../infra/backup.sh) stops writers and archives
`database.dump`, `icons.tar.gz` and `screenshots.tar.gz`, with checksums and a
completion marker. Restore all three from the same backup while writers are
stopped, preserving PNG filenames and node ownership of both image directories.
Verify checksums before restoring and rehearse in a separate disposable Compose
project. A backup made before this migration has no referenced screenshots;
an empty screenshot archive is sufficient for that historical database.

An older image is incompatible with the new submission sources/settings once
RuneLite claims exist. Recovery to such an image requires the coordinated
pre-upgrade database and image-volume backup. Keep orphaned PNGs after an
uncertain database/storage failure until a maintenance check confirms that no
submission references their generated UUID; never delete referenced evidence.
