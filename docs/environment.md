# Configuration

Copy [the example](../.env.example) to `.env`. Ordinary settings belong here;
Docker initialization generates the database owner password, restricted database
password and session key in three separate persistent Docker volumes. Only the
services that need a secret receive its read-only volume. Do not delete these
volumes during an update. They are ordinary protected storage, not an encrypted vault.

Create the first administrator with the explicit setup command in the [README](../README.md).
It prints a temporary password once; the first login requires a different password.
Normal application startup does not need a bootstrap password in its environment.

## All supported settings

Defaults below distinguish Docker Compose from host-run Node commands. A secret
value and its matching `_FILE` input are mutually exclusive. Files must be
absolute paths **inside the consuming container/process**, regular readable files,
nonempty and at most 64 KiB. One final newline is allowed. Never commit secret
files or print their contents in diagnostics. External secret providers can mount
files and supply these paths through a Compose override; provide each file only
to its consumers. Managed files use mode 0600 and container UID 1000; external
files must be readable by their consuming process. Provider-managed credentials need their own protected backup
and rotation procedure; the bundled rotation command manages generated volumes.

| Label                           | Default / use                                     | Explanation                                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IMAGE_NAME`                    | `ghcr.io/kihiralove/clan-clog`                    | Full published application image repository; change for a fork.                                                                                                                  |
| `IMAGE_TAG`                     | Required for published images                     | Approved release tag; versioned deployment selects it from the verified manifest. The development overlay uses `clan-clog:dev`.                                                  |
| `WEB_PORT`                      | `8088`                                            | Host loopback port forwarded to the website.                                                                                                                                     |
| `AUTH_ENABLED`                  | Example: `true`; unset: `false`                   | Enables staff authentication and administration.                                                                                                                                 |
| `PUBLIC_ORIGIN`                 | Example: `http://127.0.0.1:8088`                  | Exact browser origin. HTTPS is required except HTTP loopback in development.                                                                                                     |
| `TRUSTED_PROXY_CIDRS`           | Empty                                             | Verified external proxy IPs/CIDRs, comma separated. The bundled launcher adds its internal Nginx loopback hop.                                                                   |
| `POSTGRES_PASSWORD`             | Automatically generated                           | Optional explicit initialization seed or host-tool owner credential; 32–128 independent random bytes as hex. Changing a seed does not rotate an installed password.              |
| `POSTGRES_PASSWORD_FILE`        | Compose: `/run/clog-secrets/postgres/value`       | Owner credential file; consumed by PostgreSQL and database maintenance. External paths require corresponding mounts.                                                             |
| `APP_DB_PASSWORD`               | Automatically generated                           | Optional initialization seed or host runtime credential; independent from the owner password.                                                                                    |
| `APP_DB_PASSWORD_FILE`          | Compose: `/run/clog-secrets/app/value`            | Restricted application database credential; consumed by the API, setup-admin and migrator.                                                                                       |
| `SESSION_SECRET`                | Automatically generated                           | Optional initialization seed or host authentication key; shared across staff sessions, independent from both DB credentials. Rotation signs everyone out.                        |
| `SESSION_SECRET_FILE`           | Compose: `/run/clog-secrets/session/value`        | Persistent session/CSRF key file, read by the API.                                                                                                                               |
| `ADMIN_BOOTSTRAP_PASSWORD`      | Unset                                             | Explicit automated provisioning input for `setup-admin --from-env`; 32–128 random bytes as hex. Host-run API bootstrap also supports it. Never resets an existing administrator. |
| `ADMIN_BOOTSTRAP_PASSWORD_FILE` | Unset                                             | File alternative for automated first-administrator provisioning. Normal Compose runtime does not mount a bootstrap credential.                                                   |
| `DATABASE_URL`                  | Unset                                             | Host/custom deployment PostgreSQL URL. Overrides individual DB connection fields and can contain credentials; keep private.                                                      |
| `DATABASE_URL_FILE`             | Unset                                             | File containing the complete PostgreSQL connection URL.                                                                                                                          |
| `DB_HOST`                       | Compose: `db`; host: `127.0.0.1`                  | Database hostname for a connection assembled from secret files.                                                                                                                  |
| `DB_PORT`                       | `5432`                                            | Database port, from 1 to 65535.                                                                                                                                                  |
| `DB_NAME`                       | `clog`                                            | Database name for host/custom tools. Bundled Compose services use `clog`.                                                                                                        |
| `DB_USER`                       | Owner tools: `clog`; API: `clog_runtime`          | Connection role override for host/custom tools. Preserve the bundled restricted runtime role.                                                                                    |
| `POSTGRES_DB`                   | Compose-fixed: `clog`                             | PostgreSQL image database name; change only with a consistent custom Compose configuration.                                                                                      |
| `POSTGRES_USER`                 | Compose-fixed: `clog`                             | PostgreSQL image owner role; not an application account.                                                                                                                         |
| `HOST`                          | Host API: `0.0.0.0`; Compose: `127.0.0.1`         | API listen address. The bundled proxy keeps the API private.                                                                                                                     |
| `PORT`                          | `3000`                                            | API listen port inside its process/container.                                                                                                                                    |
| `NODE_ENV`                      | Compose: `production`; dev overlay: `development` | Runtime mode; development permits the HTTP loopback origin.                                                                                                                      |
| `ICON_STORAGE_PATH`             | Compose: `/data/catalog-icons`                    | Durable icon/branding directory; host-run API requires an absolute writable path.                                                                                                |
| `PROOF_STORAGE_PATH`            | Compose: `/data/submission-images`                | Durable private proof directory, also containing the clan-key encryption root.                                                                                                   |
| `BOT_ENABLED`                   | `false`                                           | Starts the Discord gateway when its credentials are configured. RuneLite does not require it.                                                                                    |
| `BOT_API_TOKEN`                 | Empty                                             | Internal Discord-to-API credential; 32+ random bytes as hex. API intake requires this and `DISCORD_GUILD_ID` together.                                                           |
| `BOT_API_TOKEN_FILE`            | Unset                                             | File alternative read by both the API and Discord process.                                                                                                                       |
| `DISCORD_BOT_TOKEN`             | Empty                                             | Discord gateway token from the Developer Portal.                                                                                                                                 |
| `DISCORD_BOT_TOKEN_FILE`        | Unset                                             | File alternative for the Discord gateway token.                                                                                                                                  |
| `DISCORD_GUILD_ID`              | Empty                                             | Discord server snowflake used for intake authorization and gateway operation.                                                                                                    |
| `DISCORD_APPLICATION_ID`        | Empty                                             | Discord application snowflake, used for command registration.                                                                                                                    |
| `DISCORD_TEST_GUILD_ID`         | Empty                                             | Optional test-guild snowflake for explicit command registration; never registered automatically.                                                                                 |
| `API_BASE_URL`                  | Compose: `http://127.0.0.1:3000`                  | Bot's internal API origin; standalone bot default is `http://api:3000`.                                                                                                          |
| `BOT_INTAKE_USER_PER_MINUTE`    | `5`                                               | Per-user Discord submission admission limit.                                                                                                                                     |
| `BOT_INTAKE_GUILD_PER_MINUTE`   | `60`                                              | Per-guild Discord submission admission limit.                                                                                                                                    |
| `BOT_SEARCH_USER_PER_MINUTE`    | `30`                                              | Per-user Discord search/autocomplete admission limit.                                                                                                                            |
| `BOT_SEARCH_GUILD_PER_MINUTE`   | `300`                                             | Per-guild Discord search/autocomplete admission limit.                                                                                                                           |
| `CLOG_HOST`                     | Empty                                             | Public hostname for the optional Traefik overlay.                                                                                                                                |
| `TRAEFIK_HTTPS_ENTRYPOINT`      | `websecure`                                       | Existing Traefik HTTPS entrypoint name.                                                                                                                                          |
| `TRAEFIK_CERT_RESOLVER`         | `letsencrypt`                                     | Existing Traefik certificate resolver name.                                                                                                                                      |
| `COMPOSE_FILE`                  | Operator-selected                                 | Compose files, separated by colons on Linux; select the same files for startup and maintenance.                                                                                  |
| `COMPOSE_PROJECT_NAME`          | `clan-clog`                                       | Installation namespace. Changing it selects different networks and volumes.                                                                                                      |
| `COMPOSE_PROFILES`              | Unset                                             | Optional Compose profiles. The `setup` profile contains setup-admin; explicitly targeting that service enables it.                                                               |
| `COMPOSE_ENV_FILES`             | Launcher-selected `.env`                          | Explicit environment file used by versioned deployment.                                                                                                                          |
| `COMPOSE_DISABLE_ENV_FILE`      | Launcher: `true`                                  | Prevents accidental loading of another directory's implicit `.env`.                                                                                                              |
| `CLOG_IMAGE_NAME`               | `ghcr.io/kihiralove/clan-clog`                    | Registry repository used by the installed deployment launcher.                                                                                                                   |
| `CLOG_DEPLOY_ROOT`              | `/srv/clan-collection-log`                        | Installation directory for versioned deployments.                                                                                                                                |
| `CLOG_DEPLOY_PROJECT`           | `clan-clog`                                       | Deployment namespace; isolated helpers validate their dedicated restore/release prefixes.                                                                                        |
| `CLOG_USE_TRAEFIK`              | First deployment: `true`                          | Includes the Traefik overlay; set false for another HTTPS proxy. Later deployments retain the recorded choice.                                                                   |
| `CLOG_SETUP_ADMIN`              | Launcher-managed                                  | Set by the explicit `deploy.sh RELEASE_SHA --setup-admin` flag; omitted for updates.                                                                                             |
| `CLOG_RELEASE_DIR`              | Launcher-managed                                  | Verified infrastructure directory for the selected release.                                                                                                                      |
| `CLOG_LAUNCHER_SHA256`          | Launcher-managed                                  | Installed launcher checksum recorded in release evidence.                                                                                                                        |
| `RELEASE_IMAGE`                 | Launcher-managed                                  | Resolved application image digest; not a user-selected mutable tag.                                                                                                              |
| `RELEASE_DB_IMAGE`              | Launcher-managed                                  | Resolved PostgreSQL image used by deployment/restore.                                                                                                                            |
| `CLOG_SECRETS_ROOT`             | Init CLI: `/run/clog-secrets`                     | Managed credential directory; advanced initialization tools/tests only.                                                                                                          |
| `CLOG_DATABASE_DATA`            | Init CLI: `/database-data`                        | Read-only PG data directory used to detect an existing installation.                                                                                                             |
| `BACKUP_DEPLOY_LOCK_HELD`       | Helper-managed                                    | Prevents nested locking when a verified deployment/rotation invokes backup.                                                                                                      |
| `TEST_DATABASE_URL`             | Unset                                             | Disposable database for targeted integration tests; never point it at clan data.                                                                                                 |
| `LOCAL_DOCKER_SOCKET`           | `/var/run/docker.sock`                            | Optional local acceptance runner Docker socket override.                                                                                                                         |

## Existing development installation

If PostgreSQL already has data but managed secret volumes do not exist, startup
stops instead of inventing replacement credentials. Preserve the existing three
values and explicitly run `docker compose run --rm init --adopt-environment`
with the same development overlay, then remove those three seeds from `.env`.
This adopts credentials without resetting the database or administrator. Do not
run setup-admin on an installation that already has an administrator.

## Rotation and recovery

Use the same Compose selection as startup, then run
`bash infra/rotate-secrets.sh app`, `session` or `postgres`. The command takes
a coordinated private backup, stops the writer, rotates the selected credential,
and recreates the app. Owner/runtime rotation updates PostgreSQL as well as the
file. Session rotation invalidates all staff sessions. A failed rotation retains
protected pending state; repair access and repeat with `--resume`. Never replace
credentials by editing initialization seeds. See [backup and recovery](release-recovery.md).

RuneLite clan matching/API keys are managed in the administrator UI, not in
`.env`. See [RuneLite](runelite-submissions.md), [Discord](bot-operations.md),
[hosting](deployment.md) and [development](local-testing.md).
