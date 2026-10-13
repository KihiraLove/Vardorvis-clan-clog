# Discord gateway and command registration (BOT-01)

Implementation of [BOT-01 #6](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/6) builds on authenticated, durable [INTAKE-01](bot-intake.md). The Discord adapter is not an approval system: every confirmed receipt is **pending**. Admin approval and single-credit enforcement remain in #7.

## Runtime

In the combined `app` container, set `BOT_ENABLED=true` and configure
`DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID` and `BOT_API_TOKEN` before starting
the gateway. The internal API origin is `http://127.0.0.1:3000` and needs no
separate service DNS name. Set `BOT_ENABLED=false` (the default) to run the
web/API without attempting a Discord connection. Incorrect or partial bot
credentials with the bot enabled cause container startup to fail and restart.

The Discord gateway exposes internal `127.0.0.1:3001/healthz` and
`/readyz`; `/readyz` succeeds only when Discord and the bot's authenticated
API route are available. No bot port is published. A child process crash
causes the combined container to restart. Slash commands must still be
registered explicitly, not during startup.

The only gateway intent is Guilds; the command is rejected in DMs or other
guilds. The adapter cannot approve submissions. Admin site login remains a
shared password, not Discord OAuth.

## Explicit registration

Do not register or overwrite commands during normal container startup.

1. Invite the bot application to the selected guild with `bot` and `applications.commands` scopes.
2. Set `DISCORD_APPLICATION_ID` to the Discord application's numeric ID and `DISCORD_TEST_GUILD_ID` to an isolated test guild ID.
3. For a real test submission, run the **test instance** of the bot and intake API with `DISCORD_GUILD_ID` set to that same test guild. Merely registering a command in a different guild does not bypass the runtime guild restriction.
4. Build first, then explicitly run `npm run register:test -w @clog/bot` with those variables and the bot token in the environment. On Compose, use `docker compose run --rm --no-deps -e DISCORD_TEST_GUILD_ID=... app node apps/bot/dist/register.js test`.
5. Verify autocomplete and private receipts in the test guild. Once approved for the production clan guild, explicitly run `npm run register:guild -w @clog/bot` with `DISCORD_GUILD_ID` (or run the container with `node apps/bot/dist/register.js guild`).

The registration script uses the per-command Discord POST **upsert**, not a bulk guild-command PUT. It therefore does not remove other commands, and it does not run on container restart.

## User flow

`/cc-clog submit item:<item or catalog choice> proof:<HTTPS Imgur/Gyazo> [submitter-name:<name>] [hardcore:true|false]`

- Catalog autocomplete queries the current API catalog **on every interaction**, returns up to 25 ranked matches and sends `item:<canonical ID>` choice values. Admin-created items without an OSRS game ID are selectable. Free-text item entries are still accepted and may require manual matching.
- If no explicit collector name is supplied, take the current guild display name/nickname, then fall back to the Discord username; save that **snapshot**.
- The bot defers **ephemerally** before sending any API request. It locally validates the proof URL, while the API repeats authoritative validation. The bot never fetches the evidence URL itself.
- The bot forwards immutable Discord actor, guild and interaction IDs, raw item selection, optional canonical ID and the boolean hardcore claim (default false) to the API. No date option exists; the API assigns the UTC receipt date and rejects caller-supplied dates.
- Only a durable API 201 or idempotent 200 receipt produces an ephemeral `Saved for admin review` message; manual-match and already-approved same-mode claims are clearly identified. A receipt never asserts that credit has been awarded.
- API timeouts/network/5xx errors use **one** retry with the **identical Discord interaction ID and payload** to recover a durable 200/201 receipt following an uncertain commit. A permanent 4xx received on the **first** attempt is not retried. If the first attempt may have committed and the subsequent retry is rejected (including 401, 403, 409 or 422), the error **does not** say "Nothing was saved": that rejection cannot disprove the first commit. An invalid/mismatched/unreadable success receipt is also unconfirmed and is not retried. Only a valid 200/201 pending receipt is displayed as saved.
- An unconfirmed interaction reports its **numeric Discord interaction ID** (not its token, raw request, SQL or proof URL) in the ephemeral response. A clan admin should search the submission/receipt history for this ID before taking further action. **Running /cc-clog submit again creates a new Discord interaction ID**, so it is not an idempotent replay of the original request and may create a second pending claim. Do not issue a fresh command until staff has reconciled the original interaction. No approval or credit is implied by an unconfirmed request.
- Normal and hardcore credit are separate; a duplicate already-approved canonical item in the same mode is flagged for human review. Approval cannot add a second active credit in that mode.

### Reconcile an unconfirmed receipt

The interaction ID in the private Discord reply is the durable idempotency key.
Staff with authorized **database access** can look up the existing receipt,
without fetching the proof URL or exposing any credentials:

```sql
SELECT id, status, submitted_at
FROM submissions
WHERE discord_interaction_id = '345678901234567890';
```

Replace the sample ID with the **numeric** Discord interaction ID supplied in
the reply. The `id` column is the stored submission receipt ID; `status`
is its current review state. A match means the original interaction was saved:
do **not** submit it again. If no matching row exists, investigate whether the
original request was still in flight or failed before commit before asking the
player to start a new command. Keep bot credentials, database errors and
submission evidence out of Discord follow-up messages. The admin review UI
need not expose private Discord IDs; this is an operator investigation query.

## Verification

`npm run validate` covers command serialization, token/guild config, collector fallback, autocomplete refresh, explicit canonical selections, raw/ambiguous submissions, proof validation, request timeouts and idempotent retries, occupied-credit warnings, registration route, and gateway teardown/reconnect state. No live Discord token is needed for CI.

The Docker smoke workflow runs the combined application with `BOT_ENABLED=false`, without contacting Discord. Unit tests cover the bot's liveness/readiness states. A live configured guild/gateway test remains an environment-dependent release check; do not mistake CI mocks for an actual Discord login. Registration and deployment are deliberately opt-in.
