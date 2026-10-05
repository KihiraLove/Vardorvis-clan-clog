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

## Planned hardcore extension

Bot intake and admin review accept `hardcore: boolean`, default false. Public approved credits include that value, and the canonical item projection exposes `hardcoreCollected` derived from approved hardcore credits only. Include the flag in idempotency comparisons, optimistic version checks and audit before/after values. It never grants credit by itself.

The planned command adds optional `[hardcore:<true|false>]`. The original checked-in command builder above remains unchanged until #26 is implemented. See [feature behavior](planned-features.md) for red borders, the skull and exact text suffix.

## Planned competition XP API

| Method/path                             | Authorization        | Purpose                                                                                    |
| --------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------ |
| `GET /api/v1/xp/skills`                 | Public               | Exact cumulative site XP totals per skill and projection revision                          |
| `GET /api/v1/xp/skills/:skill/members`  | Public               | Per-member cumulative gained XP, keyed by WOM player ID                                    |
| `GET /api/v1/xp/competitions`           | Public               | Imported competition metadata, skills, source links and last successful refresh            |
| `GET /api/v1/xp/competitions/:id`       | Public               | Every imported competitor's gains by skill; includes zero/unavailable rows                 |
| `POST /api/v1/admin/xp/imports/preview` | Admin session + CSRF | Fetch/validate a supplied competition link and show skill/participant/contribution changes |
| `POST /api/v1/admin/xp/imports`         | Admin session + CSRF | Apply the validated preview with request idempotency and expected stored revision          |
| `GET /api/v1/admin/xp/imports`          | Admin session        | Import history, reconciliation decisions and errors                                        |

Preview input is `competitionUrl`. Extract a canonical WOM competition ID; ignore URL fragments/query variants for identity and use the fixed official API origin. The response includes a short-lived preview/snapshot token, expected import revision, competition/skill details, complete competitor rows, and per-skill before/after/change values. Applying a preview records the authenticated actor, reconciles the unique stored competition/player/skill contributions atomically, and returns unchanged/applied with the resulting revision. An unchanged refresh has zero XP change. Reused request keys with different payloads or stale revisions return 409.

Use integer decimal strings for XP totals/contributions in the public/admin JSON contract to preserve exact accumulation. Missing source XP is `null` with an explicit availability state; zero is a valid gain. Client rendering distinguishes competition gained XP, member cumulative gained XP and site cumulative skill XP. No endpoint treats weighted scores, boss kills, activity points, EHP/EHB or aggregate overall values as skill XP.

## Planned admin catalog API

| Method/path                                     | Authorization        | Purpose                                                                            |
| ----------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------- |
| `POST /api/v1/admin/catalog/icons`              | Admin session + CSRF | Validate a multipart raster upload; return a staged generated asset ID and preview |
| `POST /api/v1/admin/catalog/items`              | Admin session + CSRF | Create one canonical item and its selected page memberships                        |
| `GET /api/v1/admin/catalog/pages/:pageId/items` | Admin session        | Current complete ordered membership and page revision                              |
| `PUT /api/v1/admin/catalog/pages/:pageId/order` | Admin session + CSRF | Save an exact membership permutation with expected page revision                   |
| `GET /api/v1/catalog/icons/:assetId`            | Public               | Serve published referenced icon content through same-origin URLs                   |

Item creation requires `name`, `iconAssetId` from a validated upload, and a nonempty unique `pageIds` list of existing pages. External game IDs are optional. Allocate the canonical ID server-side; record the actor from the session. Verify the staged icon is usable, create the item and all memberships atomically, append to each page, advance affected page/catalog revisions and publish the icon reference only after success. Invalid/unknown fields or pages fail the entire operation. Item creation cannot accept collection credits, review status or an effective hardcore flag.

Reorder input is `orderedItemIds` plus `expectedVersion` for that page. Require every current member exactly once, with no missing, duplicate or foreign item. Membership changes and competing reorder saves invalidate the expected revision and return 409. Apply slots atomically without transient unique-slot collisions. Return the resulting order/version; preserve canonical IDs, other pages and approved credits. Unauthorized writes are rejected using the same session/CSRF rules as review.

Creation/order writes invalidate the public catalog revision and bot autocomplete cache. Reads include manual items without game IDs. Uploaded assets live outside the Docker image and survive restarts/upgrades. Catalog action auditing and manual override/source reconciliation are distinct from submission review auditing.

Only the foundation endpoints listed at the top are implemented. These routes and fields are planned in #26, #27, #28, #30 and #31.

## Sources checked for platform constraints

- [Discord application command structures, choice limits and autocomplete](https://docs.discord.com/developers/interactions/application-commands)
- [Discord interaction delivery and responses](https://docs.discord.com/developers/interactions/receiving-and-responding)
- [GitHub Container Registry authentication and package visibility](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- [Docker multi-platform GitHub Actions builds](https://docs.docker.com/build/ci/github-actions/multi-platform/)

- [Wise Old Man competition endpoint and metrics preview](https://docs.wiseoldman.net/api/competitions/competition-endpoints)
- [Wise Old Man metrics and per-participant delta entities](https://docs.wiseoldman.net/api/competitions/competition-type-definitions)
- [Wise Old Man supported skill/metric definitions](https://docs.wiseoldman.net/api/global-type-definitions)
