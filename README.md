# Clan Collection Log

[![Support on Ko-fi](https://img.shields.io/badge/Ko--fi-Support-72A5F2?logo=kofi&logoColor=white)](https://ko-fi.com/kihiralove)
[![GHCR pulls](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fghcr-badge.elias.eu.org%2Fapi%2FKihiraLove%2Fclan-clog&query=%24.downloadCount&label=GHCR%20pulls&logo=docker)](https://github.com/users/KihiraLove/packages/container/package/clan-clog)
[![CI](https://img.shields.io/github/actions/workflow/status/KihiraLove/clan-clog/ci.yml?label=CI)](https://github.com/KihiraLove/clan-clog/actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/v/release/KihiraLove/clan-clog?include_prereleases&sort=date&label=version)](https://github.com/KihiraLove/clan-clog/releases)

A self-hosted Old School RuneScape collection log for any clan. Track ordinary
and hardcore collections, review evidence, manage your catalog, accept Discord
and RuneLite submissions, and import Wise Old Man competitions.

## Get started

Install Docker with Compose v2. Choose an image tag from the
[published releases](https://github.com/KihiraLove/clan-clog/releases), then add
this service and volume to your Compose file, replacing `YOUR_RELEASE_TAG`:

```yaml
services:
  clan-clog:
    image: ghcr.io/kihiralove/clan-clog:YOUR_RELEASE_TAG
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
Configure your clan, submission rules and optional Discord bot in Administration.
No separate password-generation command or `.env` file is required for this setup.

One container runs the website, private PostgreSQL 17 and optional bot. One
`/data` volume keeps the database, uploads and generated credentials across
updates. Keep the volume and [back it up](docs/release-recovery.md) before changing
images. See [hosting and updates](docs/deployment.md) for the full setup options.

## Install from source

To build locally instead of using a published image:

```bash
git clone https://github.com/KihiraLove/clan-clog.git
cd clan-clog
cp .env.example .env
docker compose -f compose.yaml -f compose.dev.yaml up -d --build --wait clan-clog
docker compose -f compose.yaml -f compose.dev.yaml logs clan-clog
```

The example origin is http://127.0.0.1:8088 for local use. The build is named
`clan-clog:dev`; the same first-login flow applies.

## Test your submissions API
We have a [browser tool](https://github.com/KihiraLove/cc-clog-submitter) to test your submissions API.

## Repository map

| Path                                    | Contents                                      |
| --------------------------------------- | --------------------------------------------- |
| [apps/web](apps/web/)                   | Website and administration panel              |
| [apps/api](apps/api/)                   | API, authentication and submission processing |
| [apps/bot](apps/bot/)                   | Optional Discord integration                  |
| [packages/domain](packages/domain/)     | Shared validation and collection rules        |
| [packages/database](packages/database/) | Database migrations, catalog and maintenance  |
| [catalog](catalog/)                     | Catalog sources and asset provenance          |
| [infra](infra/)                         | Container, hosting and recovery helpers       |
| [scripts](scripts/)                     | Development and validation tools              |
| [docs](docs/)                           | Configuration, usage and technical guides     |

## Guides

- [Configuration](docs/environment.md) and [hosting with HTTPS](docs/deployment.md)
- [Staff guide](docs/staff-guide.md): reviews, catalog, scheduling and settings
- [RuneLite submissions](docs/runelite-submissions.md) and [Discord setup](docs/bot-operations.md)
- [Competitions](docs/wom-competitions.md) and [catalog sources](docs/catalog-import.md)
- [Backups and recovery](docs/release-recovery.md) and [maintenance](docs/maintenance.md)
- [Architecture](docs/architecture.md), [API contracts](docs/contracts.md) and [security](docs/security.md)
- [Development and tests](docs/local-testing.md), [contributing](CONTRIBUTING.md) and [asset attribution](docs/assets.md)

Project code is [MIT licensed](LICENSE). Game and third-party assets retain
their own ownership and licenses; see the asset attribution guide.
