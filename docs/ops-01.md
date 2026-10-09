# OPS-01: database permissions and operational gates

Status: review implementation, not a production deployment. Tracked by [#11](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/11).

## Database separation

PostgreSQL's original `clog` login remains the **migration/catalog bootstrap
and backup** owner. The API connects as a separate non-superuser role
`clog_runtime`, whose independent `APP_DB_PASSWORD` is created with
`openssl rand -hex 32`. Do **not** reuse `POSTGRES_PASSWORD`.
The one-shot migrate/bootstrap container receives both secrets. The running API
receives only its own database URL. Neither database secret is built into web
assets. The role provisioning is idempotent and runs **after** migrations and
source/taxonomy import; it revalidates permissions after future migrations.

The role has schema USAGE (not CREATE), SELECT on public views, DML only on
application tables, and necessary sequence usage. It has **no** access to
`schema_migrations`, `catalog_versions` or `catalog_taxonomy_updates`.
Audit tables (`audit_events`, `site_settings_audit`, `catalog_audit`,
`xp_import_history`) receive **SELECT and INSERT only**. No UPDATE, DELETE,
TRUNCATE, ALTER or role-creation grants are given. Future audit tables must
be added to the reviewed allowlist before grant reconciliation; new tables
have no automatic default grants. SQL owner/migration access must never be
exposed to the API service or publicly through Traefik.

## First deployment / migration

1. Back up both database and catalog icons using `infra/backup.sh` before
   attempting migration. Keep the archive off-host and test restoring it.
2. Add an independent, 64+ hex-character `APP_DB_PASSWORD` to the host's
   permissions-restricted `.env`. Preserve the existing `POSTGRES_PASSWORD`.
   A missing runtime secret fails Compose validation instead of falling back
   to the superuser.
3. Ensure the reviewed release includes the new Compose and bootstrap files.
   Run `docker compose config --quiet`, and use the existing normal
   validation/deployment workflow. The successful one-shot bootstrap creates
   and grants `clog_runtime` before the new API starts.
4. Verify the effective API `current_user` is `clog_runtime`; DB permissions
   forbid audit rewrites or schema migration edits. Run login, intake, review,
   XP and catalog smoke tests on **disposable** data before accepting production.
5. On rollback to an older API version, check database and Compose
   compatibility; do not restore a superuser API URL as a convenience.

## Credential rotation drill

First rehearse on an isolated clone. Generate a **new independent**
`APP_DB_PASSWORD`, update host `.env`, and run an orderly Compose
migration/bootstrap plus API recreation while respecting the backup/deploy
lock. The bootstrap rotates the runtime role password transactionally.
Any old API connections may persist until disconnected; stop/recreate the API
(and any writers) as part of the rotation window. Test that old credentials
no longer establish **new** connections and the new role retains restrictions.
Rotate `POSTGRES_PASSWORD` separately using PostgreSQL
`ALTER ROLE` **and** the host secret; only updating Docker's initialization
environment does not change the password on an existing volume.

Rotate `SESSION_SECRET` to invalidate existing admin sessions and notify
administrators to log in again. Rotate `BOT_API_TOKEN` on API and bot
together, and rotate `DISCORD_BOT_TOKEN` through the Discord Developer
Portal, followed by an explicit bot restart/reconnect. This application
uses password-based admin login; Discord OAuth is not part of its current
admin access contract and has no active OAuth secret to rotate. Protect all
secrets from logs, source control, CI artifacts and command history.

## OPS-01 boundaries still awaiting evidence

- Bot `/readyz` now requires **both** a live Discord gateway and a successful
  authenticated, database-backed bot catalog request. Probes are time-bounded
  and cached for five seconds to avoid readiness traffic amplifying load;
  liveness `/healthz` remains separate and works in disabled/test mode.
- Guild/endpoint rate budgets and WOM import throttling, with safe
  per-source error behavior.
- Production hostname/TLS, ARM/AMD64 host, session/cookie and restart drills.
- Coordinated isolated recovery test including XP/audit tables and durable
  uploaded icon assets. The existing backup script includes the whole DB
  and icon volume; restoring and verifying them is a separate gate.

Do not close #11 solely from CI; Docker smoke tests cover container security
and grants, not a running home-host deployment.
