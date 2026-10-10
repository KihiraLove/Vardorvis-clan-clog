# Release deployment and operations

> Release preparation (10 October 2026): the former three application images
> (`web`, `api`, `bot`) are replaced by ONE `app` image. This document
> describes the new Compose layout, not a deployed production instance.

## Service topology

- `app`: a single image/container runs Nginx on 8080, Fastify on internal
  127.0.0.1:3000, and optionally the Discord gateway (`BOT_ENABLED=true`).
  An exit of any active process stops the others and restarts the container.
  Only Nginx is reachable from Traefik; `/readyz` checks API/database readiness.
- `db`: PostgreSQL 17, privately networked with a persistent named volume.
- `migrate`: an **exiting**, one-shot bootstrap job using the same `app`
  image. It alone receives the database owner password; the running app uses
  restricted `clog_runtime` credentials. It creates the schema, imports the
  pinned catalog, corrects clue taxonomy, and provisions the runtime role.

Two long-lived containers plus a short-lived bootstrap job. Running Postgres
inside the app container would make recovery, permissions and process lifetime
unnecessarily fragile and is not supported.

## Image build and release

GitHub CI validates workspaces, browser tests, a fresh PostgreSQL instance and
Docker Compose smoke tests. A **successful push to main** publishes one
`linux/amd64` + `linux/arm64` image:

`ghcr.io/kihiralove/vardorvis-clan-clog-app:sha-<40-character-commit>`

Pull requests do **not** deploy or publish images. The home deployment workflow
uses successful main CI provenance and a manual dispatch. It calls
`/srv/vardorvis-clan-clog/deploy.sh` on a labelled self-hosted runner, backs up
existing DB and icon data, and only records a release tag after Compose health
checks pass. Image rollback cannot reverse an incompatible schema automatically.

Copy reviewed `compose.yaml`, `compose.traefik.yaml`, `.env.example`
and the `infra/` scripts into your server directory. Do not copy test secrets
to production. Create `.env` with `chmod 600` and set unique independently
generated 32-byte hex `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`,
`SESSION_SECRET`, a strong `ADMIN_PASSWORD`, and the published `IMAGE_TAG`.
Use `openssl rand -hex 32` for the three independent hex secrets.

```bash
cd /srv/vardorvis-clan-clog
docker compose config --quiet
docker compose pull
docker compose up -d --wait --wait-timeout 120
curl --fail http://127.0.0.1:8088/api/v1/status
curl --fail http://127.0.0.1:8088/readyz
```

Never publish the database, internal API or bot port. The default app binding
is `127.0.0.1:8088` for diagnostics only.

## Existing Traefik

The operator's Traefik uses Let's Encrypt and Docker networks `web` and
`socknet`. **Only** the `app` service joins external `web`; the `db`
and bootstrap job stay on Compose's private default network. No application
container joins `socknet`, which is the proxy's socket network.

```dotenv
COMPOSE_FILE=compose.yaml:compose.traefik.yaml
CLOG_HOST=your-real-public-hostname.example
TRAEFIK_HTTPS_ENTRYPOINT=websecure
TRAEFIK_CERT_RESOLVER=letsencrypt
ADMIN_PASSWORD=replace-with-a-strong-unique-password
SESSION_SECRET=replace-with-64-random-hex-characters
```

The override enables `AUTH_ENABLED=true` and configures
`PUBLIC_ORIGIN=https://<CLOG_HOST>` using the same hostname as the Host label.
Traefik labels select existing HTTPS entrypoint and certificate resolver; they
cannot themselves define Traefik's static resolver or issue DNS records.
Confirm live DNS, the actual certificate, `/admin` login, Origin/CSRF
enforcement, bot connectivity and health before announcing release.
`TRUSTED_PROXY_CIDRS` must only contain verified immediate proxy CIDRs.

## Fresh-install database baseline (breaking change)

All nine pre-release SQL migration files are now
[`001_baseline.sql`](../packages/database/migrations/001_baseline.sql).
The bootstrap still records its SHA-256 in `schema_migrations`, verifies it on
restart, imports source data and ensures correct runtime grants.

**There is no upgrade path from the old nine-migration test database.**
The following is destructive and is appropriate ONLY for the disposable test
Compose project you have agreed to reset. It also deletes uploaded test icons:

```bash
docker compose -f compose.yaml -f compose.dev.yaml down --volumes
docker compose -f compose.yaml -f compose.dev.yaml up -d --build --wait
docker compose -f compose.yaml -f compose.dev.yaml exec -T db \
  psql -U clog -d clog -Atc 'SELECT name FROM schema_migrations'
# Expected: 001_baseline.sql
```

Never run `down --volumes` on a production deployment. For later releases,
add new forward-only migration files rather than editing this applied baseline.

## Backups, Discord and release acceptance

`infra/backup.sh /safe/new/backup-directory` stops the `app` writer, captures
a PostgreSQL custom-format dump and all durable uploaded icons, writes
checksums and a `COMPLETE` marker, then restarts the app. Store an encrypted
copy off-host and rehearse an isolated restore before production approval.

Enable Discord in the combined app with `BOT_ENABLED=true`,
`DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID` and `BOT_API_TOKEN`.
Explicit command registration is still required and is never performed on
start. See [bot operations](bot-operations.md).

Before release verify: clean schema initialization and repeat bootstrap;
restricted database owner/runtime roles; nonempty catalog with correct
Treasure Trails rare pages; public collections/XP defaults; correct admin
password and wrong-password denial; session and CSRF writes; durable icon
upload after app recreation; coordinated backup/restore; and actual Discord
`/cc-clog submit` intake from the clan guild. CI covers many checks, but
not live TLS or a Discord gateway login. Treat release approval as pending
until host-specific checks have been completed.
