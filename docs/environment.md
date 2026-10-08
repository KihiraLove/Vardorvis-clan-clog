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

| Variable                                      | Where          | Current/future purpose                                                           |
| --------------------------------------------- | -------------- | -------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`                           | Compose        | Required database owner password; generate locally                               |
| `IMAGE_PREFIX`                                | Compose        | Default `ghcr.io/kihiralove/vardorvis-clan-clog`; service suffix is appended     |
| `IMAGE_TAG`                                   | Compose        | Production `sha-<full main commit SHA>`; placeholder allowed with local override |
| `WEB_PORT`                                    | Compose        | Loopback host port, default 8088                                                 |
| `DATABASE_URL`                                | Host Node      | Host PostgreSQL URI; Compose builds its own URI using `db`                       |
| `HOST` / `PORT`                               | API            | Defaults `0.0.0.0` and 3000 in containers                                        |
| `TEST_DATABASE_URL`                           | Tests only     | Dedicated disposable database for integration tests                              |
| `PUBLIC_ORIGIN`                               | API            | Exact external HTTPS origin for OAuth and CSRF                                   |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | API            | OAuth application credentials                                                    |
| `DISCORD_OAUTH_REDIRECT_URI`                  | API            | Exact callback URL registered with Discord                                       |
| `ADMIN_DISCORD_USER_IDS`                      | API            | Comma-separated admin user IDs, not names or roles                               |
| `SESSION_SECRET`                              | API            | At least 32 random bytes for session protection                                  |
| `BOT_API_TOKEN`                               | Future bot/API | Dedicated service token; generate independently of session secret                |
| `DISCORD_BOT_TOKEN`                           | Future bot     | Discord bot credential                                                           |
| `DISCORD_APPLICATION_ID`                      | Future bot     | Application ID for explicit guild-command registration                           |
| `DISCORD_GUILD_ID`                            | Future bot/API | Only clan guild allowed to submit                                                |
| `API_BASE_URL`                                | Future bot     | Internal service URL, set to `http://api:3000` by Compose                        |

`AUTH_ENABLED=false` keeps OAuth disabled until configured. Enabled auth validates all OAuth/session variables on startup; Compose forwards them only to the API. `TRUSTED_PROXY_CIDRS` is a comma-separated list of actual proxy IPs/CIDRs (empty trusts none). See [backend setup](backend-phase-one.md) for cookie, session and TLS requirements. Bot variables remain reserved. `apps/web` receives no secrets and will use relative `/api/v1` URLs.

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

[XP-01](xp-import.md) uses the existing API PostgreSQL connection and OAuth admin session; no additional secrets are needed. After migration 005, `GET /api/v1/xp/tracker` serves zero until the first valid admin import via `/admin/xp`. The public page does not call WOM. See the import guide for safe source validation, previews and audit behavior.

## Discord setup

Create one application in the Discord Developer Portal; register the exact OAuth callback URL, for the future bot workstream, create a bot and invite it only to the clan guild with `bot` and `applications.commands` scopes. Use the Guilds intent and no message-content privileged intent. Copy application/guild/user IDs as strings. Admin access comes from the application allowlist, not an arbitrary Discord nickname. Keep command registration separate from login/startup and validate in a test guild first.

## GitHub setup

CI and private GHCR publishing use the built-in `GITHUB_TOKEN`; no PAT is needed for Actions publishing. Ensure repository Actions are enabled and workflow package writes are allowed. For pulling on your home server, create a classic PAT with `read:packages` and access to these private packages; authenticate interactively using `docker login ghcr.io -u KihiraLove` or `--password-stdin`.

Create the `home-production` environment and a dedicated self-hosted runner labelled `clog-production` only when ready to deploy. Environment reviewer controls vary by GitHub plan/private-repository support; manual dispatch and successful-main-SHA verification remain required regardless. No runner, credentials, environment or DNS record is provisioned by this repository setup.

## Frontend review and browser tests

The frontend has no new environment secrets or build-time API origin. It requests same-origin `/api/v1/catalog` and `/api/v1/collections`; Vite uses the existing local API proxy. The current foundation API does not implement those reads yet.

For an independent visual review, run `npm run build -w @clog/domain`, then `npm run dev:web` and open `http://127.0.0.1:5173/?preview=1`. Preview starts all uncollected and is clearly labelled. Its explicit sample scenarios never write to the backend and are not a live catalog fallback.

Install Chromium with `npx playwright install chromium` (Linux CI installs dependencies with `--with-deps`), then run `npm run test:e2e -w @clog/web`. See the [frontend review guide](frontend-review.md) for the captured visuals and review scope.

The XP page adds no environment secrets or build-time origins. Open `http://127.0.0.1:5173/xp?preview=1` for independent public/admin UI review; sample imports stay in memory. Live mode uses same-origin XP endpoints and the planned session/CSRF endpoint, with WOM requests performed by the future backend. Live imports/authentication remain unavailable until #27/#4. See the [XP review guide](xp-frontend-review.md).

The submission/catalog frontend also needs no new environment values. Review `/admin?preview=1` and `/admin/catalog?preview=1` with the [admin review guide](admin-frontend-review.md). SPA navigation shares an in-memory catalog and review ledger; reload resets it. Live mode uses same-origin session/CSRF and private admin endpoints from [contracts](contracts.md). Auth, review persistence and durable uploaded assets remain #4/#7/#30. Do not put credentials in web build variables or treat browser validation as server authorization.
