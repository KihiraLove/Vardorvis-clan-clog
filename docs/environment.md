# Environment and development

The production stack uses two long-lived containers: `app` (Nginx, API,
optional Discord gateway) and PostgreSQL `db`. The `migrate` service is a
one-shot bootstrap that uses the **same application image** and exits.
See [release deployment](deployment.md) before recreating an existing DB.

For the full automated suite, use `npm run test:all` with Node 24 and Docker.
The [local test runner](local-testing.md) supplies disposable databases, test
credentials, Linux tooling and Chromium; it does not load your runtime `.env`.

## Required secrets and configuration

Copy `.env.example` to `.env` and keep it private (`chmod 600 .env`).
Generate independent `POSTGRES_PASSWORD`, `APP_DB_PASSWORD` and
`SESSION_SECRET` with `openssl rand -hex 32`.

**Database credentials:** `POSTGRES_PASSWORD` is used by PostgreSQL and
the one-shot bootstrap; `APP_DB_PASSWORD` is the separate restricted runtime
password. `DATABASE_URL` is for host-side Node development only.

**Image and ports:** `IMAGE_PREFIX` and `IMAGE_TAG` select the one
`<prefix>-app:<tag>` release image. `WEB_PORT` is the loopback diagnostic
port (default 8088).

**Screenshots:** Compose sets `PROOF_STORAGE_PATH=/data/submission-images`
on a durable private volume. Standalone API development must use an absolute
writable directory (required when staff auth is enabled). Configured storage
and a database enable [RuneLite submissions](runelite-submissions.md) without
Discord credentials. Clan name is a database-backed admin setting.
RuneLite submissions also require a random shared clan API key by default.
Admins can disable enforcement and rotate/view the key in Site settings.
No additional environment secret is needed: the private screenshot volume
holds the encryption root, which must be backed up with the database.

**Admin authentication:** `AUTH_ENABLED` controls staff-account
login; `PUBLIC_ORIGIN` must exactly match the browser origin.
`SESSION_SECRET` must
hold 32+ random bytes encoded as hex. `TRUSTED_PROXY_CIDRS` optionally lists
verified upstream proxy IPs and CIDRs (including Traefik). The bundled app
always trusts its internal Nginx loopback hop. Leave the list empty only when
no external reverse proxy is used;
see [the trust-chain configuration](deployment.md#existing-traefik).

For a fresh installation, generate a fourth independent secret with
`openssl rand -hex 32` and set it as `ADMIN_BOOTSTRAP_PASSWORD` in the private
environment file. It must contain 64–256 hexadecimal characters. Authenticated
startup fails before listening if no administrator exists and this value is
missing; there is no default password. Compose passes it only to the API runtime,
never to the web bundle.

The first authenticated startup creates one administrator with username `admin`
and that bootstrap password, and no moderators. Sign in at `/admin` using the
generated value and choose a different 12–256 character password before staff
tools become available. Remove `ADMIN_BOOTSTRAP_PASSWORD` from the environment
after setup and recreate/restart the app to remove it from the running container.
Later startups work without it; supplying another value cannot reset, reactivate
or recreate an existing administrator, including one whose username changed.
Concurrent initializers create only one account; use the credential from the
initializer that created it. Keep a fresh installation private until setup is
complete. If provisioning fails, resolve the error and retry with the same
credential; account creation is not a password-reset mechanism.

The administrator
can create moderators under **Moderator accounts**; each receives a temporary
password and must replace it on first login. Both roles can change their own
username and password under **Your account**, confirming the current password.
Usernames are case-insensitively unique and use 3–32 letters, numbers, dots,
underscores or hyphens. Credential changes revoke other sessions.

Passwords are stored only as independently salted scrypt verifiers in PostgreSQL;
the API never returns hashes. `ADMIN_PASSWORD` is no longer used. Renaming the
administrator or restarting the app does not restore bootstrap credentials.
Upgrading preserves existing accounts and passwords; an operator must replace
any legacy `admin` password through account settings before exposing that account.
Moderators can review, submit, maintain the catalog and import XP; only the
administrator can access the hardcore release switch and account creation.

Migration `003_staff_accounts.sql` is additive and invalidates previous shared
sessions. Back up before upgrading, apply migrations and reconcile runtime
permissions with the one-shot bootstrap. Database backups now include account
hashes and must remain private. The old shared-password image does not support
these accounts; restore the coordinated pre-upgrade backup when rolling back.

**Discord:** `BOT_ENABLED` launches the gateway (default false).
`DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID` and `BOT_API_TOKEN` enable it;
`DISCORD_APPLICATION_ID` and `DISCORD_TEST_GUILD_ID` are used for
explicit command registration.

**Traefik:** `CLOG_HOST` is the public hostname; production
`COMPOSE_FILE` selects `compose.yaml:compose.traefik.yaml`.
`TRAEFIK_HTTPS_ENTRYPOINT` and `TRAEFIK_CERT_RESOLVER` refer to names
already configured in the existing proxy.

The running application listens to API requests on localhost inside the
container (`127.0.0.1:3000`); Nginx publishes only port 8080. The optional
Discord gateway calls the API on that same container-local address.
Credentials are never included in the web bundle.

## Local integrated application

Install Node 24 and Docker Compose v2, then:

```bash
cp .env.example .env
# Configure POSTGRES_PASSWORD, APP_DB_PASSWORD and SESSION_SECRET independently.
# Set AUTH_ENABLED=true to enable staff login; keep PUBLIC_ORIGIN on HTTP loopback.
# For the first installation, set ADMIN_BOOTSTRAP_PASSWORD from openssl rand -hex 32.
npm ci
npm run validate
docker compose -f compose.yaml -f compose.dev.yaml up -d --build --wait
curl --fail http://127.0.0.1:8088/api/v1/status
```

The local application uses the full bundled catalog and starts with all
items uncollected. The database is available only on host loopback (5432).
To reset **disposable** data, see [fresh-install reset](deployment.md#fresh-install-database-baseline-breaking-change).

Visit `http://127.0.0.1:8088/admin` and sign in with your staff credentials.
Local development requires the same password login and first-login password
change as production. With `AUTH_ENABLED=false`, staff tools are unavailable.

## Host-side development and tests

```bash
docker compose -f compose.yaml -f compose.dev.yaml up -d db
npm ci
npm run build
# Populate DATABASE_URL with host 127.0.0.1:5432 credentials.
npm run db:migrate
npm run catalog:import
npm run dev:api
# In a second terminal: npm run dev:web
```

Vite proxies `/api` to local Fastify port 3000. Database integration tests
require an explicitly disposable `TEST_DATABASE_URL`; they intentionally
skip without it. CI provisions PostgreSQL for those tests. Frontend-only
mock review remains at `http://127.0.0.1:5173/?preview=1`.

For Discord commands and registration, see [bot operations](bot-operations.md).
For operational backup/recovery and Traefik setup, see
[deployment](deployment.md) and [OPS-01](ops-01.md).
