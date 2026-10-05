# Vardorvis Clan Collection Log

Monorepo for a public OSRS collection log, an admin submission queue, a Discord submission bot, and a separate clan XP gained page. The public log starts entirely uncollected. Approved evidence credits the canonical item everywhere it appears.

## Current state

This commit delivers the **project foundation and development plan**, not the finished collection log.

Implemented: npm workspaces, React/Vite starter, Fastify health/status endpoints, shared catalog/collection rules, initial PostgreSQL schema and migration runner, Discord command definition, three Docker image targets, Compose, PR validation, and validated-main image publishing. The bot image runs a scaffold health service; it does not log into Discord, register commands, or accept submissions.

Planned: complete item/page catalog and assets, pixel-matched OSRS UI, collection tooltips, Discord submission persistence, Discord admin OAuth, review UI/API, hardcore credit styling, admin-imported Wise Old Man competition XP, admin item creation with durable icons and per-page ordering, and production operational testing. No sample item is presented as a complete catalog; no submission is silently accepted.

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

Open `http://localhost:8088`. The starter page describes the current foundation stage. The local override builds images rather than pulling GHCR. The placeholder `IMAGE_TAG` in `.env` is sufficient for local builds; a real published SHA tag is required for production.

For host-run development, see [environment setup](docs/environment.md). The PostgreSQL integration test requires `TEST_DATABASE_URL`; it is mandatory in GitHub CI and explicitly skipped when absent locally.

## Documentation

- [Requirements and product behavior](docs/requirements.md)
- [Architecture and data model](docs/architecture.md)
- [API and Discord contracts](docs/contracts.md)
- [Development roadmap and issue index](docs/plan.md)
- [Planned hardcore, XP and admin catalog features](docs/planned-features.md)
- [Environment setup](docs/environment.md)
- [CI/CD, self-hosting, backups and rollback](docs/deployment.md)
- [Testing and completion gates](docs/testing.md)
- [Architecture decisions](docs/decisions/001-foundation.md)
- [Contribution workflow](CONTRIBUTING.md)

Development work is tracked in [GitHub Issues](https://github.com/KihiraLove/Vardorvis-clan-clog/issues). All documentation distinguishes shipped foundation behavior from future feature contracts.
