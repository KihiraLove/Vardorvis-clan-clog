# Vardorvis Clan Collection Log

Monorepo for a public OSRS collection log, an admin submission queue, a Discord submission bot, and an inline clan XP event tracker. The public log starts entirely uncollected. Approved evidence credits the canonical item everywhere it appears in the selected world mode.

## Current state

The [first backend slice](docs/backend-phase-one.md) now serves PostgreSQL-backed catalog/collections, Discord admin login and persistent versioned hardcore settings. Enable auth only after configuring the Discord app, HTTPS origin, allowlist and session secret. Submission review, WOM and catalog import remain pending.

This branch adds the **collection-log, clan XP and admin frontends** to the project foundation. The full catalog, backend feature routes and release approval remain pending.

Implemented: a collection-log frontend with five tabs, page/item navigation, approved-credit and independent hardcore mode, a release switch, silhouette outlines and collected-item menus; an inline RuneScape-style event XP tracker with a scrollable sidebar, million labels and exact tooltips and an admin preview/apply/history interface; an admin queue with exact matching, corrections, approval/rejection/revocation and audit history; an Add item form and drag/keyboard/touch page ordering; validated HTTP adapters, explicit shared preview ledgers and frontend browser tests; npm workspaces, Fastify health/status endpoints, shared catalog/collection rules, PostgreSQL schema with per-mode unique credits, default-off hardcore visibility and migration runner, Discord command definition, three Docker image targets, Compose, PR validation, and validated-main image publishing. The bot image runs a scaffold health service; it does not log into Discord, register commands, or accept submissions.

Planned: complete item/page catalog and assets, final reference-approved pixel matching, Discord submission persistence, transactional review API, end-to-end hardcore claim persistence/review, Wise Old Man import persistence, durable admin-created items/icons and per-page ordering, and production operational testing. No sample item is presented as a complete catalog; no submission is silently accepted.

## Workspace

| Path                | Responsibility                                                |
| ------------------- | ------------------------------------------------------------- |
| `apps/web`          | Public collection log and admin UI; React + Vite              |
| `apps/api`          | Public read API, future auth/review/submission API; Fastify   |
| `apps/bot`          | Discord gateway adapter and `/cc-clog submit` contract        |
| `packages/domain`   | Canonical items, collection projection, proof/date validation |
| `packages/database` | PostgreSQL schema, checksummed migrations, integration tests  |
| `infra`             | Web proxy and self-host deployment helper                     |
| `.github/workflows` | PR checks, private GHCR publishing, opt-in home deployment    |

## Start locally

Install Node 24 LTS and Docker Engine with Compose v2.

```bash
cp .env.example .env
# Edit .env: generate POSTGRES_PASSWORD, mirror it in host DATABASE_URL.
npm ci
npm run build
npm run validate
docker compose -f compose.yaml -f compose.dev.yaml up -d --build --wait
```

Open `http://localhost:8088`. The default page attempts the planned public catalog/collections API. The API serves stored catalog/collections; an empty database shows an unavailable catalog with an explicit frontend-preview option until the catalog importer is implemented. The local override builds images rather than pulling GHCR. The placeholder `IMAGE_TAG` in `.env` is sufficient for local builds; a real published SHA tag is required for production.

For host-run development, see [environment setup](docs/environment.md). The PostgreSQL integration test requires `TEST_DATABASE_URL`; it is mandatory in GitHub CI and explicitly skipped when absent locally.

## Review the frontend without a database

```bash
npm ci
npm run build -w @clog/domain
npm run dev:web
```

Open `http://127.0.0.1:5173/?preview=1`. The labelled sample catalog starts all uncollected; the review selector can show ordinary or mixed hardcore example credits without changing clan data. Use the [frontend review guide](docs/frontend-review.md) for screenshots, browser checks and the remaining work in UI-01 #3 / UI-02 #9. These issues stay open for manual review.

The zero-initialized XP event tracker is below the log (legacy `/xp?preview=1` shows the same page). Expand XP preview controls to show samples, then hover/focus/tap for exact values. Open `/admin/xp?preview=1` directly to review imports. See the [XP review guide](docs/xp-frontend-review.md). XP-02 #28 is also assigned to KihiraLove and remains open. Live XP imports still need #27; Discord sessions are implemented by #4; preview never changes clan data.

Review `http://127.0.0.1:5173/admin?preview=1` and `/admin/catalog?preview=1` for submission review, item creation and page ordering. The brand and admin links share the in-memory preview ledger, so approvals and new items appear in the public preview. Reload resets it. The [admin review guide](docs/admin-frontend-review.md) covers the steps and backend boundaries. ADMIN-01 #8 and ADMIN-02 #31 are assigned to KihiraLove and remain open for manual review in the same draft PR #33.

## Documentation

- [Backend routes, authentication, storage and setup](docs/backend-phase-one.md)
- [Mockup revision and implementation status](docs/mockup-revision.md)
- [Project code walkthrough, data model, architecture and CI guide](docs/project-guide.md)
- [Requirements and product behavior](docs/requirements.md)
- [Architecture and data model](docs/architecture.md)
- [API and Discord contracts](docs/contracts.md)
- [Development roadmap and issue index](docs/plan.md)
- [Planned hardcore, XP and admin catalog features](docs/planned-features.md)
- [Environment setup](docs/environment.md)
- [CI/CD, self-hosting, backups and rollback](docs/deployment.md)
- [Testing and completion gates](docs/testing.md)
- [Admin frontend review](docs/admin-frontend-review.md)
- [Architecture decisions](docs/decisions/001-foundation.md)
- [Contribution workflow](CONTRIBUTING.md)

Development work is tracked in [GitHub Issues](https://github.com/KihiraLove/Vardorvis-clan-clog/issues). All documentation distinguishes shipped foundation behavior from future feature contracts.
