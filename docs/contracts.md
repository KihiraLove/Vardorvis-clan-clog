# HTTP and Discord contracts

This indexes implemented contracts. The [current inventory](current-state.md)
records configuration, architecture and remaining acceptance. Detailed linked
feature guides own their request/response shapes; historical proposed member XP
routes and OAuth administration are superseded.

## Health and public reads

| Method/path                                      | Contract                                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `GET /healthz`                                   | Nginx liveness publicly; API liveness on its internal port.                                             |
| `GET /readyz`                                    | API accepting work and bounded database probe; 503 on outage/drain. Optional Discord does not block it. |
| `GET /api/v1/status`                             | Configured feature/catalog status, not a fixed foundation response.                                     |
| `GET /api/v1/discord/status`                     | Only enabled/ready booleans; enabled unavailable gateway/intake returns 503.                            |
| `GET /api/v1/catalog`, `GET /api/v1/collections` | Versioned canonical catalog and approved mode-specific credits, ETag/304.                               |
| `GET /api/v1/xp/tracker`                         | Stored event/skill XP projection, exact integer values; public reads never fetch WOM.                   |

Public projections omit private actor/proof/settings data. See
[cache/polling contracts](public-performance.md), [WOM public display](wom-competitions.md)
and [availability](runtime-operations.md).

## Sessions, private data and writes

- `POST /api/v1/auth/login` requires exact configured Origin and username/password;
  successful login replaces the presented session and sets an eight-hour HttpOnly,
  SameSite=Lax cookie (Secure in production). Password work and attempts are bounded.
- `GET /api/v1/auth/session` returns authenticated identity/role/first-change state
  and session-derived CSRF token, or `{authenticated:false}`.
- `POST /api/v1/auth/logout` requires session, Origin and `X-CSRF-Token`, deletes
  that session and clears the cookie with 204. Account updates confirm the current
  password. Disabled accounts, expired sessions and credential-version mismatch
  cannot authorize staff actions. Required first password change restricts tools.
- Private routes/responses use `Cache-Control: no-store`. Clients use same-origin
  credentials. One client session owner cancels outstanding private reads and
  clears caches/drafts on logout, expiry or access loss; stale completions cannot
  restore them. Destination data is prepared before committing staff navigation.
- Each write repeats authorization, strict schema validation, Origin and CSRF
  checks. Bot/RuneLite credentials authorize only their intake scope, not staff UI.
  Moderators can use RuneLite review settings and all supported WOM imports,
  including finished SKILL results. Shared-key replacement, duplicate-filter
  changes, site settings and account management remain administrator-only.

See [staff auth and configuration](backend-phase-one.md),
[prepared navigation](admin-navigation.md), [settings/accounts](site-customization.md)
and [workload budgets](workload-budgets.md). Retired OAuth paths return 404;
[migration 021](runtime-packaging-and-auth-retirement.md) removes only unused state.

## Review and bounded histories

[Review queues/detail](review-pagination.md) return revision-bound keyset pages
(default/max 20) and opaque current/next cursors. Detail audit pages are complete
through traversal. Stale/incompatible cursors return 409: discard the cursor stack
and explicitly reload, preserving independent drafts until discard/access loss.
[XP history](xp-history-pagination.md) uses its own transactional history revision.
No silent 100/2,000-row history truncation remains.

Claim corrections and approve/reject/revoke carry `expectedVersion`; approval
requires a resolved item and unique credit per mode. Note-only
`PATCH /api/v1/admin/submissions/:id/note` accepts `expectedVersion` and
`note` (max 1,000 characters, empty clears). It saves/audits the note independently
of item resolution, claim changes or a decision. The UI explicitly saves or
discards a note draft; navigation/decision does not silently save it. Stale saves
conflict; writes cannot overwrite another reviewer's version.

Manual submission creation requires a UUID `Idempotency-Key`. Exact retries
return the durable original receipt; changed payload/key reuse conflicts.
Review, catalog, competition and import writes keep their own documented revision,
preview and replay rules; there is no blanket retry for uncertain COMMIT outcomes.

RuneLite multipart intake requires the full `chatMessage` for new submissions
and accepts an optional PNG. Chat proof is visible only in staff review and
audit data; public credits and receipts omit it. Same-key changes to the message
or screenshot presence conflict. Historical screenshot-only requests can replay
their original payload without a message. See [the intake contract](runelite-submissions.md).

## Imports, catalog and intake

| Feature            | Current authoritative contract                                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WOM previews/apply | [Competition imports](wom-competitions.md): server metric metadata determines SKILL/ACTIVITY. Future/running SKILL has no pages/schedule/results; nonempty pageIds is rejected. ACTIVITY page windows and finished results follow lifecycle/role rules. |
| XP                 | [Import reconciliation](xp-import.md): exact per-skill contributions, immutable receipts and history; unchanged refresh adds no duplicate XP.                                                                                                           |
| Catalog            | [Manual items/icons/order](admin-catalog-backend.md), [page management](site-customization.md), [source reconciliation](import-reconciliation.md); complete revision-checked permutations and retained canonical identity.                              |
| RuneLite           | [Intake](runelite-submissions.md): scoped clan key, private screenshots, immutable normalized-world receipts and configured auto-review policies.                                                                                                       |
| Discord            | [Intake](bot-intake.md): bearer service credential, configured guild and interaction ID; durable 201 new / 200 exact retry, changed retry 409.                                                                                                          |

The sole slash command is
`/cc-clog submit item:<item/name> proof:<imgur-or-gyazo-https-link> [submitter-name:<collector>] [hardcore:<boolean>]`.
The API assigns the UTC receipt date; callers cannot supply collectedOn.
Autocomplete suggestions never grant credit. Registration is an explicit owner
operation, not an automatic restart action. A receipt is acknowledged only after
API persistence; acknowledgement failure preserves known receipt identity.

## Maintenance and failures

Owner-only [preview expiry](deployment.md#expired-xp-and-competition-preview-maintenance)
and [abandoned assets](asset-maintenance.md) are explicit bounded, dry-run-first
operations. [Lifecycle archival](lifecycle-archive.md) applies only to ended
records and preserves receipts/audit/results; it does not revoke XP or delete
staff-created windows. These are not public cleanup endpoints or hosted schedules.

Invalid fields return 400/422, missing authentication 401, forbidden scope 403,
missing resources 404, version/cursor/replay conflicts 409 and overload 429 (with
Retry-After where documented). Internal failures are sanitized. Never infer a
failed commit solely from a missing HTTP response: replay/reconcile using the
original durable identity. See [runtime uncertainty](runtime-operations.md).
