# Configuration

Copy [the example](../.env.example) to `.env` and restrict access to it
(`chmod 600 .env` on Linux). Values below are server-side only.

| Setting                    | Purpose                                                           |
| -------------------------- | ----------------------------------------------------------------- |
| `POSTGRES_PASSWORD`        | DB owner; setup and backups only                                  |
| `APP_DB_PASSWORD`          | Separate restricted runtime DB password                           |
| `AUTH_ENABLED`             | Set `true` to enable staff tools                                  |
| `PUBLIC_ORIGIN`            | Exact browser origin; HTTPS required outside loopback development |
| `SESSION_SECRET`           | Independent random hex secret; rotation signs everyone out        |
| `ADMIN_BOOTSTRAP_PASSWORD` | One-time random hex secret for the first `admin` login            |
| `IMAGE_NAME` / `IMAGE_TAG` | Full registry image path and published tag                        |
| `WEB_PORT`                 | Loopback port; default 8088                                       |
| `TRUSTED_PROXY_CIDRS`      | Verified external proxy IPs or CIDRs, comma separated             |

Generate each secret independently with `openssl rand -hex 32`. Owner and
runtime DB passwords must differ. The first admin must choose a different
12–256 character password. Then remove the bootstrap value and recreate the
app. Changing that value later does not reset an existing account.

If startup reports `ADMIN_BOOTSTRAP_REQUIRED`, the database has no administrator
and the bootstrap password is missing. This can happen when reusing an older
`.env` with new database volumes. Add a fresh generated value, recreate the app,
then complete the first-login password change before removing it again.

For local builds use the command in the [README](../README.md). For published
images set `IMAGE_NAME=ghcr.io/<owner>/clan-clog` and an approved release tag.
The example points to the upstream owner's package. See [deployment](deployment.md).

## Optional integrations

RuneLite intake needs a configured in-game clan name and clan API key, managed
by the administrator in the UI. It works without Discord credentials. Keep the
private proof volume: it also contains the encryption root for that key.

Discord uses `BOT_ENABLED`, `BOT_API_TOKEN`, `DISCORD_BOT_TOKEN`,
`DISCORD_GUILD_ID`, `DISCORD_APPLICATION_ID` and `DISCORD_TEST_GUILD_ID`.
See [Discord setup](bot-operations.md); never enable a copied bot token.

Traefik uses `CLOG_HOST`, `TRAEFIK_HTTPS_ENTRYPOINT` and
`TRAEFIK_CERT_RESOLVER`. Names must match your proxy configuration.

## Host development

`DATABASE_URL` is for host-run tools; Compose constructs its own DB URLs.
Host-run API development also needs absolute writable `ICON_STORAGE_PATH`
and `PROOF_STORAGE_PATH` directories. Compose mounts these automatically.
See [development](local-testing.md) for commands.
