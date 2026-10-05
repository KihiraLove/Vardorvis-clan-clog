# Architecture

One TypeScript/npm-workspace repository and one PostgreSQL database keep the initial deployment small. The Discord bot is an adapter, not a second source of business rules or direct database writer. The API is the only planned submission/review/XP-import/catalog writer.

```mermaid
flowchart TD
  Public["Public log"] --> Web["Web / same-origin proxy"]
  Admin["Admin review"] --> Web
  Web --> API["API: reads, auth, review"]
  Discord["Discord bot"] --> API
  API --> DB["PostgreSQL"]
```

## Boundaries

The web container serves static assets and proxies `/api/` to the API. The external reverse proxy terminates TLS. Public endpoints return only catalog data and approved collection credits; proof links, pending claims, Discord IDs and audit metadata remain private.

The bot connects outbound to Discord's gateway and the internal API. Submission writes use a dedicated service credential, restricted to bot routes. The credential must not authorize admin routes. Human admins use Discord OAuth, server-side sessions, a fixed redirect URL and an explicit ID allowlist. V1 does not require public visitors to log in.

Foundation API endpoints are `/healthz`, `/readyz` and `/api/v1/status`. Readiness checks that PostgreSQL is reachable and the migrated collection-state view exists; it does not indicate catalog/features are complete.

## Canonical identity

`items.id` is the stable internal canonical collection-log item identity. `game_item_ids` maps external OSRS source variants/aliases to it when source evidence justifies equivalence; external IDs do not define the internal namespace. Preserve existing canonical IDs permanently. The planned admin creation flow supports manual items with no external game ID, using a collision-safe allocator for imported and manual records. Never merge by display name alone.

`pages` describes the category and source page order. `page_items(page_id, item_id, slot)` supplies the many-to-many relationship and exact slot ordering. An item is stored once even when it occurs on multiple pages. All collection state is derived by canonical ID from approved submissions; no `collected` boolean is copied into page rows.

Initial schema: [001_initial.sql](../packages/database/migrations/001_initial.sql). The schema has no catalog seed or fake approvals.

| Entity                  | Main invariant                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `catalog_versions`      | Source URL/revision and import timestamp identify the checked-in snapshot            |
| `items`                 | Stable canonical item ID; soft deactivation preserves existing credits               |
| `game_item_ids`         | One source game item ID maps to exactly one canonical item                           |
| `pages` / `page_items`  | Ordered slots; one occurrence of a canonical item per page                           |
| `submissions`           | Unique Discord interaction ID; optional item while unmatched; approval requires item |
| `audit_events`          | Before/after review values and authenticated actor                                   |
| `collection_credits`    | Approved submissions only; all approved collectors retained                          |
| `item_collection_state` | Item collected iff at least one approved credit exists                               |

## Review transactions

An approval endpoint must authenticate an allowlisted admin, validate all fields, lock the submission and verify the client's expected version, resolve a real item, change status and insert an audit event in one transaction. Return 409 for stale/concurrent reviews. Increment `version` on every change. Record the actor from the session, never from a request body.

Rejecting a pending claim does not alter approved credits. Revoking an approval removes that credit from the derived public view. The item remains collected while another approved credit exists. Multiple legitimate collectors for the same item are allowed; Discord retries of the same interaction are not.

The foundation SQL enforces basic foreign keys/status checks/idempotency uniqueness. Auth, input checks, review state transitions and append-only audit permissions are implementation tasks; the schema alone is not a complete review service.

## Catalog updates

Create a reproducible import tool with a reviewed snapshot, source revisions, item mapping, category/page ordering, icon manifest and attribution. Use primary source data from the game/community-maintained source, and compare against reference client screenshots. The OSRS Wiki collection-log page is a candidate taxonomy source; its contents have not been imported or verified in this foundation.

Diff every import. Retain canonical IDs, carry approved credits forward, add new items as uncollected, deactivate removed entries rather than deleting history, and reject dangling or ambiguous mappings. Validate complete coverage against the selected revision. Sharing an item between pages is different from merging similarly named items. The planned admin catalog overlay takes precedence for manual items, icons, memberships and explicit page ordering; source refreshes must preserve it and require explicit identity reconciliation when a newly imported item matches a manual entry.

## Planned hardcore and competition XP extensions

Hardcore remains a property of an approved collection credit. Add `submissions.hardcore` with a default-false value in a new forward migration, expose it in approved public credits, and derive `hardcoreCollected` by canonical item ID. Do not change the deployed initial migration or store separate flags in page slots. Review corrections and revocations use the existing versioned transaction/audit rules.

The XP gained page is a separate site route. Add a WOM adapter behind authenticated admin import endpoints; public clients read stored projections and never fetch WOM on each page load. The adapter parses an allowed competition URL, extracts its ID, and calls the fixed official API host. It uses current `metrics` and per-participation `deltas[].values.gained`, with a bulk per-skill preview for overall competitions where needed.

Planned tables/projections: imported competition identity/source metadata; WOM player identity/name snapshots; unique contributions keyed by `(competition_id, player_id, skill)`; import batches/audit records; and per-skill/member total projections. SQL XP totals use exact integer storage. Reconcile a complete validated snapshot in one transaction so an import retry or concurrent refresh cannot append the same gains twice. Separate XP import audit records from the existing submission-specific audit foreign key.

The baseline for a new skill is zero. Preserve any existing recorded site XP when migrating a later deployment. The skill total is that baseline plus all active stored competition/player contributions; refresh replaces a competition's contribution and changes totals by `new - previous`. All participant rows remain visible, including known-zero/unavailable source rows. Import reconciliation/history handles corrected gains, participant removals and changed metrics without silently rewriting prior credits.

The full [feature design](planned-features.md) defines mixed hardcore credits, exact XP arithmetic, metric handling, public/admin routes, failure behavior and verification. These are planned extensions; the initial SQL and foundation runtime do not implement them yet.

## Planned admin catalog maintenance

The Add item form requires icon, name and at least one existing page. The API creates one canonical item and its memberships atomically, initially appending it to each selected page. No credit or hardcore flag is created. Catalog/domain validation must support manual items without external game IDs; the current foundation validator still requires a nonempty `gameItemIds` array and will change in #30.

Record source/manual provenance, overrides, page revisions, icon assets and catalog audit events in forward-only migrations. The initial submission-specific `audit_events` table cannot record catalog actions without appropriate new storage. Keep the original migration intact. Imported IDs and the internal allocator must not collide or renumber existing items.

Reordering accepts a complete ordered list of canonical IDs and the expected page revision. Lock/check the page, validate an exact permutation of its current membership, and rewrite slots in a single transaction. Handle the existing unique `(page_id, slot)` constraint safely during swaps. Item creation/source membership changes also advance affected page revisions; stale editors receive 409. Neither item IDs, collection credits nor other pages change. Invalidate the catalog ETag and bot search cache after committed edits.

Upload bounded raster icons through authenticated admin routes, verify/decode PNG/WebP content, and use generated asset IDs rather than client filenames or fetched URLs. Persist published icons in a dedicated storage volume, served through same-origin API URLs. Keep staging assets separate from published catalog references and clean up abandoned uploads; failed item creation must not leave a visible partial item.

The admin UI offers drag-and-drop plus keyboard-accessible move/position controls and an explicit Save order action. Manual overlay/order metadata survives source imports; future source additions append without disturbing a saved order. Explicit source/manual reconciliation retains the manual canonical ID and its credits instead of creating duplicates. #30 covers storage/API/reconciliation rules; #31 covers admin controls. These additions are planned, not implemented by this documentation update.

## Operational policy

PostgreSQL is authoritative. Public reads may be cached with an ETag; approved/revoked writes invalidate that projection. Rate-limit bot writes and OAuth/review endpoints. Keep secrets and proof URLs out of logs. Use parameterized SQL, bounded request sizes, CSRF/origin validation on browser writes, secure session cookies behind TLS and escape names in the UI.

Back up database and deployment configuration, and include the planned uploaded-icon volume in coordinated backups/restores once #30 ships. Test restores, then add least-privilege database roles before V1. The foundation Compose uses one database owner for migrations/runtime to keep setup executable; separating migrator and runtime privileges is a tracked hardening requirement.
