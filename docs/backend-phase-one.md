# Backend phase 1: public reads, Discord login and release settings

> **8 October 2026 CAT-01 update:** [Complete catalog import](catalog-import.md) now supplies 1,717 items, 124 ordered pages and verified local icons. Compose initializes the catalog after migrations; earlier descriptions of catalog import as pending are superseded.

Implemented on `codex/backend-auth-and-public-api` for issues [#2](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/2), [#4](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/4) and the settings/storage portion of [#26](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/26). All three are assigned to KihiraLove. This document supersedes earlier statements that these routes are only frontend contracts.

## Routes now implemented

| Route                               | Behavior                                                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/catalog`               | Active canonical items and ordered page memberships from one repeatable database snapshot. Includes manual identities without game IDs.                   |
| `GET /api/v1/collections`           | Approved normal/HC credits only, with item, collector, date and mode. No evidence, actors or audit fields.                                                |
| `GET /api/v1/settings`              | Minimal public hardcore visibility and revision. No-store; unavailable storage returns 503.                                                               |
| `GET /api/v1/auth/discord`          | Starts a state-bound Discord authorization-code flow with only the identify scope.                                                                        |
| `GET /api/v1/auth/discord/callback` | Consumes matching browser/server state once, verifies Discord identity and allowlist, rotates the session and returns to the fixed `/admin` URL.          |
| `GET /api/v1/auth/session`          | Returns display name and CSRF token for an allowed session, or authenticated false. A removed allowlisted identity gets 403.                              |
| `POST /api/v1/auth/logout`          | Requires same-origin/CSRF, deletes the server session and expires its cookie.                                                                             |
| `GET /api/v1/admin/settings`        | Requires an allowlisted session.                                                                                                                          |
| `PUT /api/v1/admin/settings`        | Strict boolean and expected revision; requires session, exact Origin and CSRF. Atomically saves the new version and actor audit; stale writes return 409. |

Catalog and collection revisions are SHA-256 hashes of their complete, deterministically ordered public projections. Each has its own ETag. Approval, correction, revocation, membership/order changes or manual additions change the relevant response hash automatically; no process-local cache invalidation is needed. Weak/list/wildcard conditional requests are supported. Hashes are cache validators, not credentials.

Public reads are bounded at 10,000 items, 2,000 pages, 50,000 memberships and 20,000 credits; oversize/inconsistent data fails rather than truncating a supposedly complete snapshot. Catalog data with missing/unsafe icon paths or unsupported categories returns 503. An empty database has no invented catalog and reports catalogReady false. The complete source importer and production icon storage remain #1/#30.

## Authentication and configuration

Keep `AUTH_ENABLED=false` until configuring Discord. Public reads work independently. Disabled auth returns an anonymous session response and a clear unavailable sign-in response.

To enable:

1. Register a Discord application and the exact callback `https://daybloom.net/api/v1/auth/discord/callback` (or the equivalent path on your configured domain).
2. Set `AUTH_ENABLED=true`, `PUBLIC_ORIGIN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_OAUTH_REDIRECT_URI`, and comma-separated `ADMIN_DISCORD_USER_IDS`. IDs are Discord snowflakes, not display names.
3. Generate `SESSION_SECRET` from at least 32 random bytes encoded as hex. Keep it in the host environment or ignored `.env`, never in a browser build.
4. Configure `TRUSTED_PROXY_CIDRS` with only the actual reverse-proxy addresses/networks when using forwarded client addresses. Empty trusts no forwarding headers. Never use a catch-all to make rate limiting appear to work.
5. Apply migrations and restart the API. Open `/admin` directly to sign in and save the hardcore release flag.

Enabled auth refuses missing fields, weak secrets, invalid IDs, insecure public origins, mismatched redirects and invalid proxy entries at startup. Production requires HTTPS. Host development can use HTTP loopback with `NODE_ENV` other than production and a registered matching redirect; Compose runs in production mode and therefore requires HTTPS for enabled auth.

State expires after 10 minutes; sessions expire after 8 hours without sliding renewal. Cookies are HttpOnly, SameSite=Lax and Secure, with the `__Host-` prefix in HTTPS mode. Only local HTTP development uses unprefixed cookies. Session lookup hashes and CSRF tokens use separate HMAC domains; rotating `SESSION_SECRET` invalidates existing sessions. OAuth state uses a random browser cookie and matching single-use hash in PostgreSQL. Discord access/refresh tokens are never persisted or returned to the browser.

Every private request rechecks the configured allowlist. Session removal, expiry, secret rotation or allowlist removal denies subsequent access. Writes require both exact configured Origin and a session-bound CSRF token. No CORS bypass is enabled. OAuth start/callback traffic has a shared PostgreSQL limit of 20 requests per client IP per minute; without trusted forwarding, users behind one proxy share that limit. Provider requests use fixed Discord origins, reject redirects and time out after ten seconds.

API request logs omit query strings, bodies and credentials so OAuth codes/state cannot appear in normal request logs. Database/provider exception details are not sent to clients or logged. Reverse proxies must also avoid logging callback query strings (see Nginx configuration).

## Code and storage

| File                                              | Responsibility                                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/types.ts`                           | Store/identity/public payload contracts and safe API errors.                                                        |
| `apps/api/src/config.ts`                          | Auth environment and trusted-proxy validation.                                                                      |
| `apps/api/src/discord.ts`                         | Fixed-origin token exchange and identity parsing.                                                                   |
| `apps/api/src/auth.ts`                            | OAuth routes, cookie/state checks, session/allowlist/CSRF enforcement and settings routes.                          |
| `apps/api/src/store.ts`                           | Parameterized SQL, consistent public snapshots, atomic settings audit and durable session/state/rate-limit storage. |
| `apps/api/src/app.ts`                             | Fastify composition, bounded strict JSON, safe errors/logging, ETags and health/status endpoints.                   |
| `apps/api/src/server.ts`                          | Runtime environment, bounded pool/query timeouts and shutdown.                                                      |
| `packages/database/migrations/003_admin_auth.sql` | Additive OAuth state, session, settings audit and login rate-limit tables.                                          |

Migration 003 leaves existing catalog/credits and migrations 001/002 unchanged. New tables are independent of submission-specific audit history. Settings writes lock the singleton row, compare its version, update it and insert the audit row in one transaction. Database audit failure rolls back the setting. Concurrent saves of the same version produce one success and one conflict. The SQL constraints from migration 002 continue to enforce one approved item/mode credit.

Existing compatible images can be rolled back with the additional tables left in place; do not edit or reverse applied migrations. Backups now contain private session/actor metadata. Runtime database-role separation and append-only audit grants remain operational work in #11.

## Verification and remaining work

Route tests cover ETags, mode isolation, anonymous/non-admin denial, state mismatch/replay/expiry, session expiry/logout/removal from the allowlist, CSRF/origin, strict payloads, stale settings, rate limits and fixed Discord requests. Real PostgreSQL tests use a generated disposable schema and verify projected private-field exclusion, manual identities/order invalidation, unique credits, concurrent settings updates, audit rollback, persistence across store instances and single-use state. `TEST_DATABASE_URL` enables those tests and is supplied by CI. No live Discord app credentials are needed in CI.

The CI validation job runs these tests against PostgreSQL 17; Docker smoke checks exercise migrations, health and configured auth startup. Browser tests still use their isolated preview/mocked scenarios. A real Discord login/TLS test requires deployment-specific credentials and is an explicit release check, not something the mocked provider test proves.

Next backend slices are intake/review (#5/#7), the running Discord bot (#6), complete catalog import (#1), WOM event persistence (#27), and admin catalog/icon storage (#30). The current `/admin` settings panel can work against this API, while its submission/catalog panels still report their unavailable services. HC evidence review and full #26 acceptance remain open.

Protocol references: [Discord OAuth2](https://docs.discord.com/developers/topics/oauth2) and [Fastify trusted proxies](https://fastify.dev/docs/latest/Reference/Server/#trustproxy).
