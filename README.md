# Clan Collection Log

A self-hosted Old School RuneScape collection log for any clan. Track ordinary
and hardcore collections, review evidence, manage your catalog, accept Discord
and RuneLite submissions, and import Wise Old Man competitions.

Version: **1.0.0-SNAPSHOT**. Existing installations using `001_baseline.sql`
upgrade through forward-only migrations. Keep the persistent data volume and
take a backup before updating. Development databases predating that baseline
are unsupported.

## Get started

Install Docker with Compose v2. Add this service and volume to your existing
Compose file, replacing `v1.0.0` with an available published release:

```yaml
services:
  clan-clog:
    image: ghcr.io/kihiralove/clan-clog:v1.0.0
    restart: unless-stopped
    stop_grace_period: 90s
    environment:
      PUBLIC_ORIGIN: https://clog.example.com
    ports:
      - '127.0.0.1:8088:8080'
    volumes:
      - clan-clog-data:/data

volumes:
  clan-clog-data:
```

Point your HTTPS reverse proxy at `127.0.0.1:8088` (or `clan-clog:8080` for a
proxy on the same Docker network) and set your actual website origin. Then
start only this service:

```bash
docker compose up -d clan-clog
docker compose logs clan-clog
```

Near the beginning of the log, find **FIRST LOGIN**, username `admin` and its
temporary password. Visit `/admin`, sign in and choose a new password.
Interrupted setup keeps the same temporary password; once changed, startup
neither prints nor replaces it. No password-generation command or secret-filled
`.env` is required. Configure your clan, submission rules and optional Discord
bot in Administration.

One container runs the website, private PostgreSQL 17 and optional bot. One
`/data` volume keeps the database, uploads and generated credentials across
updates. Keep the volume and back it up before changing images.

## Build the current snapshot locally

Clone this repository and run from its directory:

```bash
cp .env.example .env
docker compose -f compose.yaml -f compose.dev.yaml up -d --build --wait clan-clog
docker compose -f compose.yaml -f compose.dev.yaml logs clan-clog
```

The example origin is http://127.0.0.1:8088 for local use. The build is named
`clan-clog:dev`; the same first-login flow applies.

## Guides

- [Configuration](docs/environment.md) and [hosting with HTTPS](docs/deployment.md)
- [Staff guide](docs/staff-guide.md): reviews, catalog, scheduling and settings
- [RuneLite submissions](docs/runelite-submissions.md) and [Discord setup](docs/bot-operations.md)
- [Competitions](docs/wom-competitions.md) and [catalog sources](docs/catalog-import.md)
- [Backups and recovery](docs/release-recovery.md) and [maintenance](docs/maintenance.md)
- [Architecture](docs/architecture.md), [API contracts](docs/contracts.md) and [security](docs/security.md)
- [Development and tests](docs/local-testing.md), [contributing](CONTRIBUTING.md) and [asset attribution](docs/assets.md)

## Run the complete checks

With Node 24 and Linux Docker running:

```bash
node scripts/check-local.mjs
```

The runner uses disposable data without reading your runtime `.env`. Reports
are saved in `.data/local-checks/<run-id>/`. Published GitHub Releases run
acceptance before publishing the image; ordinary PR pushes do not run hosted CI.

Project code is [MIT licensed](LICENSE). Game and third-party assets retain
their own ownership and licenses; see the asset attribution guide.
