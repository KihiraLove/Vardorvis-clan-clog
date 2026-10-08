# API and Discord contracts

> **8 October 2026 XP-01 update:** [XP event import](xp-import.md) implements the aggregate `GET /api/v1/xp/tracker` and secured admin preview/apply/history. Earlier per-member XP routes below are superseded by the revised event-only requirement; use the new document for active endpoints.

> **8 October 2026 intake update:** [Bot intake](bot-intake.md) now implements credential-scoped catalog autocomplete and durable pending submissions, including mode, dates, matching candidates and idempotent receipts. Discord gateway handling and admin review remain separate work.

> **8 October 2026 backend update:** [Backend phase 1](backend-phase-one.md) now implements public catalog/collection reads, password sessions and authenticated persistent settings. Statements below describing those services as pending are historical; intake/review, WOM and catalog import remain pending.

> **7 October 2026 revision:** [Mockup revision](mockup-revision.md) supersedes earlier combined HC styling, multi-collector, separate XP/member-table and public Admin-link requirements. It documents current preview behavior and outstanding live API work.

The routes marked as implemented in [backend phase one](backend-phase-one.md) and [bot intake](bot-intake.md) are active when their services and credentials are configured. Other routes remain planned.

## Shipped foundation

| Method/path          | Behavior                                                                |
| -------------------- | ----------------------------------------------------------------------- |
| `GET /healthz`       | API liveness; 200 with service status                                   |
| `GET /readyz`        | 200 only if migrated database is available; otherwise 503               |
| `GET /api/v1/status` | `stage: foundation`, `catalogReady: false`, `submissionsEnabled: false` |

## Planned routes

| Method/path                                    | Authorization                     | Purpose                                                         |
| ---------------------------------------------- | --------------------------------- | --------------------------------------------------------------- |
| `GET /api/v1/catalog`                          | Public                            | Versioned items, tabs/pages, ordered slot IDs; ETag             |
| `GET /api/v1/collections`                      | Public                            | Approved item credits and revision; excludes evidence/actor IDs |
| `GET /api/v1/bot/items?q=...`                  | Bot credential                    | Ranked canonical autocomplete candidates                        |
| `POST /api/v1/bot/submissions`                 | Bot credential + configured guild | Idempotent intake and resolution suggestions                    |
| `POST /api/v1/auth/login`                      | Password + matching Origin        | Create an expiring admin session                                 |
| `GET /api/v1/auth/session`                     | Browser session                   | Report admin access and a session-bound CSRF token              |
| `POST /api/v1/auth/logout`                     | Session + CSRF                    | Destroy session                                                 |
| `POST /api/v1/admin/submissions`               | Admin session + CSRF              | Insert manual pending or immediately approved claim             |
| `GET /api/v1/admin/submissions?status=pending` | Admin session                     | Paginated queue including unmatched submissions                 |
| `GET /api/v1/admin/submissions/:id`            | Admin session                     | Current claim and private before/after audit history            |
| `PATCH /api/v1/admin/submissions/:id`          | Admin session + CSRF              | Resolve/edit item, collector or date with expected version      |
| `POST /api/v1/admin/submissions/:id/approve`   | Admin session + CSRF              | Atomic approval and audit event                                 |
| `POST /api/v1/admin/submissions/:id/reject`    | Admin session + CSRF              | Reject with reason                                              |
| `POST /api/v1/admin/submissions/:id/revoke`    | Admin session + CSRF              | Revoke approved credit with reason                              |

Bot writes contain `interactionId`, `guildId`, `actorDiscordId`, `rawItemText`, optional `itemId`, `collectorName` and `proofUrl`, plus optional `hardcore` (default false) and `collectedOn` (ISO `YYYY-MM-DD`). The API sets submission timestamp/date default. A later optional collection date requires a validated ISO calendar date and explicit source. The bot cannot send approval state or reviewer identity.

Intake returns 201 for a new durable pending submission, or 200 with the same receipt for an exact interaction retry. A reused interaction ID with a different payload is a 409 conflict. Return `resolution: resolved|needs_match` and canonical candidates. No fuzzy suggestion grants credit.

Review writes carry `expectedVersion`; conflicts return 409. Standard errors are `{ "error": { "code": "...", "message": "..." } }`. Use 400/422 for invalid fields, 401 for missing credentials, 403 for forbidden actors/guilds, 404 for absent resources and 429 for rate limits. Never include secrets or raw server errors.

## Frontend admin review payloads

The #8/#31 frontend and [review guide](admin-frontend-review.md) use these proposed shapes. The live REVIEW-01 API implements submissions and decisions; catalog CRUD remains separate work. All private reads use `Cache-Control: no-store`; enforce an allowlisted session on every route. Browser requests use same-origin cookies and no-store caching. Writes additionally send `X-CSRF-Token`; the server repeats all validation and derives actor identity from the session.

```ts
interface Submission {
  id: string; // opaque stable identity, encoded as a URL segment
  version: number; // positive safe integer, advances on every mutation
  source: 'discord' | 'manual'; // provenance of the claim
  itemId: number | null; // canonical ID; null means unmatched
  rawItemText: string;
  collectorName: string; // 1–80 characters after trimming
  collectedOn: string; // real YYYY-MM-DD calendar date
  dateSource: 'submission' | 'claim' | 'admin';
  submittedAt: string; // UTC ISO timestamp, ending in Z
  proofUrl: string;
  hardcore: boolean;
  status: 'pending' | 'approved' | 'rejected' | 'revoked';
}
interface ReviewAudit {
  id: string;
  actorName: string;
  at: string; // UTC ISO timestamp
  action: 'create' | 'edit' | 'approve' | 'reject' | 'revoke';
  reason: string | null;
  before: Submission;
  after: Submission;
}
```

Queue GET accepts `status=pending|reviewed`, `limit=20`, optional opaque `cursor` and optional `unmatched=true` with pending. Pending includes matched and unmatched claims; Reviewed includes approved/rejected/revoked. Return `{ revision, submissions: Submission[], nextCursor: string | null }`, ordered deterministically without duplicate rows. A stale cursor returns 409; reload from the first page. Detail GET returns `{ submission: Submission, audit: ReviewAudit[] }`, newest audit events first. Reject inconsistent canonical references; expose no private fields through public collections.

Correction PATCH carries `{ expectedVersion, itemId, collectorName, collectedOn, hardcore, reason }`; `itemId` must be a specific existing canonical item, and `reason` is trimmed and at most 1,000 characters. Only pending/approved claims can be edited. Approved corrections require a reason. Preserve the raw evidence/receipt timestamp; changing the collection date sets `dateSource: admin`.

Approve POST carries `{ expectedVersion }`; reject/revoke carry `{ expectedVersion, reason }` with a nonblank reason. Bot-submitted claims require a validated HTTPS Imgur/Gyazo proof link before approval; authenticated manual claims may be approved without an external proof link; reject permits pending unmatched/invalid-evidence claims; revoke requires approved state. These actions return the complete saved `Submission` with a higher version. Store state and audit atomically. Stale/double decisions return 409. Public credit is derived only from current approvals, so corrections/revocations update every shared occurrence. The proof checkbox is a UI acknowledgment, not an authorization field or a substitute for real inspection.

The browser blocks unsafe proof URLs but can display/reject a stored malformed claim. It never fetches or embeds submitted proof automatically. A write receipt is acknowledged even if a following audit read fails; another mutation waits for a usable current record. Conflicts reload and require explicit review/retry, never an automatic overwrite.

## Frontend public-read payload

The first frontend consumes this proposed JSON shape for #2; the foundation API does not serve it yet. Both responses have independent opaque ETags. A conditional unchanged response is 304; otherwise send a complete 200 snapshot. The client polls every 25 seconds while visible, refreshes on returning to the tab, and keeps the last successful data if a request fails. Catalog and collections must reference mutually valid canonical IDs; an inconsistent pair is rejected and neither local cache advances.

```json
{
  "revision": "catalog-42",
  "items": [
    {
      "id": 1,
      "name": "Virtus mask",
      "iconPath": "/api/v1/catalog/icons/asset-1"
    }
  ],
  "pages": [
    {
      "id": "vardorvis",
      "name": "Vardorvis",
      "category": "bosses",
      "itemIds": [1]
    }
  ]
}
```

```json
{
  "revision": "collections-42",
  "credits": [
    {
      "submissionId": "approved-submission-id",
      "itemId": 1,
      "collectorName": "KihiraVD",
      "collectedOn": "2026-10-05",
      "hardcore": true
    }
  ]
}
```

Categories are `bosses`, `raids`, `clues`, `minigames`, `other`. Array order defines page and slot order; do not sort it in the browser. Icons use same-origin absolute paths. External game IDs are not required for frontend/manual item identity. Public credit rows represent approvals only; optional `status` must be `approved` to be displayed, and absent `hardcore` defaults false. The endpoint must omit proof URLs, Discord actors, pending/rejected/revoked claims and private audit data. The browser validates IDs, relationships, dates and flags before rendering, but server authorization/projection remains authoritative.

## Discord definition

The checked-in [command builder](../apps/bot/src/command.ts) defines this schema:

| Field            | Required | Resolution                                                                     |
| ---------------- | -------- | ------------------------------------------------------------------------------ |
| `item`           | Yes      | Autocomplete canonical ID or raw text; manual resolution for uncertain matches |
| `proof`          | Yes      | HTTPS Imgur/Gyazo link; admin inspects actual evidence                         |
| `submitter-name` | No       | Collector display snapshot, default current guild name/username                |

Guild registration and gateway handling are not implemented yet. Add a separate registration script, a guild-only runtime check, 25-result autocomplete responses, ephemeral deferral/receipts, timeout/error handling and a service-authenticated API adapter. Record interaction IDs as strings; Discord snowflakes must not be converted to JavaScript numbers.

The second requested command is an open product decision. An optional explicit collection-date input is also an open decision; current date handling is documented in [requirements](requirements.md).

## Planned hardcore extension

Bot intake and admin review accept `hardcore: boolean`, default false. Public approved credits include that value, and the canonical item projection exposes `hardcoreCollected` derived from approved hardcore credits only. Include the flag in idempotency comparisons, optimistic version checks and audit before/after values. It never grants credit by itself.

The planned command adds optional `[hardcore:<true|false>]`. The original checked-in command builder above remains unchanged until #26 is implemented. See [feature behavior](planned-features.md) for red borders, the skull and exact text suffix.

## Planned competition XP API

| Method/path                             | Authorization        | Purpose                                                                                    |
| --------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------ |
| `GET /api/v1/xp/skills`                 | Public               | Exact cumulative site XP totals per skill and projection revision                          |
| `GET /api/v1/xp/skills/:skill/members`  | Public               | Per-member cumulative gained XP, keyed by WOM player ID                                    |
| `GET /api/v1/xp/competitions`           | Public               | Imported competition metadata, skills, source links and last successful refresh            |
| `GET /api/v1/xp/competitions/:id`       | Public               | Every imported competitor's gains by skill; includes zero/unavailable rows                 |
| `POST /api/v1/admin/xp/imports/preview` | Admin session + CSRF | Fetch/validate a supplied competition link and show skill/participant/contribution changes |
| `POST /api/v1/admin/xp/imports`         | Admin session + CSRF | Apply the validated preview with request idempotency and expected stored revision          |
| `GET /api/v1/admin/xp/imports`          | Admin session        | Import history, reconciliation decisions and errors                                        |

Preview input is `competitionUrl`. Extract a canonical WOM competition ID; ignore URL fragments/query variants for identity and use the fixed official API origin. The response includes a short-lived preview/snapshot token, expected import revision, competition/skill details, complete competitor rows, and per-skill before/after/change values. Applying a preview records the authenticated actor, reconciles the unique stored competition/player/skill contributions atomically, and returns unchanged/applied with the resulting revision. An unchanged refresh has zero XP change. Reused request keys with different payloads or stale revisions return 409.

Use integer decimal strings for XP totals/contributions in the public/admin JSON contract to preserve exact accumulation. Missing source XP is `null` with an explicit availability state; zero is a valid gain. Client rendering distinguishes competition gained XP, member cumulative gained XP and site cumulative skill XP. No endpoint treats weighted scores, boss kills, activity points, EHP/EHB or aggregate overall values as skill XP.

## Frontend XP payloads

The XP frontend in #28 consumes the following proposed shapes; the backend in #27/#4 must still implement them. [xp-model.ts](../apps/web/src/xp-model.ts) defines the decoded view types and [xp-api.ts](../apps/web/src/xp-api.ts) implements the transport validation.

```ts
type SkillId =
  | 'attack'
  | 'hitpoints'
  | 'mining'
  | 'strength'
  | 'agility'
  | 'smithing'
  | 'defence'
  | 'herblore'
  | 'fishing'
  | 'ranged'
  | 'thieving'
  | 'cooking'
  | 'prayer'
  | 'crafting'
  | 'firemaking'
  | 'magic'
  | 'fletching'
  | 'woodcutting'
  | 'runecrafting'
  | 'slayer'
  | 'farming'
  | 'construction'
  | 'hunter'
  | 'sailing';
type Xp = string; // unsigned canonical decimal integer, at most 100 digits
type Revision = string; // nonempty opaque global XP projection revision
interface Competition {
  id: number; // positive safe integer WOM competition ID
  title: string;
  sourceUrl: string; // canonical https://wiseoldman.net/competitions/<id>
  skills: SkillId[]; // nonempty, unique; overall must be expanded by the backend
  startsAt: string; // ISO timestamp in UTC, ending in Z
  endsAt: string; // later than startsAt
  importedAt: string; // last successful refresh in UTC
}
interface Participant {
  playerId: number; // positive safe integer stable WOM player ID, unique in rows
  displayName: string;
  gains: Partial<Record<SkillId, Xp | null>>; // exactly every competition skill
}
interface Change {
  skill: SkillId;
  before: Xp;
  after: Xp;
  change: string; // signed canonical integer: after - before; no leading "+"
}
```

| Endpoint                                | Complete 200 payload                                                                                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/xp/skills`                 | `{ revision, updatedAt: string \| null, skills: Array<{ skill: SkillId, xp: Xp }> }`; exactly all 24 skills, zeros before imports                        |
| `GET /api/v1/xp/skills/:skill/members`  | `{ revision, skill: SkillId, members: Array<{ playerId, displayName, xp: Xp \| null }> }`; all members with contributions for this skill                 |
| `GET /api/v1/xp/competitions`           | `{ revision, competitions: Competition[] }`; all imported competitions                                                                                   |
| `GET /api/v1/xp/competitions/:id`       | `{ revision, competition: Competition, participants: Participant[] }`; metadata identical to the list entry, all competitors                             |
| `POST /api/v1/admin/xp/imports/preview` | `{ previewToken, expectedRevision, expiresAt, competition, participants, changes: Change[], warnings: string[] }`; exactly one change per selected skill |
| `POST /api/v1/admin/xp/imports`         | `{ outcome: "applied" \| "unchanged", revision }`                                                                                                        |
| `GET /api/v1/admin/xp/imports`          | `{ imports: Array<{ id, competitionId, title, actorName, importedAt, outcome, changes: Change[] }> }`; newest first, IDs unique                          |

All public wrappers use the same global projection revision, and each route has its own opaque ETag. Send complete snapshots or 304 to conditional GETs. The frontend advances its caches only when totals, list, selected members and selected competition agree. Serving one revision-consistent transaction/projection per refresh is required; concurrent updates may produce a rejected mixed read which is retried. Public responses must exclude session/Discord identities, CSRF tokens and private import audit entries. Member names remain display values; identity is the WOM player ID.

Missing gains use `null` as their explicit unavailable state; never coerce them to valid zero XP. Member cumulative amounts sum known stored contributions, with `null` when none are usable. Total skill XP sums known contributions and remains an unsigned exact integer. No fractional values, negative source sentinel values, duplicate skill/player IDs, missing selected metrics or unknown metrics are accepted. UTC timestamps include seconds and optional 1–3 fractional digits. Display dates are UTC; labels truncate to two million decimals and tooltips show the original exact amount.

`GET /api/v1/auth/session` returns `{ authenticated: true, displayName, csrfToken }` for an allowlisted admin, or `{ authenticated: false }`/401 for no usable admin session. The browser retains the token in component memory only and sends cookies with `credentials: same-origin`. Return no reusable token to an unauthorized account. Keep session cookies HttpOnly/Secure/SameSite and enforce authorization/CSRF on the server.

Preview body: `{ "competitionUrl": "https://wiseoldman.net/competitions/1001" }`. The browser strips queries/fragments, rejects non-HTTPS/spoofed/credentialed URLs and verifies returned source ID equals the requested ID. The server must repeat input validation, use its fixed WOM API origin, and bind the short-lived token to the authorized actor, validated source snapshot and expected projection revision.

Apply body: `{ "previewToken": "...", "expectedRevision": "..." }`. Both POSTs send `Content-Type: application/json` and `X-CSRF-Token`; apply also sends `Idempotency-Key`. Do not accept caller-supplied gains or actor names. Retry the identical token/key after an uncertain network result; conflicting keys/stale tokens return 409. An unchanged refresh adds no XP and still records its refresh outcome. Corrections may have a negative change while before/after totals remain unsigned; the UI requires acknowledgment before applying those previews. Server reconciliation, transaction safety, authorization and source validation remain authoritative.

## Planned admin catalog API

| Method/path                                     | Authorization        | Purpose                                                                            |
| ----------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------- |
| `GET /api/v1/admin/catalog`                     | Admin session        | Complete canonical items/pages, provenance, override metadata and page versions    |
| `POST /api/v1/admin/catalog/icons`              | Admin session + CSRF | Validate a multipart raster upload; return a staged generated asset ID and preview |
| `POST /api/v1/admin/catalog/items`              | Admin session + CSRF | Create one canonical item and its selected page memberships                        |
| `PUT /api/v1/admin/catalog/pages/:pageId/order` | Admin session + CSRF | Save an exact membership permutation with expected page revision                   |
| `GET /api/v1/catalog/icons/:assetId`            | Public               | Serve published referenced icon content through same-origin URLs                   |

Item creation requires `name`, `iconAssetId` from a validated upload, and a nonempty unique `pageIds` list of existing pages. External game IDs are optional. Allocate the canonical ID server-side; record the actor from the session. Verify the staged icon is usable, create the item and all memberships atomically, append to each page, advance affected page/catalog revisions and publish the icon reference only after success. Invalid/unknown fields or pages fail the entire operation. Item creation cannot accept collection credits, review status or an effective hardcore flag.

The #31 frontend reads the complete private catalog rather than a separate per-page items route. It returns the public catalog shape plus `sourceRevision: string | null`, item `origin: source|manual` and unique `overrides: Array<name|icon|pages>`, and page `version: string` and `orderOrigin: source|manual`. The source revision and all revisions are opaque nonempty strings. Public snapshots omit private provenance/version fields; runtime UI preserves supplied slot order.

Upload POST is multipart with one `icon` file, and returns `{ assetId, iconPath, expiresAt }`. Accept decoded PNG/WebP only, nonempty and at most 2 MiB, each dimension 1–512 pixels; independently verify MIME/signature, bound decoder resources, retain transparency and generate asset identities instead of using file names as paths. Return a same-origin absolute preview path and UTC expiry, bound to the admin session. Preview uses a 15-minute staging expiry. Never accept arbitrary icon URLs or browser-only blob paths on the live API.

Creation POST sends `{ name, iconAssetId, pageIds }`, with `X-CSRF-Token` and `Idempotency-Key`. Name is trimmed and 1–200 characters; page IDs are unique existing memberships. Return 201 for creation or 200 for an exact retry with `{ item, pageIds, catalogRevision }`; `item` includes manual provenance and override metadata. Save the request fingerprint/receipt atomically so retrying the same key cannot allocate another identity or duplicate memberships, even if its staged asset was already promoted. A reused key with different fields returns 409. Preview keeps uncertain requests and keys in form memory until a receipt is received.

Reorder input is `orderedItemIds` plus `expectedVersion` for that page. Require every current member exactly once, with no missing, duplicate or foreign item. Membership changes and competing reorder saves invalidate the expected revision and return 409. Apply slots atomically without transient unique-slot collisions. Return the resulting order/version; preserve canonical IDs, other pages and approved credits. Unauthorized writes are rejected using the same session/CSRF rules as review.

The order receipt is `{ page, catalogRevision }`; `page` has complete public page fields plus its new `version` and `orderOrigin: manual`, and exactly the requested ordered IDs. `expectedVersion` is the saved opaque page version. A conflict reloads the complete private catalog; clients must review the latest membership/order before saving another permutation. Failed saves must not publish a partial order.

Creation/order writes invalidate the public catalog revision and bot autocomplete cache. Reads include manual items without game IDs. Uploaded assets live outside the Docker image and survive restarts/upgrades. Catalog action auditing and manual override/source reconciliation are distinct from submission review auditing.

Only the foundation endpoints listed at the top are implemented. Frontend consumers are in #8/#28/#31; live routes and persistence remain #4/#7/#26/#27/#30.

## Sources checked for platform constraints

- [Discord application command structures, choice limits and autocomplete](https://docs.discord.com/developers/interactions/application-commands)
- [Discord interaction delivery and responses](https://docs.discord.com/developers/interactions/receiving-and-responding)
- [GitHub Container Registry authentication and package visibility](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- [Docker multi-platform GitHub Actions builds](https://docs.docker.com/build/ci/github-actions/multi-platform/)

- [Wise Old Man competition endpoint and metrics preview](https://docs.wiseoldman.net/api/competitions/competition-endpoints)
- [Wise Old Man metrics and per-participant delta entities](https://docs.wiseoldman.net/api/competitions/competition-type-definitions)
- [Wise Old Man supported skill/metric definitions](https://docs.wiseoldman.net/api/global-type-definitions)
