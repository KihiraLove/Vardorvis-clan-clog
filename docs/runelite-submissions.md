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
  -H 'X-Clan-API-Key: YOUR_CLAN_SHARED_KEY' \
  -H 'Idempotency-Key: 00000000-0000-4000-8000-000000000001' \
  -F 'username=Collector' -F 'clanName=Vardorvis' -F 'itemId=4151' \
  -F 'screenshot=@drop.png;type=image/png'
```

The shared clan API key is **required by default**, in the `X-Clan-API-Key`
header. The API generates a cryptographically random 32-byte key on first startup
and preserves it across restarts. An enabled requirement rejects missing/wrong
keys with **401**, before reading uploads. A trimmed, case-insensitive clan-name mismatch returns
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
still match the currently configured clan and, when required, use the current
API key. Credentials are not part of the immutable submission payload, so a
retry using a newly rotated key can recover its original receipt. A future plugin should retain the
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

Admins can view the **Current shared API key**, toggle **Require clan API key**,
click **Generate new key**, or enter their own text and click **Set API key**.
All key controls remain visible and usable with the requirement disabled.
Disabling preserves the saved key and accepts matching-clan submissions without
checking their key header. The clan-name and normal payload/PNG checks still
apply. Generating or supplying a key while disabled changes the visible saved
key, without enabling enforcement. Re-enabling immediately requires that key.
Rotations invalidate the previous key immediately, including uploads that
started before rotation but have not committed.

Admin-only `GET /api/v1/admin/clan-api-key` returns `{ revision, enabled, key }`.
CSRF-protected `PUT` requires `expectedRevision` (`clan-key-N`) and accepts
`enabled`, `key`, or `generate: true`. `key` and `generate` are mutually exclusive.
Custom keys allow 1–256 printable ASCII characters, without leading/trailing
whitespace. Stale updates return **409**. Moderators and public settings endpoints
cannot read or rotate keys; the shared key authorizes only RuneLite intake,
not staff tools or Discord bot operations. The key header is redacted from API
logging, and audits record actor, enabled changes and whether rotation occurred
without storing the key value.

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

[`005_clan_api_keys.sql`](../packages/database/migrations/005_clan_api_keys.sql)
adds the key singleton and append-only key audit. Startup creates the default
enabled key only when absent, including on upgrades from clan-name-only intake.
Existing keys and disabled settings are never reset by startup or bootstrap.
The key is encrypted with AES-256-GCM in PostgreSQL. Its encryption root is
created atomically as a private 32-byte file, `.clan-api-key.secret`, in the
screenshot volume; the standard screenshot archive includes this file too.
Database dumps alone do not contain the plaintext shared key. Public upload
authentication compares key digests in constant time and rechecks the current
requirement under a database lock when committing the pending submission.

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

Preserve `.clan-api-key.secret` when moving/restoring a post-key-upgrade service,
including if the API-key requirement was disabled. A missing/wrong root fails
startup without silently replacing the shared key. A pre-key-upgrade backup
has no encrypted key row and generates a new enabled key on its next startup.
Images predating this key feature do not enforce the key requirement; use the
matching image and coordinated database/screenshot-volume backup for recovery.

An older image is incompatible with the new submission sources/settings once
RuneLite claims exist. Recovery to such an image requires the coordinated
pre-upgrade database and image-volume backup. Keep orphaned PNGs after an
uncertain database/storage failure until a maintenance check confirms that no
submission references their generated UUID; never delete referenced evidence.
