# API contracts

All routes use same-origin `/api/v1` paths. Public catalog, collections,
settings, branding, activity and XP reads use validated snapshots; projection
routes return ETags for conditional requests. Private reads are `no-store`.
See route modules under [apps/api/src](../apps/api/src) for complete wire schemas.

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

Staff writes require a verified session, Origin, CSRF token and current expected
revision. Reusing an already consumed idempotency key with different data conflicts.
Successful replay returns the saved receipt. Auth failures are 401/403; stale
state is 409; malformed or unsupported input is 400/422. A timeout cannot prove
rollback: preserve the retry key and reconcile the original operation.

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
remains administrator-only. Selected active pages stay open outside timed windows;
hardcore intake stays independently open.

Valid RuneLite intake returns 201 with a durable submission receipt, including
automatic rejection by duplicate, scheduling or world-review policy. Structural,
authentication and excluded-world failures remain errors. Private chat proof and
screenshots never appear in public credits. See [RuneLite](runelite-submissions.md).

XP gains are nonnegative integer strings, never floating-point numbers. WOM metric
weights and combined/computed scores use canonical decimal strings. Competition
metadata can include `metricDefinitions`; finished previews include `standings`
with per-metric `deltas`. Public XP events include a `competition` summary with at
most three standings; public activity reads expose metadata only. Imports
are previewed and applied transactionally; refreshing replaces a prior event's
contribution. [Competition rules](wom-competitions.md) define lifecycle and corrections.
