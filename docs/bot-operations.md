# Discord setup

The bot is optional. Create your application and bot in the Discord Developer
Portal, then invite it to your server with the `bot` and `applications.commands`
scopes. In **Administration → Discord bot**, enter its application ID, server ID
and bot token. Add a test server ID if needed, switch the bot on and save.

The token is encrypted in the database and never returned to the browser.
Leave its replacement field empty to retain it, or remove it explicitly while
disabling the bot. The internal API credential is generated automatically.
Saving settings or rate limits reloads only the bot within a few seconds; no
environment edits or website restart are needed. The page shows connection status.

Use **Register for test server** or **Register for main server** after saving.
Registration upserts `/cc-clog` without replacing unrelated commands and never
runs automatically. The equivalent local command is
`docker compose exec --user 1000 clan-clog node apps/bot/dist/register.js test` (or `guild`).

Members use `/cc-clog submit item screenshot [submitter-name] [hardcore]`. Choose an
autocomplete match where possible; unmatched text remains reviewable. Attach one
PNG screenshot up to 10 MiB. The app stores a private lossless WebP copy; external
proof links are not accepted. The server records the collection date.
New active catalog items appear in autocomplete automatically; no bot restart or
command registration is needed.
The private confirmation is “Item submitted to review”; pending status grants no credit.
The server records Regular or Event collection using the saved timing.
Closed pages remain collectable as Regular; hardcore is always Regular. Unmatched
normal claims wait for a canonical match before resolving their type.

The Discord interaction ID is the retry identity. The bot downloads the supplied
Discord attachment once, then retries uncertain transport/server failures with
the same multipart payload and key. If confirmation remains
uncertain, it does not claim nothing was saved: staff should reconcile by that ID.
First-attempt validation/authorization failures remain authoritative.

The bot reads its encrypted configuration from PostgreSQL; submissions and
catalog searches go through the authenticated API. User/server intake and search
budgets reject excess work with retry guidance; adjust them on the settings page. Bot outages affect
`/api/v1/discord/status`, while the website remains available. Shutdown drains
in-flight receipts and acknowledgements before closing the gateway.

Back up both the database and private proof volume: its encryption root is
also required to recover Discord credentials. Restore clones keep Discord disabled.
For custom standalone deployments, environment configuration remains available;
see the [configuration table](environment.md). Previously configured environment
values are not imported into the admin page; enter them once and remove them from `.env`.

Keep real tokens out of Git and test fixtures. Verify commands, permissions,
private receipts and a controlled reconnect in your own test guild before launch.
