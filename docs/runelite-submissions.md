# RuneLite submissions and private proof

`POST /api/v1/runelite/submissions` accepts `multipart/form-data` with exactly
these fields (their order does not matter):

| Field         | Value                                                           |
| ------------- | --------------------------------------------------------------- |
| `username`    | Collector name, 1–80 characters                                 |
| `clanName`    | In-game clan name, 1–80 characters                              |
| `itemId`      | Positive OSRS game item ID, as decimal text                     |
| `itemName`    | Optional submitted name, nonempty, up to 200 characters, no NUL |
| `worldType`   | World type identifier or JSON array of identifiers              |
| `chatMessage` | Required full chat message, nonempty, up to 8192 UTF-8 bytes    |
| `screenshot`  | Optional PNG file, MIME `image/png`, up to 10 MiB               |

```bash
curl --fail-with-body https://your-clan.example/api/v1/runelite/submissions \
  -H 'X-Clan-API-Key: YOUR_CLAN_SHARED_KEY' \
  -H 'Idempotency-Key: 00000000-0000-4000-8000-000000000001' \
  -F 'username=Collector' -F 'clanName=Clan name' -F 'itemId=4151' \
  -F 'itemName=Abyssal whip' -F 'worldType=["MEMBERS"]' \
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
with `status: "pending"`, `"approved"` or `"rejected"`. Configured world-policy
and regular-duplicate rejections are saved with their
proof, rejection reason and a **RuneLite auto review** audit entry. They appear
in the staff **Reviewed** queue and grant no collection credit.

The game ID resolves through `game_item_ids` to an active canonical catalog
item. Variant IDs can resolve to the same item. Unknown, unmapped and inactive
items are accepted as **unmatched** submissions with a nullable canonical ID,
not added to the catalog automatically. They stay pending for staff even under
auto-allow policies; unrelated world-policy rejections still apply. Unmatched
claims are not rejected for closed pages or filtered as collected items. Original
receipt time and schedule/page membership determine their type when staff save a match.

`itemName` is preserved as evidence, never used for automatic name matching.
Older clients can omit it: known items use the catalog name; unknown items use
a name recovered only from recognized drop/collection messages, or the explicit
**Name not supplied — game item #123** fallback. Staff can save notes or reject
an unmatched claim, but must select and save an active canonical item before
approving. Matching does not approve, create a catalog item or add a game-ID alias.
The submitted name and original **Game item ID** remain in Submission details
and review audits after corrections.

Receipt `itemId` is the **canonical** ID, or `null` when unmatched. `gameItemId`
is the original submitted OSRS ID. Older saved receipts remain unchanged.
The server records receipt time and UTC collection date. `worldType` is required. Use a single enum name
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
  "gameItemId": 4151,
  "collectionType": "regular",
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
**409**. Replays must still pass the blocked-world validation above, match the configured
in-game clan when matching is enabled and, when required, use the current
API key. Credentials are not part of the immutable submission payload, so a
retry using a newly rotated key can recover its original receipt. A future plugin should retain the
key, payload and optional PNG until it receives the receipt. Changing the chat
message or adding/removing a screenshot under the same key returns **409**.

Independent clients observing the same player and canonical item (or the same
original game ID when unmatched) in the same
world mode within five seconds share the first submission. This applies even when
their request keys, game-item variants, chat messages or screenshots differ. Player matching
normalizes case, underscores, nonbreaking spaces and repeated whitespace.
The window starts at the first accepted request and duplicates do not extend it.
The API returns **201** with the original receipt plus `duplicate: true`, stores
the new request key for durable retries and discards the duplicate screenshot.
The first submission's proof remains the review evidence; later duplicate chat
messages do not overwrite it.
It creates no extra claim, credit or review entry. Regular and hardcore events
are separate. A new key after five seconds can create a new claim; retrying an
existing key always retains its original receipt. Staff corrections do not
change the recorded event identity.
Adding a mapping between deliveries also reuses the original receipt and proof;
it does not silently match the saved submission. A supplied `itemName` participates
in request-key conflict checks. Legacy requests without it retain their original hashes.

The **Filter out regular duplicates** toggle on **Submissions**, between manual
submission and the queue, checks approved **Regular** credits in that world mode.
New RuneLite claims return **201** with `status: "rejected"` and are stored with
a reason explaining that the duplicate filter is on. Discord intake continues
to reject these claims with **403**. The filter defaults to off and
can be changed only by the administrator; moderators can view its current state.
Staff approvals, approved manual entry and credit-moving corrections enforce
the same policy. When off, repeated Regular credits are allowed, even for the
same collector. Re-enabling preserves history. Event credits are independent:
one approved Event credit per normal-world canonical item overall. Replays and recognized five-second duplicates
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

The admin's **Site settings → Displayed clan name** defaults to `Clan name`. Saving updates
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

**Automatic review** on this page provides **Match Clan name or API**, a separate
**In-game clan name for matching**, world-policy dropdowns and a player whitelist.
Fresh setup uses Clan name as the in-game matching name;
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
audit attributed to **RuneLite auto review**. If an approved Event credit already
exists for the canonical item, another Event claim remains pending
with an audit explaining why approval was deferred. Replays retain their
original pending/approved/rejected receipt after policy, filter or whitelist
changes. With **Filter out regular duplicates** enabled, a new Regular claim for
an item with an approved Regular credit in that mode creates a rejected submission.

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

Scheduling classifies collection type and never closes intake. An active timed
normal-world page qualifies a drop as `collectionType: "event"`, excluding pages
selected permanently open. Closed/unscheduled pages, disabled scheduling,
permanent pages and all hardcore claims use `"regular"`. A shared item qualifies
if another associated nonpermanent page has an active timed window. Start is
inclusive and end exclusive, using one server receipt time in UTC. Unmatched
normal claims can have `collectionType: null` while waiting for a canonical match.
Frozen evidence determines their type on resolution; staff can make an audited
explicit correction. Receipts never change on retry, including legacy receipts
that omit `collectionType`.

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
`/api/v1/admin/submission-images/<generated-uuid>.webp` with no-store caching.
PNG uploads are converted to lossless WebP before storage; only WebP is saved
and served (`image/webp`). The original PNG is discarded after conversion.
Public catalog, credits and XP responses contain no proof URLs, image paths or
uploaded image data. Files remain available after approval/rejection/revocation
for later review; uploads never grant approval privileges.

## Storage and recovery

The fresh-install baseline creates all intake tables. API startup generates an
enabled shared key only when absent. Keys are encrypted in PostgreSQL with a
root stored as .clan-api-key.secret in the private proof volume. Keep the DB,
proofs, catalog/branding volume and private configuration together in backups.
A missing or wrong encryption root fails startup without replacing credentials.
See [backup and recovery](release-recovery.md).
