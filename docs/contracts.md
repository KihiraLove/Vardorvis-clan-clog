# API and Discord contracts

Only the three foundation endpoints below currently exist. All other routes in this document are planned contracts, not working APIs.

## Shipped foundation

| Method/path          | Behavior                                                                |
| -------------------- | ----------------------------------------------------------------------- |
| `GET /healthz`       | API liveness; 200 with service status                                   |
| `GET /readyz`        | 200 only if migrated database is available; otherwise 503               |
| `GET /api/v1/status` | `stage: foundation`, `catalogReady: false`, `submissionsEnabled: false` |

## Planned routes

| Method/path                                    | Authorization                     | Purpose                                                         |
| ---------------------------------------------- | --------------------------------- | --------------------------------------------------------------- |
| `GET /api/v1/catalog`                          | Public                            | Versioned items, tabs/pages, ordered slot IDs; ETag             |
| `GET /api/v1/collections`                      | Public                            | Approved item credits and revision; excludes evidence/actor IDs |
| `GET /api/v1/bot/items?q=...`                  | Bot credential                    | Ranked canonical autocomplete candidates                        |
| `POST /api/v1/bot/submissions`                 | Bot credential + configured guild | Idempotent intake and resolution suggestions                    |
| `GET /api/v1/auth/discord`                     | Browser                           | Start OAuth with state and approved redirect                    |
| `GET /api/v1/auth/discord/callback`            | OAuth state/code                  | Create allowlisted admin session                                |
| `POST /api/v1/auth/logout`                     | Session + CSRF                    | Destroy session                                                 |
| `GET /api/v1/admin/submissions?status=pending` | Admin session                     | Paginated queue including unmatched submissions                 |
| `PATCH /api/v1/admin/submissions/:id`          | Admin session + CSRF              | Resolve/edit item, collector or date with expected version      |
| `POST /api/v1/admin/submissions/:id/approve`   | Admin session + CSRF              | Atomic approval and audit event                                 |
| `POST /api/v1/admin/submissions/:id/reject`    | Admin session + CSRF              | Reject with reason                                              |
| `POST /api/v1/admin/submissions/:id/revoke`    | Admin session + CSRF              | Revoke approved credit with reason                              |

Bot writes contain `interactionId`, `guildId`, `actorDiscordId`, `rawItemText`, optional `itemId`, `collectorName` and `proofUrl`. The API sets submission timestamp/date default. A later optional collection date requires a validated ISO calendar date and explicit source. The bot cannot send approval state or reviewer identity.

Intake returns 201 for a new durable pending submission, or 200 with the same receipt for an exact interaction retry. A reused interaction ID with a different payload is a 409 conflict. Return `resolution: resolved|needs_match` and canonical candidates. No fuzzy suggestion grants credit.

Review writes carry `expectedVersion`; conflicts return 409. Standard errors are `{ "error": { "code": "...", "message": "..." } }`. Use 400/422 for invalid fields, 401 for missing credentials, 403 for forbidden actors/guilds, 404 for absent resources and 429 for rate limits. Never include secrets or raw server errors.

## Discord definition

The checked-in [command builder](../apps/bot/src/command.ts) defines this schema:

| Field            | Required | Resolution                                                                     |
| ---------------- | -------- | ------------------------------------------------------------------------------ |
| `item`           | Yes      | Autocomplete canonical ID or raw text; manual resolution for uncertain matches |
| `proof`          | Yes      | HTTPS Imgur/Gyazo link; admin inspects actual evidence                         |
| `submitter-name` | No       | Collector display snapshot, default current guild name/username                |

Guild registration and gateway handling are not implemented yet. Add a separate registration script, a guild-only runtime check, 25-result autocomplete responses, ephemeral deferral/receipts, timeout/error handling and a service-authenticated API adapter. Record interaction IDs as strings; Discord snowflakes must not be converted to JavaScript numbers.

The second requested command is an open product decision. An optional explicit collection-date input is also an open decision; current date handling is documented in [requirements](requirements.md).

## Sources checked for platform constraints

- [Discord application command structures, choice limits and autocomplete](https://docs.discord.com/developers/interactions/application-commands)
- [Discord interaction delivery and responses](https://docs.discord.com/developers/interactions/receiving-and-responding)
- [GitHub Container Registry authentication and package visibility](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- [Docker multi-platform GitHub Actions builds](https://docs.docker.com/build/ci/github-actions/multi-platform/)
