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

The application requires a **dedicated database**. Provisioning removes PUBLIC
access to its public schema, tables, sequences and routines, and PUBLIC database
CREATE/TEMPORARY rights. It also clears global/public-schema default grants from
the bootstrap owner and existing default-ACL grantors. These changes affect
other logins using PUBLIC privileges; do not run this bootstrap in a shared
database. The bootstrap owner must have authority to reconcile those grants
and runtime role memberships.

[The runtime policy](../packages/database/src/runtime-role.ts) names every
permitted public table, view and sequence. Unknown objects receive no access.
Only `collection_credits` and `item_collection_state` are readable views;
`catalog_versions` and `item_aliases` are read-only tables. Migration and
taxonomy ledgers remain owner-only. Mutable tables receive only the operations
their API paths need, rather than blanket DML. Append-only audit/history and
request receipts, including `catalog_requests`, permit **SELECT and INSERT**
but reject UPDATE, DELETE and TRUNCATE. Audit sequences cannot be reset; the
canonical item sequence retains UPDATE for catalog allocation's `setval`.

Reconciliation removes direct grants, column grants and inherited role access,
then verifies the complete effective privilege matrix before committing.
The runtime cannot create schemas, public objects, temporary tables or roles,
delegate grants, bypass row security, or directly call public routines. Trigger
writes still run with the intended table permissions. New objects must have
an explicit reviewed policy before the API uses them; missing or incompatible
required objects abort provisioning. Existing checksummed SQL migrations stay
unchanged.

If `clog_runtime` owns the database or a public schema object, provisioning
fails: ownership rights cannot be removed by REVOKE. Repair ownership with the
migration owner under the normal backup/deployment procedure, then retry.
Any reconciliation failure rolls back the password and privilege changes.
SQL owner/migration access must never be exposed to the API service or publicly
through Traefik.

## Database connection failures (#66 / REVIEW-02 B04)

The production API consumes PostgreSQL's asynchronous idle-client `error`
events instead of allowing Node to terminate. These errors are categorized
using a fixed allowlist of connection/termination codes and logged without
driver error objects, connection strings, SQL statements or parameters.

`GET /healthz` reports process liveness independently of PostgreSQL.
`GET /readyz` performs fresh database checks on every request and responds
with 503 when connections, reads or dependencies fail; when the database
recovers, the pool establishes fresh connections and readiness recovers
without an API restart. In-flight queries may fail with a sanitized 503.
**No failed database write is automatically replayed**: a lost connection
around a commit can leave the outcome uncertain. Clients must use the
operation's original idempotency key/receipt reconciliation flow rather
than issuing a new write blindly.

Hosted integration coverage terminates both idle and blocked active
PostgreSQL backends against the real API entry point, verifies readiness
and clean signal shutdown, and restarts the Compose PostgreSQL service
to confirm 503 → 200 recovery with the same API process. Database restart
testing is isolated from production data.

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
