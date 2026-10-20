# API contracts

All routes use same-origin `/api/v1` paths. Public catalog, collections,
settings, branding, activity and XP reads use validated snapshots; projection
routes return ETags for conditional requests. Private reads are `no-store`.
See route modules under [apps/api/src](../apps/api/src) for complete wire schemas.

`GET /discord/status` returns only `enabled`, `ready` and a `state` of `disabled`,
`connecting`, `connected`, `disconnected` or `unavailable`. Connected requires
both the gateway and intake API. Non-ready enabled states return 503; disabled
returns 200 without probing the bot. Website readiness is independent.

| Area                | Main routes                                                                         |
| ------------------- | ----------------------------------------------------------------------------------- |
| Public log          | `GET /catalog`, `GET /collections`                                                  |
| Public settings     | `GET /settings`, `GET /branding`, `GET /branding/hardcore`                          |
| Public competitions | `GET /competitions/activities`, `GET /xp/tracker`                                   |
| Staff session       | `POST /auth/login`, `GET /auth/session`, `POST /auth/logout`                        |
| Staff review        | `GET /admin/submissions` and per-submission correction/note/decision/audit routes   |
| Catalog             | Section/page/item routes under `/admin/catalog`                                     |
| Scheduling          | `/admin/schedules`, `/admin/schedules/settings`, `/admin/schedules/permanent-pages` |
| Imports             | `POST /admin/competitions/preview`, `POST /admin/competitions/imports`              |
| RuneLite            | `POST /runelite/submissions` multipart intake                                       |
| Discord             | `/bot` routes using the configured service credential                               |

Unknown competition metrics return HTTP 422 with code `UNKNOWN_WOM_METRICS`
and a `resolution` containing bounded source metadata, unknown keys, active
page choices, an expiring actor-bound `resolutionToken` and a `metrics-N` revision.
`POST /admin/competitions/metrics` accepts `{ resolutionToken, expectedRevision,
definitions }` and a UUID `Idempotency-Key`. Each definition contains `metric`,
`name`, `type` (`BOSS`, `ACTIVITY`, `COMPUTED` or `SKILL`), `pageIds`, and a supported
`skill` only for SKILL. The receipt returns `revision` and `savedMetrics`.
Saving definitions creates no competition or schedule; request a fresh preview
before Apply. Custom semantics are included in saved `metricDefinitions` so
public/admin validation uses the same frozen definition.

Staff writes require a verified session, Origin, CSRF token and current expected
revision. Reusing an already consumed idempotency key with different data conflicts.
Successful replay returns the saved receipt. Auth failures are 401/403; stale
state is 409; malformed or unsupported input is 400/422. A timeout cannot prove
rollback: preserve the retry key and reconcile the original operation.

Pending `POST /admin/submissions/:id/approve` and `/reject` optionally accept
`flags` alongside `expectedVersion` (and the rejection `reason`). Flags contain
`hardcore` and either `collectionType` (`regular`/`event`) or `useIntakeTiming: true`.
Omitting flags preserves the saved classification. Both flags and the decision
save in one transaction/revision/audit. Hardcore permits Regular only; manual
claims cannot use intake timing. Approved credits use the separate
`PATCH /admin/submissions/:id/flags` with `expectedVersion`, `flags` and an audit
`reason`. It changes no item, collector, date or review note. Revoke accepts no
flags; save/discard their draft first. All credit moves enforce duplicate rules.

`POST /bot/submissions` requires the bot credential and multipart fields
`submission` (JSON) and `screenshot` (one PNG, up to 10 MiB). JSON contains
`interactionId`, `guildId`, `actorDiscordId`, `rawItemText`, `collectorName`,
optional canonical `itemId` and optional `hardcore` (default false). Caller dates,
decision fields and external proof URLs are rejected. The image is fully decoded,
bounded to 8192 pixels per side/32 megapixels, and saved only as private lossless
WebP. The Discord interaction ID binds metadata and image content: exact replay
returns the original receipt with 200; new intake returns 201; changed data conflicts.
Staff manual entry keeps optional PNG upload and RuneLite keeps chat proof.
The former manual `proofUrl` field accepts only an empty compatibility value;
historical URL data remains in audit/receipt records and is not new proof.

`GET /settings` publishes `howToSubmitMarkdown`, shared by all public views.
Administrator-only `PUT /admin/settings` accepts this optional field alongside
`hardcoreEnabled` and `expectedRevision`. Omission preserves saved content; an
empty string uses default instructions in the UI. The maximum is 32,768 UTF-8
bytes with no NUL characters. Saves advance the settings ETag and audit the old
and new text. Markdown is rendered without raw HTML or embedded images, with
safe links opening separately. This content is public; do not include secrets.

Settings also publish `eventHighlight` and `hardcoreHighlight`. Each is an RGBA
object: integer `red`, `green`, `blue` channels from 0–255 and numeric `alpha`
from 0–1. The same administrator endpoint accepts either optional colour;
omission preserves it. Writes validate channels, check the shared revision,
audit both old/new colours and refresh the public ETag. Defaults are opaque
gold (231,189,82) and red (255,41,41).

Review queries return at most 20 rows plus an opaque next cursor. Cursors bind
filters/revision and cannot combine different snapshots. Audit and import history
are similarly bounded. Approval requires saved proof acknowledgement and a matched
canonical item; reasons are required for rejection, revocation and approved-credit
corrections. Notes are independently versioned staff comments.

Scheduling reads include `permanentlyOpenPageIds`, independently from timed windows.
`PUT /admin/schedules/permanent-pages` replaces the selection using `pageIds` (up to
2,000 distinct active pages; an empty array clears it) and `expectedRevision`.
Selections, windows and the scheduling switch share a revision and audit history.
The Scheduling page permission allows selection edits; enabling/disabling scheduling
remains administrator-only. Scheduling classifies collection type; every page
accepts intake. Timed nonpermanent normal-world pages qualify Event collections;
permanent pages, disabled scheduling and hardcore produce Regular collections.

Valid RuneLite intake returns 201 with a durable submission receipt, including
automatic rejection by regular-duplicate or world-review policy. Structural,
authentication and excluded-world failures remain errors. Private chat proof and
screenshots never appear in public credits. See [RuneLite](runelite-submissions.md).

Submissions and new receipts include `collectionType` (`regular`, `event`, or
`null` for unmatched normal claims awaiting classification). Manual creation and
claim corrections accept an optional explicit Regular/Event type. Automatic claims
resolve from frozen intake evidence; `useIntakeTiming: true` restores this after
a staff override. Omitted fields preserve an existing explicit override. Hardcore rejects Event.
Approved public credits include a nonnullable type. Public history contains every
approved credit; progress counts distinct items. One normal-world Event credit is
allowed per item. The regular duplicate switch governs Regular credits in each
world mode. Existing receipts/audits keep their original JSON; older omitted
types display as Regular. See [staff rules](staff-guide.md).

XP gains are nonnegative integer strings, never floating-point numbers. WOM metric
weights and combined/computed scores use canonical decimal strings. Competition
metadata can include `metricDefinitions`; finished previews include `standings`
with per-metric `deltas`. Public XP events include a `competition` summary with at
most three standings; public activity reads expose metadata only. Imports
are previewed and applied transactionally; refreshing replaces a prior event's
contribution. [Competition rules](wom-competitions.md) define lifecycle and corrections.
