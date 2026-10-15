# Vardorvis Clan Collection Log

A public OSRS collection log with independent ordinary/hardcore credits, staff
review and catalog tools, Discord/RuneLite intake and Wise Old Man competition
imports. PostgreSQL stores the authoritative ledger; approved evidence credits
one canonical item everywhere it appears in the selected mode.

The [current architecture, operations and test inventory](docs/current-state.md)
is the maintained starting point. Features are implemented in draft remediation
[PR #105](https://github.com/KihiraLove/Vardorvis-clan-clog/pull/105) and awaiting
merge. Remaining launch acceptance is listed there explicitly.

## Run all checks locally

Install Node 24 and start Linux Docker with Compose, then run:

```bash
node scripts/check-local.mjs
```

This builds disposable Linux test environments and runs all automated repository
checks, real PostgreSQL tests, Chromium, production-image inspection/smoke and
isolated backup/recovery. Host npm dependencies, production secrets and GitHub
credentials are unnecessary. Reports are under `.data/local-checks/<run-id>/`.
See [local testing](docs/local-testing.md) for focused checks and cleanup.

Pushes/PRs use no hosted CI. GitHub packages are published only after acceptance
on a published Release. Deployment remains explicit; see
[release deployment](docs/deployment.md).

## Start a local application

Copy `.env.example` to `.env`. Independently generate `POSTGRES_PASSWORD` and
`APP_DB_PASSWORD` (32 random bytes as hex each); mirror the owner password in
host `DATABASE_URL` only if using host tools. To enable staff tools, set
`AUTH_ENABLED=true`, the loopback `PUBLIC_ORIGIN`, and independently generated
`SESSION_SECRET` and `ADMIN_BOOTSTRAP_PASSWORD`. Sign in as `admin`, change its
password, then remove the bootstrap value. Existing accounts survive restart.

```bash
docker compose -f compose.yaml -f compose.dev.yaml up -d --build --wait
```

Open the configured loopback origin (default `http://127.0.0.1:8088`). The local
override builds the unified app image; PostgreSQL remains a separate container.
Bootstrap applies migrations, imports the pinned full catalog and reconciles
restricted runtime permissions. Bot gateway startup is optional and command
registration is separate. See [environment setup](docs/environment.md) before
enabling credentials; production staff access requires HTTPS.

## Workspace and development

| Path                | Responsibility                                                           |
| ------------------- | ------------------------------------------------------------------------ |
| `apps/web`          | React/Vite public log and staff UI                                       |
| `apps/api`          | Fastify reads, staff authentication, intake, review, catalog and imports |
| `apps/bot`          | Optional Discord adapter calling the API                                 |
| `packages/domain`   | Shared identity, validation and exact XP rules                           |
| `packages/database` | Immutable SQL, owner/bootstrap/maintenance CLIs and integration tests    |
| `infra`             | Unified container supervisor/proxy and versioned deployment/recovery     |

For host development, install Node 24 dependencies with `npm ci`, build shared
workspaces and use `npm run dev:web` / `npm run dev:api` with the documented
local database configuration. `npm run build` includes tests; Docker production
uses the separate `npm run build:runtime` packaging path.

`http://127.0.0.1:5173/?preview=1` is an explicitly labelled, resettable sample
ledger; staff preview routes share it. It grants no server permissions or
persistent clan writes. Its [explicit loading policy](docs/frontend-loading.md) keeps fixtures out of the
initial public bundle. Remaining browser/security/release acceptance is tracked
in #102–#104.

## Documentation

- [Current architecture, behavior, runbooks, automated inventory and launch limits](docs/current-state.md)
- [Requirements](docs/requirements.md) and [HTTP/Discord contracts](docs/contracts.md)
- [Deployment](docs/deployment.md), [runtime operations](docs/runtime-operations.md) and [release recovery](docs/release-recovery.md)
- [Schema retirement and runtime packaging](docs/runtime-packaging-and-auth-retirement.md)
- [Local testing and release-only CI](docs/local-testing.md)
- [Contribution workflow](CONTRIBUTING.md)

Dated reviews and ADRs preserve historical reasoning; their feature status is
superseded by the current inventory and linked implementation guides.
