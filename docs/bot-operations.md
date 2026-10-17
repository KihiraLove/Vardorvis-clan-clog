# Discord setup

The bot is optional. Create a Discord application/bot, invite it to your guild
with application-command permissions, and configure the server-side variables
in [.env.example](../.env.example). Generate a separate random `BOT_API_TOKEN`
for bot-to-API access; it is not your Discord bot token.

Set `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID` and `BOT_API_TOKEN`, then enable
`BOT_ENABLED=true` and recreate the app. Register commands explicitly:

```bash
# Use DISCORD_TEST_GUILD_ID for a test guild first.
docker compose exec app node apps/bot/dist/register.js test
```

Use `guild` instead of `test` when registering in `DISCORD_GUILD_ID`.
The registration script requires `DISCORD_APPLICATION_ID` and
`DISCORD_TEST_GUILD_ID`. It never runs automatically on application startup.

Members use `/cc-clog submit item proof [submitter-name] [hardcore]`. Choose an
autocomplete match where possible; unmatched text remains reviewable. Proof
must use an accepted HTTPS Imgur or Gyazo host. The server records the collection date.
The private response identifies the saved submission; pending status grants no credit.

The Discord interaction ID is the retry identity. The bot retries uncertain
transport/server failures with the same payload and key. If confirmation remains
uncertain, it does not claim nothing was saved: staff should reconcile by that ID.
First-attempt validation/authorization failures remain authoritative.

The bot calls the authenticated API and never accesses PostgreSQL. User/guild
intake and autocomplete budgets reject excess work with retry guidance; configure
the optional per-minute variables in the example environment. Bot outages affect
`/api/v1/discord/status`, while the website remains available. Shutdown drains
in-flight receipts and acknowledgements before closing the gateway.

Keep real tokens out of Git and test fixtures. Verify commands, permissions,
private receipts and a controlled reconnect in your own test guild before launch.
