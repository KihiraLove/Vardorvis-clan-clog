# ADR 001: monorepo and initial deployment

Status: accepted for the project foundation, 2026-10-05. Open product questions are recorded below and can be changed without rewriting history.

| Decision                                      | Reason                                                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| TypeScript + npm workspaces                   | One language and shared types/validation across web, API and bot; small initial toolchain          |
| React/Vite and Fastify                        | Separate static public/admin client and an API suitable for a self-hosted service                  |
| PostgreSQL, SQL migrations                    | Foreign keys, transactional reviews, idempotency and auditable durable state                       |
| Canonical item + ordered page membership      | One approval affects every repeated page occurrence while preserving source layout                 |
| Item collected from approved credits          | Pending/rejected claims cannot leak into public state; revocation remains consistent               |
| One current collector per world mode          | Superseded multi-collector display; one active approved item/mode credit, private history retained |
| Shared-password admin login                   | Supersedes Discord OAuth; exact origin, expiring server-side sessions and CSRF are required        |
| Discord gateway bot → internal API            | Outbound connectivity suits home hosting; API owns business writes                                 |
| Autocomplete plus raw-text fallback           | A full log cannot fit a fixed 25-choice Discord list; admins resolve ambiguity                     |
| UTC receipt date, separate admin correction  | Owner-confirmed: only the server sets the submitted claim's date at receipt |
| Private GHCR, multi-architecture images       | Fits existing GitHub/private repo and ARM/AMD64 home servers                                       |
| Manual validated-SHA home deployment          | Makes initial rollout/rollback reviewable before unattended deployments                            |

The 7 October mockup supersedes the initial multi-collector, admin-OAuth and display assumptions. [ADR 002](002-command-date-display.md) is the active DEC-01 record: the single `/cc-clog submit` command and server-issued UTC receipt date are now confirmed. Proxy/TLS deployment and final visual acceptance still need owner review. The public display is already confirmed as one approved credit per canonical item and world mode.

## Planned extensions recorded 2026-10-05

- Hardcore is evidence on a collection credit, default false. An item is hardcore-collected while any approved hardcore credit remains. Red item/menu borders, the in-menu skull and the `on hardcore worlds` suffix follow that approved state; ordinary and hardcore collectors can coexist.
- The separate XP gained route accumulates competition-reported skill gains, using the selected competition's entire participant roster. Stable WOM player IDs preserve membership rows across name changes.
- Store each competition/player/skill contribution once and reconcile refreshes by the difference, preserving existing site totals. Distinct competitions contribute independently; overlapping periods are exposed rather than mislabelled as unique lifetime XP.
- Use current WOM `metrics`/`deltas`, raw skill gains and an explicit per-skill bulk preview for overall competitions; no weighted score or non-XP metric enters skill totals.
- Admin item creation requires only icon, name and existing page(s); external OSRS game IDs are optional. Allocate stable internal canonical IDs and preserve them when manually reconciling later source data. Shared-page credits remain one item history.
- Save item order independently per page through versioned atomic writes. Preserve manual item/icon/membership/order overrides during source imports and keep uploaded icons in durable storage backed up with the database.
- These decisions are planned in #26, #27, #28, #30, #31 and [the detailed feature design](../planned-features.md). No runtime feature or schema extension is shipped by the documentation update.

No cloud hosting provider or external paid service is required. No automatic launch, Discord message sending, domain changes or live host changes occur during repository setup.
