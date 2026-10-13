> **Release update:** The previous individual pre-release SQL migrations are incorporated in [001_baseline.sql](../packages/database/migrations/001_baseline.sql).

# Backend phase 1: public reads, admin password login and release settings

> **8 October 2026 CAT-02 update:** [Admin catalog backend](admin-catalog-backend.md) implements authenticated creation, durable PNG icons, revision-checked ordering and explicit alias reconciliation. Compose now includes an icon volume, and backups include both database and icons. Earlier descriptions of those features as pending are superseded.

> **8 October 2026 CAT-01 update:** [Complete catalog import](catalog-import.md) now supplies 1,717 items, 124 ordered pages and verified local icons. Compose initializes the catalog after migrations; earlier descriptions of catalog import as pending are superseded.

Implemented on `codex/backend-auth-and-public-api` for issues [#2](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/2), [#4](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/4) and the settings/storage portion of [#26](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/26). All three are assigned to KihiraLove. This document supersedes earlier statements that these routes are only frontend contracts.

## Routes now implemented

| Route                        | Behavior                                                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/catalog`        | Active canonical items and ordered page memberships from one repeatable database snapshot. Includes manual identities without game IDs.                   |
| `GET /api/v1/collections`    | Approved normal/HC credits only, with item, collector, date and mode. No evidence, actors or audit fields.                                                |
| `GET /api/v1/settings`       | Minimal public hardcore visibility and revision. No-store; unavailable storage returns 503.                                                               |
| `POST /api/v1/auth/login`    | Checks the `.env` password with origin and rate-limit guards; creates a private session.                                                                  |
| `GET /api/v1/auth/session`   | Returns display name and CSRF token for a valid password-authenticated session, or authenticated false.                                                   |
| `POST /api/v1/auth/logout`   | Requires same-origin/CSRF, deletes the server session and expires its cookie.                                                                             |
| `GET /api/v1/admin/settings` | Requires an authenticated admin session.                                                                                                                  |
| `PUT /api/v1/admin/settings` | Strict boolean and expected revision; requires session, exact Origin and CSRF. Atomically saves the new version and actor audit; stale writes return 409. |

Catalog and collection revisions are SHA-256 hashes of their complete, deterministically ordered public projections. Each has its own ETag. Approval, correction, revocation, membership/order changes or manual additions change the relevant response hash automatically; no process-local cache invalidation is needed. Weak/list/wildcard conditional requests are supported. Hashes are cache validators, not credentials.

Public reads are bounded at 10,000 items, 2,000 pages, 50,000 memberships and 20,000 credits; oversize/inconsistent data fails rather than truncating a supposedly complete snapshot. Catalog data with missing/unsafe icon paths or unsupported categories returns 503. An empty database has no invented catalog and reports catalogReady false. The complete source importer and production icon storage remain #1/#30.

## Authentication and configuration

Staff account credentials live in PostgreSQL. Discord OAuth is no longer a login mechanism; the independent Discord bot uses separate credentials for claim intake. Enable account login with:

```dotenv
AUTH_ENABLED=true
SESSION_SECRET=REPLACE_WITH_64_RANDOM_HEX_CHARACTERS
PUBLIC_ORIGIN=https://clog.example.com
```

Generate the session secret with `openssl rand -hex 32`. For a fresh authenticated installation, independently generate `ADMIN_BOOTSTRAP_PASSWORD` with the same command. Sign in as `admin` using that bootstrap value; first login requires a different 12–256 character password. Missing bootstrap credentials prevent startup when no administrator exists. Remove the bootstrap environment value after setup; existing accounts survive renaming/restarts without it. The administrator creates moderator accounts, which must also change their temporary password at first login. See [account setup](environment.md#required-secrets-and-configuration). HTTP is permitted only on `localhost` / `127.0.0.1` in `NODE_ENV=development`, including the `compose.dev.yaml` override. Production requires HTTPS. No public sign-up or OAuth credentials are needed.

The API stores independently salted scrypt verifiers in PostgreSQL, compares derived keys in constant time and applies the shared PostgreSQL per-IP login rate limiter. Successful login returns a random eight-hour, HttpOnly, SameSite=Lax session cookie. HTTPS uses Secure and the `__Host-` prefix. Browser writes require both an exact `Origin` and session-bound `X-CSRF-Token`. Logout revokes the session. Credential edits revoke other sessions; rotating `SESSION_SECRET` invalidates all existing cookies. No passwords or hashes are exposed to frontend assets or public API responses.

## Code and storage

| File                                              | Responsibility                                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/types.ts`                           | Store/identity/public payload contracts and safe API errors.                                                        |
| `apps/api/src/config.ts`                          | Auth environment and trusted-proxy validation.                                                                      |
| `apps/api/src/auth.ts`                            | Password login, cookie/session/CSRF enforcement and settings routes.                                                |
| `apps/api/src/store.ts`                           | Parameterized SQL, consistent public snapshots, atomic settings audit and durable session/state/rate-limit storage. |
| `apps/api/src/app.ts`                             | Fastify composition, bounded strict JSON, safe errors/logging, ETags and health/status endpoints.                   |
| `apps/api/src/server.ts`                          | Runtime environment, bounded pool/query timeouts and shutdown.                                                      |
| `packages/database/migrations/003_admin_auth.sql` | Existing session, settings audit and login rate-limit tables; unused legacy OAuth state remains inert.              |

Migration 003 leaves existing catalog/credits and migrations 001/002 unchanged. New tables are independent of submission-specific audit history. Settings writes lock the singleton row, compare its version, update it and insert the audit row in one transaction. Database audit failure rolls back the setting. Concurrent saves of the same version produce one success and one conflict. The SQL constraints from migration 002 continue to enforce one approved item/mode credit.

Existing compatible images can be rolled back with the additional tables left in place; do not edit or reverse applied migrations. Backups now contain private session/actor metadata. Runtime database-role separation and append-only audit grants remain operational work in #11.

## Verification and remaining work

Route tests cover ETags, mode isolation, anonymous denial, valid/invalid password logins, session expiry/logout, CSRF/origin, strict payloads, stale settings and rate limits. Real PostgreSQL tests use a generated disposable schema and verify projected private-field exclusion, manual identities/order invalidation, unique credits, concurrent settings updates, audit rollback, persistence across store instances and single-use state. `TEST_DATABASE_URL` enables those tests and is supplied by CI. No live Discord app credentials are needed in CI.

The CI validation job runs these tests against PostgreSQL 17; Docker smoke checks exercise migrations, health and configured auth startup. Browser tests still use their isolated preview/mocked scenarios. A production TLS and configured-password smoke test remains a deployment-specific release check.

Next backend slices are intake/review (#5/#7), the running Discord bot (#6), complete catalog import (#1), WOM event persistence (#27), and admin catalog/icon storage (#30). The current `/admin` settings panel can work against this API, while its submission/catalog panels still report their unavailable services. HC evidence review and full #26 acceptance remain open.

Protocol reference: [Fastify trusted proxies](https://fastify.dev/docs/latest/Reference/Server/#trustproxy).
