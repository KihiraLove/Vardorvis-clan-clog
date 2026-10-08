# Discord gateway and command registration (BOT-01)

Implementation of [BOT-01 #6](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/6) builds on authenticated, durable [INTAKE-01](bot-intake.md). The Discord adapter is not an approval system: every confirmed receipt is **pending**. Admin approval and single-credit enforcement remain in #7.

## Runtime

Enable the optional bot Compose profile only after configuring:
- `DISCORD_BOT_TOKEN`: Discord bot token, kept on the host; never exposed in web assets.
- `DISCORD_GUILD_ID`: the one clan guild allowed to submit (17–20 digit Discord snowflake).
- `BOT_API_TOKEN`: a dedicated independent 32-byte-or-longer hex token, matching the value on the **API** container. Generate with `openssl rand -hex 32`.
- `API_BASE_URL`: internal API origin (Compose defaults to `http://api:3000`).

For example `docker compose --profile bot up -d`. In the absence of **all** credentials the bot runs in explicit disabled mode (for CI/infrastructure smoke testing). A partially configured bot fails at startup. `/healthz` reports process liveness, configured state and Discord connection; `/readyz` returns 200 only when Discord's gateway client is connected, otherwise 503. This distinction allows an operator to distinguish an unconfigured or disconnected bot from a usable Discord service.

The only gateway intent is `Guilds`; no privileged message-content or member intent is used. The command is rejected in DMs or any other guild. Reconnects are handled by discord.js without replacing interaction listeners. SIGINT/SIGTERM stop receiving new interactions and destroy the client. Discord OAuth admin credentials do not give the bot permission to approve claims or list the admin queue.

## Explicit registration

Do not register or overwrite commands during normal container startup.

1. Invite the bot application to the selected guild with `bot` and `applications.commands` scopes.
2. Set `DISCORD_APPLICATION_ID` to the Discord application's numeric ID and `DISCORD_TEST_GUILD_ID` to an isolated test guild ID.
3. Build first, then explicitly run `npm run register:test -w @clog/bot` with those variables and the bot token in the environment. On Compose, use `docker compose --profile bot run --rm -e DISCORD_TEST_GUILD_ID=... bot node apps/bot/dist/register.js test`.
4. Verify autocomplete and private receipts in the test guild. Once approved for the production clan guild, explicitly run `npm run register:guild -w @clog/bot` with `DISCORD_GUILD_ID` (or run the container with `node apps/bot/dist/register.js guild`).

The registration script uses the per-command Discord POST **upsert**, not a bulk guild-command PUT. It therefore does not remove other commands, and it does not run on container restart.

## User flow

`/cc-clog submit item:<item or catalog choice> proof:<HTTPS Imgur/Gyazo> [submitter-name:<name>] [hardcore:true|false]`

- Catalog autocomplete queries the current API catalog **on every interaction**, returns up to 25 ranked matches and sends `item:<canonical ID>` choice values. Admin-created items without an OSRS game ID are selectable. Free-text item entries are still accepted and may require manual matching.
- If no explicit collector name is supplied, take the current guild display name/nickname, then fall back to the Discord username; save that **snapshot**.
- The bot defers **ephemerally** before sending any API request. It locally validates the proof URL, while the API repeats authoritative validation. The bot never fetches the evidence URL itself.
- The bot forwards immutable Discord actor, guild and interaction IDs, raw item selection, optional canonical ID and the boolean hardcore claim (default false) to the API. No date option is added; the API defaults to the submission's UTC date.
- Only a durable API 201 or idempotent 200 receipt produces an ephemeral `Saved for admin review` message; manual-match and already-approved same-mode claims are clearly identified. A receipt never asserts that credit has been awarded.
- API timeouts/network errors use one retry with **identical** interaction ID and payload to recover a receipt following an uncertain commit. Validation/auth conflicts are not retried. When the API cannot confirm a receipt, the bot reports uncertainty, not success.
- Normal and hardcore credit are separate; a duplicate already-approved canonical item in the same mode is flagged for human review. Approval cannot add a second active credit in that mode.

## Verification

`npm run validate` covers command serialization, token/guild config, collector fallback, autocomplete refresh, explicit canonical selections, raw/ambiguous submissions, proof validation, request timeouts and idempotent retries, occupied-credit warnings, registration route, and gateway teardown/reconnect state. No live Discord token is needed for CI.

The Docker smoke workflow runs the bot **unconfigured**, verifying disabled-mode liveness without contacting Discord. A live configured guild/gateway test remains an environment-dependent release check; do not mistake CI mocks for an actual Discord login. Registration and deployment are deliberately opt-in.
