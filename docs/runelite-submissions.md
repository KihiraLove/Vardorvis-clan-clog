# RuneLite submissions and private proof

`POST /api/v1/runelite/submissions` accepts `multipart/form-data` with exactly
these fields (their order does not matter):

| Field         | Value                                                        |
| ------------- | ------------------------------------------------------------ |
| `username`    | Collector name, 1–80 characters                              |
| `clanName`    | In-game clan name, 1–80 characters                           |
| `itemId`      | Positive OSRS game item ID, as decimal text                  |
| `worldType`   | World type identifier or JSON array of identifiers           |
| `chatMessage` | Required full chat message, nonempty, up to 8192 UTF-8 bytes |
| `screenshot`  | Optional PNG file, MIME `image/png`, up to 10 MiB            |

```bash
curl --fail-with-body https://your-clan.example/api/v1/runelite/submissions \
  -H 'X-Clan-API-Key: YOUR_CLAN_SHARED_KEY' \
  -H 'Idempotency-Key: 00000000-0000-4000-8000-000000000001' \
  -F 'username=Collector' -F 'clanName=Clan name' -F 'itemId=4151' \
  -F 'worldType=["MEMBERS"]' \
  -F 'chatMessage=Collector received a drop: Abyssal whip'
```

Screenshots are optional. To include one, add
`-F 'screenshot=@drop.png;type=image/png'`. Without a file, the API stores no image
or image metadata. New submissions always require `chatMessage`, even when a PNG
is attached. Missing/blank messages return **422**; truncated multipart fields
return **400**. The server preserves the complete text, including whitespace,
Unicode and game markup, and rejects NUL characters. It never renders the message
as HTML or follows links from it.

Staff see **Chat message** in the private review panel, alongside any optional
screenshot. Chat-only claims can be reviewed and approved after the usual proof
acknowledgement. The original message is retained through corrections, decisions
and audit history; staff cannot edit it. Public catalog, collection credits and
RuneLite receipts never expose the message. Existing world, clan/key, scheduling,
automatic review, rate limits and duplicate filtering still apply.

The shared clan API key is **required by default**, in the `X-Clan-API-Key`
header. The API generates a cryptographically random 16-byte key written as
32 hexadecimal characters on first startup
and preserves it across restarts. An enabled requirement rejects missing/wrong
keys with **401**, before reading uploads. A trimmed, case-insensitive clan-name mismatch returns
**403** and creates no submission or image when clan matching is enabled. The
comparison uses the separate **In-game clan name for matching** setting; it does
not authenticate clan membership. All world policies default to staff review.
Configured auto allow policies and the player whitelist can grant automatic
approval. Valid claims always receive **201** and a durable submission receipt
with `status: "pending"`, `"approved"` or `"rejected"`. Configured world-policy,
closed-schedule and collected-item duplicate rejections are saved with their
proof, rejection reason and a **RuneLite auto review** audit entry. They appear
in the staff **Reviewed** queue and grant no collection credit.

The game ID resolves through `game_item_ids` to an active canonical catalog
item. Variant IDs can resolve to the same item; unknown/inactive IDs return
**422**. A canonical item without a game-ID mapping cannot be submitted by
RuneLite. Receipt `itemId` is the **canonical** ID. The server records receipt
time and UTC collection date. `worldType` is required. Use a single enum name
such as `MEMBERS`, or a JSON array containing all world flags reported by
[RuneLite](https://static.runelite.net/runelite-api/apidocs/net/runelite/api/WorldType.html).
Use `[]` for a world without flags. Names are uppercase identifiers; up to 32
flags of at most 64 characters are accepted. Duplicate flags and array order do
not change the submission's identity.

Any occurrence of `BETA_WORLD`, `DEADMAN`, `NOSAVE_MODE`, `PVP_ARENA`,
`QUEST_SPEEDRUNNING`, `SEASONAL`, `TOURNAMENT` or `TOURNAMENT_WORLD` returns **403** without
storing a claim or screenshot. This also applies to mixed flags containing the
`HARDCORE_MAIN`. This official RuneLite flag sets `hardcore: true`; every other
accepted type, including future identifiers, uses the regular log. Pending
claims do not grant credit until approved. The HC visibility setting does not
block intake or discard HC credit. Staff can correct date and world mode during
review; the original flags remain private submission provenance.

Success returns **201**, for example:

```json
{
  "submissionId": "00000000-0000-4000-8000-000000000002",
  "status": "pending",
  "itemId": 42,
  "submittedAt": "2026-10-11T12:00:00.000Z",
  "collectedOn": "2026-10-11",
  "hardcore": false
}
```

The optional UUID `Idempotency-Key` should be generated once per drop and reused
on retries. Identical fields, exact chat message and decoded PNG pixels (if any) return the original receipt,
including after review/restart. Changing the payload with that key returns
**409**. Without a key, the server assigns a fresh request key; the cross-client
duplicate filter below still applies. Replays must
use the same normalized world-type set; changing modes or any flag returns
**409**. Historical receipts created before world-type support can replay as
ordinary-world requests with the original payload; requesting HC with their
key returns **409**. Their original receipt is retained and may omit `hardcore`.
Replays must still pass the blocked-world validation above, match the configured
in-game clan when matching is enabled and, when required, use the current
API key. Credentials are not part of the immutable submission payload, so a
retry using a newly rotated key can recover its original receipt. A future plugin should retain the
key, payload and optional PNG until it receives the receipt. Changing the chat
message or adding/removing a screenshot under the same key returns **409**.
Historical screenshot-only receipts can still replay their original payload
without `chatMessage`; this exception cannot create a new submission.

Independent clients observing the same player and canonical item in the same
world mode within one minute share the first submission. This applies even when
their request keys, game-item variants, chat messages or screenshots differ. Player matching
normalizes case, underscores, nonbreaking spaces and repeated whitespace.
The window starts at the first accepted request and duplicates do not extend it.
The API returns **201** with the original receipt plus `duplicate: true`, stores
the new request key for durable retries and discards the duplicate screenshot.
The first submission's proof remains the review evidence; later duplicate chat
messages do not overwrite it.
It creates no extra claim, credit or review entry. Regular and hardcore events
are separate. A new key after the minute can create a new claim; retrying an
existing key always retains its original receipt. Staff corrections do not
change the recorded event identity.

The **Filter out duplicates** toggle on **Submissions**, between manual
submission and the queue, checks items already credited in that world mode.
New RuneLite claims return **201** with `status: "rejected"` and are stored with
a reason explaining that the duplicate filter is on. Discord intake continues
to reject these claims with **403**. The filter defaults to off and
can be changed only by the administrator; moderators can view its current state.
Manual staff entry remains available
for backfilling achievements. Replays and recognized one-minute duplicates
retain their successful receipt. CSRF-protected
`PUT /api/v1/admin/submission-filters` accepts `{ filterCollected,
expectedRevision }` using the `submission-filters-N` revision supplied by the
queue or `GET` on that route. Changes are versioned and audited; stale writes
return **409**.

Browser uploads are allowed from **https://kihiralove.github.io** only on the
public RuneLite submission endpoint. Its unauthenticated `OPTIONS` preflight
allows `POST` with `Content-Type`, `Idempotency-Key`, `X-Clan-API-Key` and
`X-Clan-API-Key-Base64`. Actual uploads still require the configured clan/key
checks. Successful and error responses expose CORS headers, including access to
`Retry-After` and `X-Error-Category`. Staff routes and cookies are not exposed.

Malformed multipart or an invalid attached PNG returns **400**, oversize uploads **413**,
rate limits **429** with `Retry-After: 60`, and unavailable database/storage
**503**. Uploads are limited to ten requests per client IP per minute and 120
globally per minute, shared across API processes. Configure the existing trusted
proxy chain correctly so the API can distinguish visitor IPs. PNGs must be still
images, at most 8192 pixels per side and 32 megapixels. They are decoded and
re-encoded, discarding metadata and original filenames.

## Website settings and manual submissions

The admin's **Site settings → Clan display name** defaults to `Clan name`. Saving updates
the public header, admin heading and document title independently of intake
validation. Public tabs refresh settings every 25 seconds or
when returning to the tab. `GET /api/v1/settings` returns `revision`,
`hardcoreEnabled` and `clanName`. Admin-only, CSRF-protected
`PUT /api/v1/admin/settings` accepts those values with `expectedRevision`.
Concurrent settings writes return **409**; both previous/new clan names are
recorded with the authenticated admin's audit entry. Existing clients can omit
`clanName` on writes to preserve the saved name. Moderators cannot change it.

On **RuneLite submissions** (`/admin/runelite`), administrators and moderators
can view and copy the **Current shared API key**. Only the administrator can
click **Generate new key** or enter a replacement key of at least 8 characters.
**Save API key settings** saves the key;
generating only fills the draft until it is saved.
The key remains visible with the requirement disabled; replacement controls are
shown only to the administrator. Both staff roles can edit automatic review settings.
Selecting **Clan name** preserves the saved key and accepts matching-clan
submissions without checking their key header. **API key** and **Both** require
the current key. Normal payload/PNG checks still apply. Rotating the key preserves
the selected matching mode.
Rotations invalidate the previous key immediately, including uploads that
started before rotation but have not committed.

**Automatic review** on this page provides **Clan matching**, a separate
**In-game clan name for matching**, world-policy dropdowns and a player whitelist.
The migration seeds the matching name from the existing visual clan name once;
subsequent changes to either name do not affect the other. **Clan name** checks
only this in-game name; **API key** checks only the key and retains the submitted
clan name as provenance; **Both** requires both to match. Matching ignores case
and surrounding spaces. **Save review settings** updates the selected name/key
requirements together in one transaction with both revisions and audits.

| World flags                    | Available policy                   |
| ------------------------------ | ---------------------------------- |
| `F2P` (plugin-provided), `PVP` | Reject, Send to review, Auto allow |
| `MEMBERS`, `HARDCORE_MAIN`     | Send to review, Auto allow         |

For combined flags, any rejection wins; otherwise review wins over auto allow.
Flags without a configured category (including `[]`) go to review. A whitelist
match overrides review after all world rejection checks. Player names ignore
case, surrounding/repeated spaces and the difference between underscores,
nonbreaking spaces and ordinary spaces. The list supports up to 200 names, one
per line. Neither whitelisting nor auto allow bypasses clan/key, catalog or PNG
validation. Auto approvals grant collection credit immediately and append an
audit attributed to **RuneLite auto review**. If an approved credit already
exists for the canonical item and world mode, the new claim remains pending
with an audit explaining why approval was deferred. Replays retain their
original pending/approved/rejected receipt after policy, filter or whitelist
changes. With **Filter out duplicates** enabled, already-credited items create
a rejected submission instead of another pending claim.

Staff-only `GET /api/v1/admin/runelite-settings` returns private rules with a
`runelite-N` revision. CSRF-protected `PUT` replaces the complete rules and
requires `expectedRevision`; stale writes return **409**. For example:

```json
{
  "expectedRevision": "runelite-1",
  "matchClanName": true,
  "clanName": "In-game Clan",
  "worldPolicies": {
    "f2p": "reject",
    "pvp": "review",
    "members": "allow",
    "hardcore": "review"
  },
  "playerWhitelist": ["Trusted Player"]
}
```

Rules and whitelist names are absent from public settings. Writes append an
staff audit and lock the rules used by in-flight intake transactions.
The UI also supplies `clanKeyRequirement: { enabled, expectedRevision }` to the
rules PUT. Its key revision is `clan-key-N`; a stale key revision rolls back the
entire write. The receipt includes `clanKeyRequirement: { enabled, revision }`.
Older clients can omit this field to preserve the existing key requirement.

When [collection log scheduling](collection-log-scheduling.md) is enabled, a new
regular-world RuneLite claim must also belong to at least one currently open active page.
Whitelist and world auto allow settings cannot bypass closed pages. Previously
saved retries still return their original receipt after a page closes.
Hardcore claims bypass scheduling; all active hardcore pages remain open.

Staff-only `GET /api/v1/admin/clan-api-key` returns `{ revision, enabled, key }`.
Administrator-only, CSRF-protected `PUT` requires `expectedRevision` (`clan-key-N`) and accepts
`enabled`, `key`, or `generate: true`. `key` and `generate` are mutually exclusive.
Generated keys contain exactly 32 hexadecimal characters. Custom keys accept
any valid Unicode characters, at least 8 code points, including symbols,
whitespace and line breaks. Values are preserved exactly, without trimming.
Keys shorter than 8 characters return **422**.
Stale updates return **409**. Moderators can read but cannot replace keys.
Public settings endpoints never expose keys; the shared key authorizes only RuneLite intake,
not staff tools or Discord bot operations. The key header is redacted from API
logging, and audits record actor, enabled changes and whether rotation occurred
without storing the key value. Both supported key headers are redacted.

For a key containing characters that cannot travel literally in HTTP headers
(Unicode, line breaks, leading/trailing whitespace or controls), send
`X-Clan-API-Key-Base64` with the exact key encoded as UTF-8 then unpadded
base64url. Send one key header only. For example, the Java plugin can use
`Base64.getUrlEncoder().withoutPadding().encodeToString(key.getBytes(StandardCharsets.UTF_8))`.
Existing `X-Clan-API-Key` clients continue working with ordinary header-safe
keys. Wrong, ambiguous or malformed credentials return **401** when enforcement
is enabled; disabled enforcement ignores key headers.

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

[`023_runelite_chat_proof.sql`](../packages/database/migrations/023_runelite_chat_proof.sql)
adds a nullable private chat-message column and permits chat proof without an
image. Existing screenshot-only claims, receipts, audits and files are retained.
Apply the migration before starting the updated API. Runtime table grants cover
the new column; normal bootstrap still verifies them. Take a coordinated backup
before upgrading; older images require their matching pre-023 backup.

Forward-only migration
[`004_runelite_submissions.sql`](../packages/database/migrations/004_runelite_submissions.sql)
adds clan settings/audit columns, screenshot metadata/provenance and immutable
RuneLite receipts. Existing Discord/manual rows and receipts remain valid.
Normal bootstrap applies it and reconciles runtime grants; no database reset
is required.

[`005_clan_api_keys.sql`](../packages/database/migrations/005_clan_api_keys.sql)
adds the key singleton and append-only key audit. Startup creates the default
enabled key only when absent, including on upgrades from clan-name-only intake.
Existing keys of at least 8 characters are preserved, regardless of their
format. Startup replaces only historical keys shorter than 8 characters once,
under a row lock, and records a `system:minimum-key-length-upgrade` audit entry.
The enabled/disabled setting is preserved. A previously short key stops working
when enforcement is on; configure clients with the displayed replacement.
The key is encrypted with AES-256-GCM in PostgreSQL. Its encryption root is
created atomically as a private 32-byte file, `.clan-api-key.secret`, in the
screenshot volume; the standard screenshot archive includes this file too.
Database dumps alone do not contain the plaintext shared key. Public upload
authentication compares key digests in constant time and rechecks the current
requirement under a database lock when committing the pending submission.

[`009_runelite_world_types.sql`](../packages/database/migrations/009_runelite_world_types.sql)
adds nullable original world flags. Existing claims and immutable receipts
remain valid and keep their current world mode; new claims retain normalized
flags and include the mode in their receipt. No new volume or secret is needed.

[`012_runelite_auto_review.sql`](../packages/database/migrations/012_runelite_auto_review.sql)
adds private versioned rules and an append-only administrator audit. All policies
default to review, with clan matching enabled and an empty whitelist. Apply the
migration and runtime-role bootstrap before starting the updated API. No new
volume or secret is needed. Take a coordinated backup before upgrading: earlier
API images do not enforce these configurable rules and still match the visual
clan name, so reverting requires the matching pre-upgrade image and backup.

[`022_submission_duplicate_filters.sql`](../packages/database/migrations/022_submission_duplicate_filters.sql)
adds the versioned intake filter, append-only setting audit and immutable
RuneLite event identities. It backfills the recent one-minute window from
existing receipts. Apply migration and runtime grants before starting this
API; an older image requires its matching pre-upgrade backup. No new volume or
secret is needed.

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

Rolling back to an image that requires hex-only keys or lacks world-type intake
requires its matching pre-upgrade database and image-volume backup. A hex-only
image can replace a valid custom key during startup.

An older image is incompatible with the new submission sources/settings once
RuneLite claims exist. Recovery to such an image requires the coordinated
pre-upgrade database and image-volume backup. Keep orphaned PNGs after an
uncertain database/storage failure until a maintenance check confirms that no
submission references their generated UUID; never delete referenced evidence.
