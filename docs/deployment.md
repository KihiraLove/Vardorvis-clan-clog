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

Development runs the complete automated suite with `npm run test:all`; see
[local acceptance and release-only CI](local-testing.md). Pushes and PR updates
do not run hosted CI or create packages. Manual **CI → Run workflow** remains
available for an explicitly requested hosted check and never publishes.

Publish a GitHub Release with a version tag such as `v1.2.3` or
`v1.2.3-rc.1` pointing to a commit on `main`. Release CI verifies the tag/commit,
runs the same local acceptance command, then publishes ONE
`linux/amd64` + `linux/arm64` application image with three aliases:

- `ghcr.io/kihiralove/vardorvis-clan-clog-app:v1.2.3`
- `ghcr.io/kihiralove/vardorvis-clan-clog-app:release-<40-character-commit>`
- `ghcr.io/kihiralove/vardorvis-clan-clog-app:sha-<40-character-commit>`

A tag push or draft release does not publish. The release workflow needs available
GitHub Actions budget; ordinary local development does not. Successful runs
upload no test artifacts; failure evidence expires after one day. Image build
records and GitHub-hosted build caches are not uploaded.

**Clean up development images** is manual, with dry-run enabled by default.
It can remove old development versions (including retired `web`, `api` and
`bot` images) after 24 hours from the later creation/update timestamp.
Images tagged exactly `release` or with a `release-` prefix and their
architecture/provenance dependencies are retained indefinitely, as are recent
build dependencies. Every newly published release gets its retention alias
during publishing. Do not remove release aliases while needed for rollback.

Cleanup requires package admin access and stops on manifest/API failures.
Publishing and cleanup share a concurrency group. Review the dry-run plan
before applying deletion; the policy change does not itself delete old storage.

Home deployment remains a separate manual dispatch with a full commit SHA.
It requires a successful **release-triggered** CI run, which includes image
publishing, and no longer promotes or creates package tags. It calls
`/srv/vardorvis-clan-clog/deploy.sh` on the labelled self-hosted runner, backs up
existing data and records the release only after Compose health checks pass.
Image rollback cannot reverse an incompatible schema automatically.

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
# Expected: contiguous 001_baseline.sql through 018_xp_history_pagination.sql
```

The volume name above assumes the default `vardorvis-clog` Compose
project; verify the actual project/volume name before deletion.
The preserved icon files will no longer be referenced by the new empty
database; only remove that volume separately when its contents are
explicitly disposable. CI uses `down --volumes` exclusively on its
own isolated test data.

Never run `down --volumes` on a production deployment. For later releases,
add new forward-only migration files rather than editing this applied baseline.

### Migration history and image compatibility (REVIEW-02/B05)

The one-shot bootstrap first reads the **complete immutable SQL bundle**, then
locks the migration transaction and validates the **entire applied ledger**.
The on-disk manifest must be consecutively numbered (001, 002, ...) without
missing/duplicate revisions. Applied history must be an exact **checksummed
prefix** of that ordered bundle. Unknown/future revisions, missing middle
entries, changed migration contents, reversed recorded timestamps, or
non-prefix history abort the transaction **before any pending DDL**. Applied
SQL files and database-ledger checksums must not be rewritten to force a
release through.

The migration connection must be acquired within 5 seconds. The migration
transaction bounds advisory-lock/DDL lock waits to 10 seconds, statement
execution to 120 seconds, and idle transactions to 125 seconds. A lock or
statement timeout is a failed bootstrap: the application must not be started
against an uncertain schema. The complete batch is transactional and guarded
by the same advisory lock used by catalog imports; retries are safe **after
investigating** the failure and removing the cause.

**Supported image/database combinations:**

- Fresh database + current image: apply all bundled SQL.
- Older database whose applied history is a verified prefix of the image:
  apply only missing migrations in one transaction. The 013 → 014 upgrade
  preserves existing XP events and backfills WOM competition identity.
- The 015 upgrade adds an independent persisted review note; legacy
  `review_reason` values stay untouched for past correction/rejection/revocation
  decisions and existing credits are not rewritten.
- Restart, redeploy, or image rollback with an **identical applied manifest**:
  accepted, provided the other application/schema contracts remain compatible.
- Older image missing any already-applied migration, edited baseline, unknown
  future history, or historical gap: **rejected**. There is no automatic SQL
  downgrade or blanket "ignore unknown migrations" override. If restoring
  an older release needs an older schema, restore the **matching coordinated
  database, icons and screenshots backup**, including the clan-key encryption
  root, and verify it on an isolated instance before changing production.

Schema ledger checks run in the `migrate` Compose one-shot job before the app
service is started; `depends_on: service_completed_successfully` gates startup.
Do not start the runtime service while skipping a failed bootstrap. A populated
013 → 014 regression, failure rollback, concurrent migration serialization,
unknown/reordered/partial ledgers, and advisory-lock timeouts run against
disposable PostgreSQL in CI. Isolated restore rehearsal is tracked in
[#93](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/93).

## Abandoned upload maintenance

Use the bounded, dry-run-first [asset maintenance command](asset-maintenance.md)
to collect abandoned uploads from the shared icon/proof volumes. Migration 016
guards against late commits; historical references and the clan-key encryption
root are retained. The command uses the owner-credentialed `migrate` service,
whose volume mounts now match the application. Coordinate it with backups and
deployment using `.deploy.lock`; no periodic GitHub job is required.

## Expired XP and competition preview maintenance

Both `xp_previews` and `competition_previews` contain large, short-lived
import snapshots. They expire for API use after **10 minutes**. A separate
one-shot database-maintenance command purges rows only after an additional
**60-minute grace period** (default: expiry older than one hour). This avoids
competing with valid previews or delayed in-flight apply requests. The purge
never modifies `xp_import_history`, `competition_import_history`, any audit
table, or published XP/schedule state. Completed import keys continue to
return their saved receipts after preview cleanup.

Run the following in the deployment directory **with the database already
running**, using the exact released `compose.yaml` and `.env`:

```bash
# Read-only report: counts, oldest expiry, cut-off, and would-be eligible rows.
docker compose run --rm --no-deps migrate node packages/database/dist/preview-maintenance.js --dry-run

# Explicit mutation: up to 200 rows/table/batch, five batches per table/run.
docker compose run --rm --no-deps migrate node packages/database/dist/preview-maintenance.js --apply --batch-size=200 --max-batches=5 --grace-minutes=60
```

Schedule the **apply** command daily, for example at **03:00 local server
time** with the host scheduler. Do not add a second permanent service or run
this under an open admin HTTP route. Repeating the job is safe after a crash:
each small transaction commits or rolls back independently, rows under
concurrent apply locks are skipped and remain eligible for a subsequent run,
and a session-scoped advisory lock prevents overlapping maintenance runs.
A competing invocation reports an error and should be retried at the next
scheduled run. Each run is bounded to at most
`batch-size × max-batches` deletions **per table** (default 1,000; maximum
10,000). Adjust `--batch-size=1..500`, `--max-batches=1..20`, or
`--grace-minutes=60..10080` only when necessary. Never reduce the grace
below 60 minutes. Use a scheduler timeout and alert on nonzero exit codes.

The JSON report includes `mode`, a database-clock cutoff, per-table
`before.total`, `before.eligible`, oldest expiry, actual `deleted`,
`after.total`, `after.eligible`, and batches executed; it contains **no**
preview tokens, snapshots, cookies, participant details, or credentials.
Watch `after.eligible` for an increasing backlog and re-run within the
configured batch limits if needed. With a dry run, deleted is always zero.
The provisioned `clog_runtime` role has **SELECT, INSERT and UPDATE,
but no DELETE** on the two transient preview tables. UPDATE is needed for
PostgreSQL's `FOR KEY SHARE` read locks in live apply transactions; the
role cannot delete previews or modify immutable receipt/audit tables. The one-shot `migrate` service is the separately credentialed
schema-owner job, allowed to delete these preview rows. Do not grant the
long-lived application role additional DELETE or expose the database-owner
secret to `app`. These controls are checked in disposable PostgreSQL/Compose
regressions. A partial run or interrupted transaction requires **no**
manual receipt repair: inspect the next dry run and retry the normal job.

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
