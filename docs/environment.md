# Environment setup

> **8 October 2026 CAT-02 update:** [Admin catalog backend](admin-catalog-backend.md) implements authenticated creation, durable PNG icons, revision-checked ordering and explicit alias reconciliation. Compose now includes an icon volume, and backups include both database and icons. Earlier descriptions of those features as pending are superseded.

## Local prerequisites

Node 24 LTS, npm, Git, and Docker Engine/Desktop with a recent Compose v2 supporting `up --wait`. The initial database is PostgreSQL 17. Native Node development and container development use the same migration files.

```bash
cp .env.example .env
openssl rand -hex 32
# Paste the generated value into POSTGRES_PASSWORD and host DATABASE_URL.
chmod 600 .env
npm ci
npm run build
```

The example contains placeholders, never working production secrets. `.env` is ignored by Git and excluded from Docker contexts. Use hex passwords because Compose interpolates the password into a PostgreSQL URI. If using another password format, URL-encode it explicitly and adapt the URI configuration; do not put an unescaped password into the URL.

## Configuration inventory

| Variable                 | Where          | Current/future purpose                                                           |
| ------------------------ | -------------- | -------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`      | Compose        | Required database owner password; generate locally                               |
| `IMAGE_PREFIX`           | Compose        | Default `ghcr.io/kihiralove/vardorvis-clan-clog`; service suffix is appended     |
| `IMAGE_TAG`              | Compose        | Production `sha-<full main commit SHA>`; placeholder allowed with local override |
| `WEB_PORT`               | Compose        | Loopback host port, default 8088                                                 |
| `DATABASE_URL`           | Host Node      | Host PostgreSQL URI; Compose builds its own URI using `db`                       |
| `HOST` / `PORT`          | API            | Defaults `0.0.0.0` and 3000 in containers                                        |
| `TEST_DATABASE_URL`      | Tests only     | Dedicated disposable database for integration tests                              |
| `PUBLIC_ORIGIN`          | API            | Exact admin origin for password login and CSRF                                   |
| `ADMIN_PASSWORD`         | API            | Private shared admin login password; required when `AUTH_ENABLED=true`           |
| `SESSION_SECRET`         | API            | At least 32 random bytes for session protection                                  |
| `BOT_API_TOKEN`          | Future bot/API | Dedicated service token; generate independently of session secret                |
| `DISCORD_BOT_TOKEN`      | Future bot     | Discord bot credential                                                           |
| `DISCORD_APPLICATION_ID` | Future bot     | Application ID for explicit guild-command registration                           |
| `DISCORD_GUILD_ID`       | Future bot/API | Only clan guild allowed to submit                                                |
| `API_BASE_URL`           | Future bot     | Internal service URL, set to `http://api:3000` by Compose                        |

`AUTH_ENABLED=false` keeps password-protected admin routes unavailable until configured. Enabled auth validates the admin password, session secret and exact site origin at startup. The API receives these through Compose; the web bundle never receives them. `TRUSTED_PROXY_CIDRS` is a comma-separated list of actual proxy IPs/CIDRs (empty trusts none). See [backend setup](backend-phase-one.md) for cookie, session and TLS requirements. Bot variables remain reserved. `apps/web` receives no secrets and will use relative `/api/v1` URLs.

## All-container development

```bash
docker compose -f compose.yaml -f compose.dev.yaml config --quiet
docker compose -f compose.yaml -f compose.dev.yaml up -d --build --wait
curl --fail http://localhost:8088/api/v1/status
docker compose -f compose.yaml -f compose.dev.yaml logs --tail 100
```

The starter UI is available at `http://localhost:8088`; PostgreSQL is exposed only on loopback for development. Migrations run before API startup. The bot profile is omitted by default because it is a scaffold. `--profile bot` can be used for infrastructure smoke testing; it still does not connect to Discord.

## Host-run development

```bash
docker compose -f compose.yaml -f compose.dev.yaml up -d db
node --env-file=.env packages/database/dist/migrate.js
npm run dev:api
# Separate terminal:
npm run dev:web
```

Vite proxies `/api` to `127.0.0.1:3000`; no CORS bypass is needed. `dev:api` watches compiled files, so run `npx tsc -p apps/api/tsconfig.json --watch` in another terminal while editing API TypeScript, or rerun `npm run build`. A changed shared package must be rebuilt too.

For database integration tests, create a separate database rather than pointing tests at your live clan data:

```bash
docker compose exec -T db createdb -U clog clog_test
TEST_DATABASE_URL='postgresql://clog:YOUR_HEX_PASSWORD@127.0.0.1:5432/clog_test' npm test
```

## Bot intake API

[INTAKE-01](bot-intake.md) requires matching `BOT_API_TOKEN` and `DISCORD_GUILD_ID` settings for the API (and eventual bot adapter). Set a fresh 64+ hex-character secret from `openssl rand -hex 32`; both settings must be present together. Without them bot routes remain disabled. The API needs `DATABASE_URL` even when OAuth is off. The Discord gateway is implemented separately in [BOT-01 operations](bot-operations.md). The bot must also receive `DISCORD_BOT_TOKEN`; command registration is always a separate explicit operation.

## XP tracker imports

[XP-01](xp-import.md) uses the existing API PostgreSQL connection and password admin session; no additional secrets are needed. After migration 005, `GET /api/v1/xp/tracker` serves zero until the first valid admin import via `/admin/xp`. The public page does not call WOM. See the import guide for safe source validation, previews and audit behavior.

## Discord setup

For the independent Discord **bot intake** workstream, create a bot and invite it only to the clan guild with `bot` and `applications.commands` scopes. Use the Guilds intent and no message-content privileged intent. Copy application/guild/user IDs as strings. Admin access comes from the application allowlist, not an arbitrary Discord nickname. Keep command registration separate from login/startup and validate in a test guild first.

## GitHub setup

CI and private GHCR publishing use the built-in `GITHUB_TOKEN`; no PAT is needed for Actions publishing. Ensure repository Actions are enabled and workflow package writes are allowed. For pulling on your home server, create a classic PAT with `read:packages` and access to these private packages; authenticate interactively using `docker login ghcr.io -u KihiraLove` or `--password-stdin`.

Create the `home-production` environment and a dedicated self-hosted runner labelled `clog-production` only when ready to deploy. Environment reviewer controls vary by GitHub plan/private-repository support; manual dispatch and successful-main-SHA verification remain required regardless. No runner, credentials, environment or DNS record is provisioned by this repository setup.

## Frontend review and browser tests

The frontend has no new environment secrets or build-time API origin. It requests same-origin `/api/v1/catalog` and `/api/v1/collections`; Vite uses the existing local API proxy. The current foundation API does not implement those reads yet.

For an independent visual review, run `npm run build -w @clog/domain`, then `npm run dev:web` and open `http://127.0.0.1:5173/?preview=1`. Preview starts all uncollected and is clearly labelled. Its explicit sample scenarios never write to the backend and are not a live catalog fallback.

Install Chromium with `npx playwright install chromium` (Linux CI installs dependencies with `--with-deps`), then run `npm run test:e2e -w @clog/web`. See the [frontend review guide](frontend-review.md) for the captured visuals and review scope.

The XP page adds no environment secrets or build-time origins. Open `http://127.0.0.1:5173/xp?preview=1` for independent public/admin UI review; sample imports stay in memory. Live mode uses same-origin XP endpoints and the planned session/CSRF endpoint, with WOM requests performed by the future backend. Live imports/authentication remain unavailable until #27/#4. See the [XP review guide](xp-frontend-review.md).

The submission/catalog frontend also needs no new environment values. Review `/admin?preview=1` and `/admin/catalog?preview=1` with the [admin review guide](admin-frontend-review.md). SPA navigation shares an in-memory catalog and review ledger; reload resets it. Live mode uses same-origin session/CSRF and private admin endpoints from [contracts](contracts.md). Auth, review persistence and durable uploaded assets remain #4/#7/#30. Do not put credentials in web build variables or treat browser validation as server authorization.

## Local admin testing without Discord login

For live-API development, use the opt-in `compose.local-admin.yaml`
override. It creates a **separate Compose project and PostgreSQL volume** for
real review, hardcore settings and WOM import testing, without needing a
Discord login or touching production clan data:

```bash
docker compose -f compose.yaml -f compose.dev.yaml -f compose.local-admin.yaml up -d --build --wait
# Open http://127.0.0.1:8088/admin
# XP imports: http://127.0.0.1:8088/admin/xp
```

Your `.env` still needs `POSTGRES_PASSWORD`. If ports 8088 or 5432 are
already in use, stop the other local stack before starting this one, or
choose different available ports. A fresh browser automatically gets a
time-limited, HTTP-only local development session from
`/api/v1/auth/session`; mutations still use CSRF tokens, expected versions
and database audits. The admin page visibly labels development mode.
No `?preview=1` is needed here: edits persist in the **separate test DB**.
The old `?preview=1` option remains a separate, in-memory UI preview.

The bypass is **off by default**. Startup rejects it unless
`DEV_ADMIN_MODE=true`, `NODE_ENV=development`,
`AUTH_ENABLED=false`, `PUBLIC_ORIGIN` is an HTTP loopback origin and
no trusted proxies are configured. Admin requests with non-loopback Host
or forwarded-host headers are rejected. Never expose this Compose project
through a public reverse proxy or connect it to the real clan database.

Stop only this local stack with:

```bash
docker compose -f compose.yaml -f compose.dev.yaml -f compose.local-admin.yaml down
# Optional: explicitly destroy the disposable local database.
docker compose -f compose.yaml -f compose.dev.yaml -f compose.local-admin.yaml down --volumes
```

For production, omit `compose.local-admin.yaml`; password authentication and session checks remain mandatory.

## Password-protected admin

Discord OAuth is not used for site administration. The single shared password
comes from the server-side `.env` and is never sent to the browser until the
administrator explicitly enters it. Set these values:

```dotenv
AUTH_ENABLED=true
ADMIN_PASSWORD=REPLACE_WITH_A_UNIQUE_STRONG_PASSWORD
SESSION_SECRET=REPLACE_WITH_64_RANDOM_HEX_CHARACTERS
PUBLIC_ORIGIN=http://127.0.0.1:8088
```

Use `openssl rand -hex 32` to generate `SESSION_SECRET`; use a separate
strong password (12–256 characters, preferably a random password). `PUBLIC_ORIGIN`
must match the exact URL you browse; HTTP is accepted only for loopback in
development. Public sites must configure an HTTPS origin and TLS termination.
The password is not stored in Git or in browser local storage.

The API checks the password in constant time, limits login attempts, issues an
HTTP-only expiring session cookie, and requires same-origin CSRF on writes.
Open `/admin` and enter the password; the session also covers `/admin/xp`.
A password change requires restarting the API and changing `SESSION_SECRET`
to invalidate existing sessions. Bot Discord credentials remain separate;
they are only for incoming drop submissions, not admin authentication.

You can still enable the explicit **local-only** passwordless test mode with
`compose.local-admin.yaml`, but production never enables that override.

Manual drops: on `/admin` choose **Add manual submission**, select a catalog
item, collector, collection date and world, optionally include an approved
proof URL and reason. The default immediately approves the drop and updates
public credits; untick it to create a pending claim for review. Duplicate
approved credits per item/world are rejected, and manual provenance and every
action are recorded in the admin audit history.
