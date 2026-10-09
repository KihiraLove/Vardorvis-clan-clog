# ADR 002: Discord commands, collection dates and collector display

Status: **command and date confirmed; proxy/TLS and visual sign-off pending** (DEC-01 #14), 9 October 2026.

This record distinguishes owner-approved requirements, shipped contracts, safe
interim behavior, and recommendations. **Recommendations are not authorizations
to register a Discord command, deploy a site, or change public behavior.**
The [7 October mockup](../mockup-revision.md) supersedes conflicting 5 October
assumptions in [ADR 001](001-foundation.md).

## Confirmed policy and current implementation

| Topic                    | Confirmed or implemented behavior                                                                                                                                                                                                                                                                       | Status                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Public collector display | One **active approved credit per canonical item per world mode**; display that mode's collector name and date once. The same item can be collected independently in ordinary and hardcore modes. Historical approvals, rejections, corrections, and revocations remain in private review/audit history. | Owner-approved 7 October; enforced by migration 002 and review API |
| Collector identity       | An optional `submitter-name` overrides the actor's current guild display name, falling back to username. The resolved, trimmed name is stored as a snapshot; it is not tied to future Discord renames. Admin can correct it with audit.                                                                 | Implemented                                                        |
| Hardcore display         | Hardcore mode is a separate public view with its own counters and details. The skull selects it only if the admin release flag is enabled; there is no scheduled unlock date. Do not combine ordinary and hardcore collector lines in a single public menu.                                             | Owner-approved 7 October; implemented                              |
| Primary command          | `/cc-clog submit item:<item> proof:<https-link> [submitter-name:<name>] [hardcore:<boolean>]`. The bot limits commands to the configured guild, validates proof, saves a pending submission through the bot-only API, and replies ephemerally after a durable receipt.                                  | Implemented                                                        |
| Submission date | Server-issued UTC receipt date; never supplied by the submitting user or bot. The intake API records `submittedAt` and its UTC calendar date as `collectedOn` with source `submission_default`. A versioned, audited admin correction remains an exceptional separate review action. | Owner-confirmed 9 October; enforced by intake API |
| Display date             | Public collected dates are formatted `DD/MM/YY` (for example, `16/10/26`). Collection dates are calendar values and never parsed as locale-dependent strings. Reject future dates on review.                                                                                                            | Implemented                                                        |
| Admin access             | Direct `/admin` and `/admin/xp` URLs, no public Admin button. Site administration uses a server-side shared password, session cookie, exact `PUBLIC_ORIGIN` and CSRF; Discord OAuth is **not** used for admin login.                                                                                    | Owner-approved UI; implemented                                     |
| Homepage                 | Supplied animated Mexicat GIF, 2× collection log, then XP tracker below the log.                                                                                                                                                                                                                        | Owner-approved layout; visual acceptance still open                |

### Confirmed decisions — 9 October 2026

**Exactly one Discord command:** The earlier reference to a second command
was residual ideation. `/cc-clog submit` is the only intended command.
Do not implement or register `/cc-clog lookup` or another subcommand.

**Date is the submission's receipt date:** The API sets both `submittedAt`
and the UTC calendar `collectedOn` at receipt. The bot offers no
`collected-on` input, and the authenticated bot intake API rejects
`collectedOn` even if a caller submits it directly. Exact retries return
the original persisted receipt/date, not a new timestamp. Existing manual
review date corrections remain a separate, authenticated, versioned and
audited exception; no user may backdate a submitted claim.

### Remaining deployment and visual acceptance

**Proxy/TLS and deployment:** The supplied direct-admin example is
`https://daybloom.net/admin`, but this does not confirm DNS, an active
deployment, Traefik's network/router/entrypoint/certificate resolver,
or verified TLS. A production instance must set
`PUBLIC_ORIGIN=https://daybloom.net` **only when** that is the actual public
site origin (origin has no `/admin` path); require an HTTPS certificate,
forwarded-protocol handling through a deliberately trusted proxy, and
secure session cookies. Continue exposing only web to the proxy; do not
publish database or admin API ports directly. Avoid a hardcoded proxy
network/certificate-resolver name without owner confirmation.

**Final visual acceptance:** Owner review is still required for the supplied
GIF, fixed 2× frame, responsive/clamped menus, skull/release behavior,
collector text, 320px touch use, and XP section placement. Browser/CI tests
are useful evidence but are not owner sign-off.

## Acceptance checklist for DEC-01

- [x] Document the already confirmed one-credit-per-mode and collector display policy.
- [x] Reconcile documentation with the current password-login and command contracts.
- [x] Owner confirmed `/cc-clog submit` is the only Discord command.
- [x] Owner confirmed server-issued UTC receipt date with no user-supplied date.
- [x] Preserve audited admin corrections as a separate review operation.
- [ ] Owner confirms production origin, proxy/TLS specifics and manual visual acceptance.

Keep issue #14 open until deployment and visual acceptance are reviewed.
Do not infer approval from passing CI or a draft PR.
