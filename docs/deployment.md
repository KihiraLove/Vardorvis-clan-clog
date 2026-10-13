# Release deployment and operations

Administrator-managed labels, a dedicated site-settings page, moderator disable/delete and page-scoped item management are described in [site customization](site-customization.md). Migrations `007_site_customization.sql` and `008_default_clan_name.sql` preserve histories and administrator-chosen names. Generated clan keys use 32 hexadecimal characters; custom keys accept any characters with a minimum length of 8 and persist across restarts. Only historical shorter keys rotate once, with an audit and preserved enforcement. Migration `009_runelite_world_types.sql` adds original world flags without changing existing credit modes. New RuneLite clients must send the required worldType field; see the [intake contract](runelite-submissions.md) for excluded modes, HC routing and arbitrary-key header encoding.

> Release preparation (10 October 2026): the former three application images
> (`web`, `api`, `bot`) are replaced by ONE `app` image. This document
> describes the new Compose layout, not a deployed production instance.

## Service topology

- `app`: a single image/container runs Nginx on 8080, Fastify on internal
  127.0.0.1:3000, and optionally the Discord gateway (`BOT_ENABLED=true`).
  An exit of any active process stops the others and restarts the container.
  Only Nginx is reachable from Traefik. Both `/readyz` and the container health
  check require the database and, when `BOT_ENABLED=true`, the bot readiness
  probe (Discord gateway plus authenticated intake). Disabled bots are not
  probed. Checks time out within 3.5 seconds and recover when dependencies recover.
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

SHA-only images are development builds. The hourly **Clean up development
images** workflow deletes versions older than 24 hours (measured from the later
of creation/update), including old `web`, `api` and `bot` images. GitHub scheduling
can delay deletion past that threshold. Only images tagged exactly `release` or
with a `release-` prefix are retained indefinitely. Their untagged architecture
and provenance manifests are retained too, as are dependencies of recent builds.
The home deployment workflow adds `release-<full SHA>` before deployment, keeping
the existing `sha-<full SHA>` pull reference usable for deployment and rollback.
Promote a development build within 24 hours or rebuild it before deployment.
Release tags must not be removed while that release is needed.

Cleanup runs immediately when its workflow/script changes on main. Manual runs
default to a dry run; turn off `dry_run` to apply deletion. The workflow needs
package admin access through the repository's `GITHUB_TOKEN`; packages must be
linked to this repository. It stops on manifest/API failures and preserves
dependencies shared with retained images. Publishing, promotion and cleanup
share one concurrency group. Do not retag packages externally during cleanup.

Pull requests do **not** deploy or publish images. The home deployment workflow
uses successful main CI provenance and a manual dispatch. It calls
`/srv/vardorvis-clan-clog/deploy.sh` on a labelled self-hosted runner, backs up
existing DB and icon data, and only records a release tag after Compose health
checks pass. Image rollback cannot reverse an incompatible schema automatically.

Copy reviewed `compose.yaml`, `compose.traefik.yaml`, `.env.example`
and the `infra/` scripts into your server directory. Do not copy test secrets
to production. Create `.env` with `chmod 600` and set unique independently
generated 32-byte hex `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`,
`SESSION_SECRET` and the published `IMAGE_TAG`.
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
SESSION_SECRET=replace-with-64-random-hex-characters
```

The override enables `AUTH_ENABLED=true` and configures
`PUBLIC_ORIGIN=https://<CLOG_HOST>` using the same hostname as the Host label.
For a fresh account-enabled install, set a unique `ADMIN_BOOTSTRAP_PASSWORD`
before starting, then sign in as `admin` with that secret and change the password.
Never use a known default password; subsequent credentials persist in PostgreSQL. See
[staff-account setup and upgrades](environment.md#required-secrets-and-configuration).
Traefik labels select existing HTTPS entrypoint and certificate resolver; they
cannot themselves define Traefik's static resolver or issue DNS records.
Confirm live DNS, the actual certificate, `/admin` login, Origin/CSRF
enforcement, bot connectivity and health before announcing release.
The bundled startup script trusts the fixed Nginx-to-API loopback hop.
Set `TRUSTED_PROXY_CIDRS` to the verified Traefik IP/CIDR on the `web`
network, for example `172.20.0.2/32` if that is its actual stable address.
Only include trusted proxy addresses, never all clients or `0.0.0.0/0`.
Nginx appends its immediate peer to the forwarded chain; Fastify walks it
from the trusted loopback hop and stops at the first untrusted address.
Traefik must likewise trust forwarded headers only from verified upstream
proxies. This gives each client a separate login limit and prevents a client
from bypassing it by supplying a forged forwarding prefix.
With no external proxies configured, direct Nginx clients remain distinct.
Host-run API development uses only its explicitly configured trusted proxies.

## Fresh-install database baseline (breaking change)

All nine pre-release SQL migration files are now
[`001_baseline.sql`](../packages/database/migrations/001_baseline.sql).
The bootstrap still records its SHA-256 in `schema_migrations`, verifies it on
restart, imports source data and ensures correct runtime grants.
The forward-only `002_manual_submission_requests.sql` migration adds durable
manual-creation receipts without changing the applied baseline. Existing
baseline databases upgrade through the normal bootstrap; no reset is needed.

**There is no upgrade path from the old nine-migration test database.**
The following reset is destructive and is appropriate ONLY for the disposable
test Compose project you have agreed to reset. It deletes the **database
volume**, while preserving the separate icon volume by default:

```bash
docker compose -f compose.yaml -f compose.dev.yaml down
docker volume rm vardorvis-clog_postgres-data
docker compose -f compose.yaml -f compose.dev.yaml up -d --build --wait
docker compose -f compose.yaml -f compose.dev.yaml exec -T db \
  psql -U clog -d clog -Atc 'SELECT name FROM schema_migrations'
# Expected: 001_baseline.sql and 002_manual_submission_requests.sql
```

The volume name above assumes the default `vardorvis-clog` Compose
project; verify the actual project/volume name before deletion.
The preserved icon files will no longer be referenced by the new empty
database; only remove that volume separately when its contents are
explicitly disposable. CI uses `down --volumes` exclusively on its
own isolated test data.

Never run `down --volumes` on a production deployment. For later releases,
add new forward-only migration files rather than editing this applied baseline.

## Backups, Discord and release acceptance

Migration `006_clan_logos.sql` adds administrator-configurable logos and matching
website icons. Files under `catalog-icons/branding` are already included in
`icons.tar.gz`; restore that archive together with its database backup. See the
[clan branding guide](clan-branding.md) for upload and recovery behavior.

`infra/backup.sh /safe/new/backup-directory` holds the deployment lock, checks
the running-service inventory, and stops the `app` writer before capturing
PostgreSQL and both uploaded-image volumes. Backups **fail closed** if Docker
Compose inventory fails, the database is not running, a migration or unknown
service is running, the app cannot be confirmed stopped, a capture/checksum
fails, or the originally running app cannot be confirmed restarted. An app that
was already offline is left offline. A failed attempt leaves an incomplete
directory **without `COMPLETE`**; do not restore it or mistake its individual
archives for a valid backup. Inspect the failure and writer restart state,
then retry with a fresh directory. Never bypass the shared deployment lock
outside the coordinated deploy helper.

A completed directory contains:

- `database.dump`: PostgreSQL custom-format database, including accounts,
  collection credits, receipts, settings and audit/history.
- `icons.tar.gz`: complete `catalog-icons` volume, including uploaded
  catalog icons and branding/logo files.
- `screenshots.tar.gz`: complete `submission-images` volume, including
  proof screenshots **and the hidden `.clan-api-key.secret` encryption root**.
  The root must match the encrypted key records in the database; restoring
  the database without it may prevent startup.
- `SHA256SUMS`: verified checksums for the three captures.
- `release.txt` when `.current-release` is available, for image provenance.
- `COMPLETE`: written atomically **only after** capture, checksum validation
  and writer restart verification succeed.

Check the marker and `(cd BACKUP_DIR && sha256sum --check SHA256SUMS)`
before copying the backup to encrypted off-host storage. Restore all three
captures together, preserve file ownership and the encryption root, and
rehearse an isolated restore before production approval. The automated
end-to-end recovery drill remains tracked separately in [#93](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/93).

Migration `004_runelite_submissions.sql` adds the admin-editable clan name,
private screenshot metadata and RuneLite intake receipts. Preserve the new
`submission-images` volume across app recreations; restore `screenshots.tar.gz`
with the database and icon archive from the same coordinated backup. See the
[RuneLite API and recovery guide](runelite-submissions.md).

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
