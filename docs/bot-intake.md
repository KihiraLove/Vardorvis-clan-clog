# Discord bot intake (INTAKE-01)

Issue [#5](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/5) implements only the API-facing intake slice. The Discord slash-command gateway and receipts sent to Discord are implemented under [BOT-01](bot-operations.md); review/approval endpoints are separate [REVIEW-01](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/7). No intake route creates an approved collection credit.

## Enable the service

On the **API** service configure both `BOT_API_TOKEN` (at least 32 random bytes as hex: `openssl rand -hex 32`) and `DISCORD_GUILD_ID` (a 17–20 digit Discord guild snowflake). Both must be set together; an incomplete/weak configuration fails startup. `DATABASE_URL` is required for intake even if OAuth administration is disabled. The Compose bot receives the same token and guild ID independently, and the bot uses it through the Discord gateway when configured.

The bot credential uses `Authorization: Bearer <BOT_API_TOKEN>`. It is checked on **only** `/api/v1/bot/items` and `/api/v1/bot/submissions`, never as an admin session, and is not included in the web bundle. Do not expose the token to browser clients. Both routes return `Cache-Control: no-store`. Search and intake are unavailable (404) until the API has a store and both config values.

## Search and submission

- `GET /api/v1/bot/items?q=axe&limit=25`: `{"items":[{"id":42,"name":"Dragon axe"}]}`. Search is catalog-wide, including manual items with no external game ID. Query is optional (empty returns the first ranked items). Limit is 1–25, default 25. Prefix/substring and short edit-distance matches are suggestions **only**.
- `POST /api/v1/bot/submissions` accepts required string fields `interactionId`, `guildId`, `actorDiscordId` (all Discord snowflakes), `rawItemText` (nonblank, up to 200), `collectorName` (nonblank, up to 80), and `proofUrl` (up to 2048). Optional: integer `itemId` for an explicit canonical selection and `hardcore` as a strict boolean (default false). `collectedOn` is **not accepted**; the server alone assigns the date. Unknown fields or incorrect types are rejected.
- HTTPS proof URLs are accepted only from `imgur.com`, `www.imgur.com`, `m.imgur.com`, `i.imgur.com`, `gyazo.com`, `www.gyazo.com`, or `i.gyazo.com` and require a non-root path. Username/password, alternate ports and lookalike hosts are rejected. The API does **not** download the submitted URL or certify the evidence; a reviewer must inspect it.
- Exact normalized item names or aliases resolve only when the canonical item is unambiguous. A selected `itemId` must reference an active canonical item. The special `item:<canonical id>` value also resolves a selection. Unmatched, fuzzy or ambiguous inputs keep `itemId: null` for manual matching. Raw text, proof, collector snapshot, actor and guild stay private in PostgreSQL.
- The database captures `submittedAt` as a UTC timestamp and sets `collectedOn` to the UTC calendar date of receipt, with `dateSource: "submission_default"`. The submitting user cannot supply a date; admin corrections, when needed, are separate and audited (`"admin"`).

An inserted pending claim responds **201**, an exact interaction retry responds **200**, both with the same durable receipt (`submissionId`, `interactionId`, `status: "pending"`, `submittedAt`, `collectedOn`, `dateSource`, `hardcore`, `resolution`, `itemId`, `candidates`, `creditOccupied`). The immutable SHA-256 comparison includes all actor/guild/claim fields, canonical selection and hardcore flag; omitted hardcore and explicit false are identical. Reusing an interaction ID with changed payload returns **409**, even after a review or catalog change. PostgreSQL uniqueness and `ON CONFLICT` prevent parallel retries from inserting twice, and failed transactions never emit a success receipt.

`creditOccupied: true` explicitly warns that the selected item is already approved in that world mode. Intake remains a **pending evidence claim**, not another collectible item; a later approval must respect the unique `(item_id, hardcore)` partial index. Normal/hardcore are independent; selecting another mode never copies credit.

## Verification

`npm run validate` runs matching, proof/date validation, route/authorization/idempotency tests and, when `TEST_DATABASE_URL` is present, disposable PostgreSQL tests for concurrent same/changed retries, single credit per mode, rollback/recovery and immutable receipts across store instances. CI supplies the test database. The existing database migrations are forward-only; migration 004 adds alias and intake receipt storage without changing historical submission rows.
