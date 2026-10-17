# Clan Collection Log

A self-hosted Old School RuneScape collection log for any clan. Track ordinary
and hardcore collections, review drop evidence, manage your catalog, accept
Discord and RuneLite submissions, and import Wise Old Man competitions.

Version: **1.0.0-SNAPSHOT**. This is the first-release baseline. Existing
development databases must be recreated; there is no pre-release upgrade path.

## Get started

Install Docker with Compose v2, download or clone this repository, and open a
terminal in its folder. Copy the example configuration:

```bash
cp .env.example .env
```

Generate four different secrets with `openssl rand -hex 32` and put them in
`.env`: `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `SESSION_SECRET` and
`ADMIN_BOOTSTRAP_PASSWORD`. Set `AUTH_ENABLED=true`. The default
`PUBLIC_ORIGIN=http://127.0.0.1:8088` is suitable for this local setup.
Keep this file private; never commit it.

```bash
docker compose -f compose.yaml -f compose.dev.yaml up -d --build --wait
```

Open http://127.0.0.1:8088/admin. Sign in as `admin` with the bootstrap password,
choose a new password, then remove `ADMIN_BOOTSTRAP_PASSWORD` from `.env` and
recreate the app with the same Compose command. Set your clan name, logo and
submission rules in Site settings and RuneLite submissions.

The local build is named `clan-clog:dev`. PostgreSQL and uploaded images live
in Docker volumes and survive container restarts. Startup creates the database,
imports the bundled catalog, and gives the running app restricted DB access.

## Guides

- [Configuration](docs/environment.md) and [hosting with HTTPS](docs/deployment.md)
- [Staff guide](docs/staff-guide.md): reviews, catalog, scheduling and settings
- [RuneLite submissions](docs/runelite-submissions.md) and [Discord setup](docs/bot-operations.md)
- [Competitions](docs/wom-competitions.md) and [catalog sources](docs/catalog-import.md)
- [Backups and recovery](docs/release-recovery.md) and [maintenance](docs/maintenance.md)
- [Architecture](docs/architecture.md), [API contracts](docs/contracts.md) and [security](docs/security.md)
- [Development and tests](docs/local-testing.md), [contributing](CONTRIBUTING.md) and [asset attribution](docs/assets.md)

## Run the complete checks

With Node 24 and Linux Docker available:

```bash
node scripts/check-local.mjs
```

This uses disposable containers and test data, without reading your runtime
`.env`. Results are saved in `.data/local-checks/<run-id>/`. Focused checks are
described in the development guide. Published GitHub Releases run acceptance
before publishing the `clan-clog` image; normal PR pushes do not run hosted CI.

Project code is [MIT licensed](LICENSE). Bundled game and third-party assets
retain their own ownership and licenses; see the asset attribution guide.
