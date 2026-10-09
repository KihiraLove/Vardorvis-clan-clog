# ADR 002: Discord commands, collection dates and collector display

Status: **partially confirmed; owner decisions pending** (DEC-01 #14), 9 October 2026.

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
| Default date             | Slash submissions have **no `collected-on` option**. The API records `submittedAt` in UTC and sets `collectedOn` to the UTC submission calendar date, `dateSource: submission_default`. Admin edits change the stored date and provenance to `admin`. The fallback is not a verified drop day.          | Implemented interim behavior                                       |
| Display date             | Public collected dates are formatted `DD/MM/YY` (for example, `16/10/26`). Collection dates are calendar values and never parsed as locale-dependent strings. Reject future dates on review.                                                                                                            | Implemented                                                        |
| Admin access             | Direct `/admin` and `/admin/xp` URLs, no public Admin button. Site administration uses a server-side shared password, session cookie, exact `PUBLIC_ORIGIN` and CSRF; Discord OAuth is **not** used for admin login.                                                                                    | Owner-approved UI; implemented                                     |
| Homepage                 | Supplied animated Mexicat GIF, 2× collection log, then XP tracker below the log.                                                                                                                                                                                                                        | Owner-approved layout; visual acceptance still open                |

### Decisions not yet made by the owner

**Second Discord command:** The original request mentioned two commands but
specified only `/cc-clog submit`. No second command is implemented or
registered. **Proposed**, for consideration: `/cc-clog lookup item:<item>`
would give an ephemeral, read-only summary of that item's approved ordinary
and hardcore status. If chosen, scope it to the clan guild, show only public
approved information, honor the hardcore release flag, and use autocomplete.
It must not disclose proof links, pending claims, audit events, or admin
details. Alternatively the owner may choose a completely different command.
**Decision required before code or registration changes.**

**Optional collection date:** Current behavior is to use the UTC receipt
date and permit a later admin correction; this remains the compatibility
default. The owner must decide whether slash input should additionally accept
`[collected-on:YYYY-MM-DD]`. If approved, accept only a real, nonfuture ISO
calendar date, record `dateSource: collector`, validate again in the API,
and include it in retry/idempotency payload checks. Omitted input continues
to use the UTC submission date. This is a proposed contract, **not** a current
bot input.

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
- [x] Preserve UTC receipt-date fallback and admin-correction behavior.
- [ ] Owner specifies the second Discord command and authorizes registration scope.
- [ ] Owner explicitly chooses optional slash collection date or current fallback only.
- [ ] Owner confirms production origin, proxy/TLS specifics and manual visual acceptance.

Until those three outstanding decisions are confirmed, keep issue #14 open.
Do not infer approval from passing CI or a draft PR.
