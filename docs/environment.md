# Environment and development

The production stack uses two long-lived containers: `app` (Nginx, API,
optional Discord gateway) and PostgreSQL `db`. The `migrate` service is a
one-shot bootstrap that uses the **same application image** and exits.
See [release deployment](deployment.md) before recreating an existing DB.

## Required secrets and configuration

Copy `.env.example` to `.env` and keep it private (`chmod 600 .env`).
Generate independent `POSTGRES_PASSWORD`, `APP_DB_PASSWORD` and
`SESSION_SECRET` with `openssl rand -hex 32`.

| Variable | Purpose |
| --- | --- |
| `POSTGRES_PASSWORD` | DB owner, only the PostgreSQL and bootstrap jobs |
| `APP_DB_PASSWORD` | Restricted `clog_runtime` role used by the running application |
| `IMAGE_PREFIX`, `IMAGE_TAG` | One image named `<prefix>-app:<tag>`; successful main SHA tag in production |
| `WEB_PORT` | Loopback diagnostics, default 8088 |
| `AUTH_ENABLED` | Enable admin password login; Traefik override forces true |
| `PUBLIC_ORIGIN` | Exact browser origin for admin login and CSRF, HTTPS in production |
| `ADMIN_PASSWORD` | Shared private admin password (12-256 characters) |
| `SESSION_SECRET` | 32+ random bytes encoded as hex |
| `BOT_ENABLED` | Launch the Discord gateway inside `app`, default false |
| `DISCORD_BOT_TOKEN` | Private Discord bot token |
| `DISCORD_GUILD_ID` | Allowed Discord guild snowflake |
| `BOT_API_TOKEN` | Independent 32-byte+ hex token for bot intake routes |
| `DISCORD_APPLICATION_ID` | Explicit command registration |
| `DISCORD_TEST_GUILD_ID` | Optional explicit test-guild registration |
| `TRUSTED_PROXY_CIDRS` | Optional verified immediate proxy IP/CIDR list |
| `CLOG_HOST` | Production hostname for Traefik Host rule and `PUBLIC_ORIGIN` |
| `COMPOSE_FILE` | Set to `compose.yaml:compose.traefik.yaml` only on the public host |
| `DATABASE_URL` | Host-side Node development connection URI; Compose supplies its own |

The running application listens to API requests on localhost inside the
container (`127.0.0.1:3000`); Nginx publishes only port 8080. The optional
Discord gateway calls the API on that same container-local address.
Credentials are never included in the web bundle.

## Local integrated application

Install Node 24 and Docker Compose v2, then:

```bash
cp .env.example .env
# Configure POSTGRES_PASSWORD and APP_DB_PASSWORD as separate random hex values.
npm ci
npm run validate
docker compose -f compose.yaml -f compose.dev.yaml up -d --build --wait
curl --fail http://127.0.0.1:8088/api/v1/status
```

The local application uses the full bundled catalog and starts with all
items uncollected. The database is available only on host loopback (5432).
To reset **disposable** data, see [fresh-install reset](deployment.md#fresh-install-database-baseline-breaking-change).

For real API admin testing without a password, use the private development
override, never the public Traefik setup:

```bash
docker compose -f compose.yaml -f compose.dev.yaml -f compose.local-admin.yaml up -d --build --wait
# Visit http://127.0.0.1:8088/admin
```

It creates a separate Compose project and volumes with development-only
`DEV_ADMIN_MODE=true`, `AUTH_ENABLED=false`, HTTP loopback origin and no
trusted proxies. Stop the other stack if both want port 8088 or 5432.
Never attach this override to `web` or expose it publicly.

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
