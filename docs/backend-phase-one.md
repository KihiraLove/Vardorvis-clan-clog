# Backend routes, authentication and storage

This is the current backend/authentication guide. The maintained
[architecture and acceptance inventory](current-state.md) links all feature
contracts; the filename reflects the original implementation slice.

## Implemented routes

Public catalog, independent mode credits, status/health, stored XP/activity
projections, staff accounts/settings, review, manual catalog/pages, Discord and
RuneLite intake, WOM previews/imports and bounded private histories are implemented.
See [HTTP contracts](contracts.md) for the route index and feature-guide links.
Public responses exclude proof, private actors and credentials; private API
responses are no-store and errors do not expose database/provider payloads.

Catalog/collection ETags hash complete deterministic public projections. Revision
triggers invalidate immutable process caches transactionally across owner and API
writes. Reads observe one consistent snapshot; warm conditional reads do not
rebuild the full projection. See [public performance](public-performance.md) for
bounds, lookup behavior and measurements. Oversize/inconsistent data fails rather
than silently returning an incomplete catalog.

## Authentication and configuration

Staff use individual PostgreSQL-backed accounts. Configure:

```dotenv
AUTH_ENABLED=true
SESSION_SECRET=REPLACE_WITH_INDEPENDENT_64_RANDOM_HEX_CHARACTERS
PUBLIC_ORIGIN=https://clog.example.com
```

A fresh authenticated database also needs an independently generated
`ADMIN_BOOTSTRAP_PASSWORD` (64–256 hex characters). Sign in as `admin`, change
the password, then remove that bootstrap value. Existing accounts survive renamed
administrators/restarts; another bootstrap value cannot reset them. Administrators
create moderators; all new accounts must change their temporary password before
staff tools unlock. See [environment setup](environment.md#required-secrets-and-configuration).

Passwords use independent salts and one-way scrypt verifiers, with bounded global
native work and shared DB login attempt limits. Successful login replaces the
presented session and sets an eight-hour HttpOnly, SameSite=Lax cookie. Production
requires HTTPS, Secure and the `__Host-` prefix. Only development loopback permits
HTTP. Exact Origin and session-derived `X-CSRF-Token` protect browser writes.
Account disabled/credential-version/expiry checks apply on every staff request.
Logout revokes the session; credential edits revoke other sessions. Rotating the
session secret invalidates cookies. The client clears private state and cancels
in-flight work on access loss. See [prepared navigation](admin-navigation.md).

Discord OAuth is retired; the gateway uses separate credentials and cannot grant
staff access. Migration 021 removes only unused OAuth state. Password sessions,
CSRF/login/logout and account history survive. See
[schema retirement and rollback compatibility](runtime-packaging-and-auth-retirement.md).

## Code and storage

| File                                    | Responsibility                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| `apps/api/src/config.ts`                | Environment, auth and verified proxy trust.                                    |
| `apps/api/src/auth.ts`                  | Account/login/session/CSRF and settings authorization.                         |
| `apps/api/src/app.ts`                   | Fastify composition, safe errors/logging and health/status.                    |
| `apps/api/src/server.ts`                | Bounded pool/query configuration and draining shutdown.                        |
| `apps/api/src/route-services.ts`        | Narrow structural route dependencies.                                          |
| `apps/api/src/transaction.ts`           | Shared transaction plumbing preserving original errors and commit uncertainty. |
| `packages/database/src/runtime-role.ts` | Complete owner-reconciled restricted runtime privilege policy.                 |

Domain stores retain explicit locking order, versions, audits and receipt replay;
see [store and route contracts](store-and-route-contracts.md). Long-running API
credentials cannot perform DDL or mutate append-only receipts/audits. Owner
credentials are used only for bootstrap/maintenance/backup operations.

## Verification and remaining work

The full [local runner](local-testing.md) provisions disposable PostgreSQL 17 and
runs route/store/concurrency/grant/upgrade tests, Chromium and production-image
proxy/API smoke plus complete isolated recovery. Focused validation without
`TEST_DATABASE_URL` can skip integration tests and is not full acceptance.
Actual production TLS, test-guild Discord, broader browser/real-stack journeys
and prior published release recovery remain [launch gates](current-state.md#remaining-launch-acceptance).
