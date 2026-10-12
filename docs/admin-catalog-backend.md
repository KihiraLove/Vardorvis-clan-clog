> **Release update:** Schema 008 is part of the consolidated fresh-install [baseline](../packages/database/migrations/001_baseline.sql), not a separate upgrade step.

# Admin catalog backend (CAT-02)

The existing `/admin/catalog` UI now uses authenticated storage for item creation, icon uploads and page ordering. No external game ID is required. A newly created item appears on all selected pages and in catalog search, uncollected in both world modes.

## Routes and authorization

All admin reads require an authenticated administrator or moderator account. Every mutation also requires the configured same-origin `Origin` and session-bound `X-CSRF-Token`. Authentication runs before body parsing and validation. Actors come from the session, never a request field. Private responses use `Cache-Control: no-store`.

| Route                                          | Contract                                                                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/admin/catalog`                    | Full catalog with source revision, item provenance/overrides, page versions and order provenance                             |
| `POST /api/v1/admin/catalog/icons`             | One multipart `icon` file; returns `assetId`, same-origin `iconPath` and expiry                                              |
| `POST /api/v1/admin/catalog/items`             | `{ name, iconAssetId, pageIds }` plus a stable `Idempotency-Key`; returns the item, page IDs and catalog revision            |
| `PUT /api/v1/admin/catalog/pages/:id/order`    | Complete `orderedItemIds` and `expectedVersion`; returns the saved page/revision                                             |
| `POST /api/v1/admin/catalog/items/:id/aliases` | Explicit `gameItemIds`, `expectedRevision` and nonblank `reason`; attaches unclaimed external aliases to that canonical item |
| `GET /api/v1/catalog/icons/:uuid.png`          | Published icons are public; staged icons require their uploading admin's session and unexpired stage                         |
| `GET /api/v1/catalog/search?q=...`             | Current public item matches, capped at 25, with the same catalog revision used by public reads                               |

Names are trimmed, nonblank, at most 200 characters, and contain no control characters. Page IDs must be distinct and already exist. Item creation never creates a page. External IDs can be reconciled separately through the authenticated alias endpoint; the existing creation form retains its three required inputs.

The search endpoint supplies autocomplete consumers with current canonical IDs, names and icon paths. The existing admin matching UI reads the same live catalog. The merged Discord gateway and submission-review service use that catalog, so manual items are immediately available for bot autocomplete and exact review matching.

## Storage and image handling

[icon-storage.ts](../apps/api/src/icon-storage.ts) accepts still PNG/WebP input up to **2 MiB** and dimensions from **1 to 512 pixels**. Sharp verifies the actual decoded format, dimensions and single-frame status, then losslessly encodes PNG without resizing. Transparency and native pixels are preserved; metadata and trailing source content are discarded. MIME spoofing, SVG, animation, truncated/invalid raster data and excessive dimensions are rejected. Multipart limits allow one file and no extra fields; Nginx permits 3 MiB including envelope overhead.

Names supplied by browsers never become paths. Each icon receives a generated UUID. The server writes a new temporary file, flushes it, renames it atomically and flushes the directory before inserting database metadata. A failed metadata insert removes that upload. A crash between file creation and metadata commit can leave an unreferenced file, but cannot publish a missing image. Creation verifies the stored bytes/hash before claiming the stage. Missing/corrupt/unwritable storage returns 503 without committing an item.

Stages expire after 30 minutes and belong to the uploading actor. Each actor may have at most 20 unexpired unused stages. Expired stages are inaccessible and cannot create items. This release retains expired/orphan files for conservative recovery rather than running automatic deletion; include them in capacity monitoring and backups. Never delete a file referenced by `items.icon_asset_id` / a claimed `catalog_assets` row. A future cleanup tool must coordinate with the catalog write lock and distinguish claimed assets from abandoned stages.

Published icons have immutable generated paths, verified bytes, `image/png` and `nosniff` headers. An authenticated staged preview is private and never cached publicly. Creating new `IconStorage`/API instances reads the same durable bytes.

Compose mounts the named **`catalog-icons`** volume at `/data/catalog-icons` in the API. The image initializes that directory with ownership for its unprivileged `node` user. Icons are outside the image/container writable layer. Public requests pass through the same API proxy; Nginx does not need direct volume access.

For a host-run API, set `ICON_STORAGE_PATH` to an absolute directory writable by the service user. It is required when authentication is enabled; Compose supplies its own fixed path. The server checks storage on startup. Example for the WSL checkout:

```dotenv
ICON_STORAGE_PATH=/home/dkert/projects/Vardorvis-clan-clog/.data/catalog-icons
```

The ignored `.data/` directory is suitable for local development. Use a backed-up service directory in production. Keep Linux and Windows dependency installations separate.

## Transactions, identities and revisions

[008_admin_catalog.sql](../packages/database/migrations/001_baseline.sql) is a forward-only migration. Earlier migrations are unchanged.

| Entity                                                   | Responsibility                                                                            |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `canonical_item_id_seq` / `items.id` default             | Allocate internal IDs above existing imported/manual IDs while preserving established IDs |
| `items.origin`, `items.overrides`, `items.icon_asset_id` | Source/manual provenance, protected fields and durable icon ownership                     |
| `page_items.origin`                                      | Preserve manual memberships separately from source memberships                            |
| `pages.version`, `pages.order_origin`                    | Optimistic concurrency and explicit saved order                                           |
| `catalog_state.version`                                  | Revision shared by public reads, search and admin receipts                                |
| `catalog_assets`                                         | Generated ID, SHA-256, dimensions, byte size, uploader, stage expiry and claiming item    |
| `catalog_requests`                                       | Actor-scoped idempotency key, normalized payload hash and committed creation receipt      |
| `catalog_audit`                                          | Independent create/reorder/reconcile audit with actor, time and before/after values       |

[PgCatalogStore](../apps/api/src/catalog-store.ts) serializes catalog writers using advisory lock `74261005`, also used by initial imports and migrations. The allocator accounts for explicitly imported IDs that are ahead of its sequence. Equal display names do not merge items. Game-ID uniqueness is enforced by the existing alias primary key.

Creation claims an unexpired stage belonging to the actor, allocates one ID, appends each selected membership, records an audit and stores the idempotent receipt in a single transaction. Reusing the same request key/fields returns that receipt, even after the stage has been claimed. Reusing the key for different fields returns 409. The operation writes no submissions or credits.

Reordering locks the page, compares its version and verifies an exact permutation. Membership rows are deleted/reinserted within the transaction with their original provenance; this avoids transient unique-slot collisions. The page gets explicit manual order provenance and an audit. Other pages, item identities and both world-mode credits remain unchanged. Competing order or membership edits return 409 to a stale editor.

Database triggers advance page versions on membership mutations and advance catalog revisions on item, page and alias changes, including future source writers. Public ETags and search revisions include the catalog version. Repeatable-read snapshots prevent a response from mixing items, membership and revision from different transactions.

## Source refresh and reconciliation boundary

### Whole-page management

Both staff roles can create, reorder and delete pages in **Items catalog → Page
management**. These session/Origin/CSRF-protected endpoints use the catalog/import
lock and commit the revision, memberships and audit together:

- `POST /api/v1/admin/catalog/pages`: `name`, `category`, ordered `itemIds` (may
  be empty), `expectedRevision`, plus a stable `Idempotency-Key`. Returns the page
  and catalog revision. Retries return the original durable receipt; changing
  the payload under that key returns 409. Names must be distinct within a category.
- `PUT /api/v1/admin/catalog/pages/order`: `category`, `orderedPageIds` containing
  every active page in that category exactly once, and `expectedRevision`.
- `DELETE /api/v1/admin/catalog/pages/:id`: `expectedRevision` and
  `expectedVersion`. Removes all memberships and deactivates the page. Items
  without another active page are deactivated; shared items and all review/credit
  history remain intact. Stale revisions/versions return 409.

Migration 011 retains deleted page rows for audits and retries, records manual
page position separately from item ordering, and adds append-only page creation
receipts. Public/staff catalogs exclude deleted pages. An intentionally empty
catalog after deleting the last page is valid. Normal bootstrap never recreates
deleted pages, and initial clue correction refuses to overwrite manually changed
page positions or deleted clue pages.

Repeated CAT-01 bootstrap imports remain no-ops: they preserve manual names/icons/items/memberships, explicit order and credits. Changed source snapshots are still refused by the initial importer; reviewed source refresh itself remains [#10](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/10).

That refresh workflow must use existing alias mappings, retain `origin=manual` items and memberships, honor item override fields and retain explicit page order. Newly discovered source memberships append deterministically when a page has manual ordering. A possible manual/source match requires an explicit reconciliation decision; name similarity is only a review hint, never an identity rule.

The new alias endpoint provides that identity decision without changing the canonical ID, icon, memberships or credits. It checks an expected catalog revision, rejects aliases owned by another item, and audits the supplied reason. It does not merge or delete an already-created duplicate identity. Manual provenance/overrides remain intact after adding an external ID. The future refresh adapter must consult these mappings instead of blindly importing the source's suggested internal IDs.

## Backup and restore

A database-only backup cannot restore uploaded icons. [infra/backup.sh](../infra/backup.sh) now creates a coordinated pair. It briefly stops whichever API/bot services are running, dumps PostgreSQL, archives the icon volume, writes SHA-256 checksums and a `COMPLETE` marker, then resumes those services. Run it from the Compose project directory with its deployment environment loaded:

```bash
bash infra/backup.sh backups/clog-20261008
```

Use a new directory each time. Treat an archive without `COMPLETE` or with failing checksums as incomplete. The helper does not include `.env` or credentials. [infra/deploy.sh](../infra/deploy.sh) calls it before changing containers. The write pause is intentional so database references and immutable icon files represent the same application state. The helper shares the deployment lock to reject simultaneous backups/deployments; external database writers must also be paused.

Restore both files from the **same completed backup** during a maintenance window:

1. Verify `COMPLETE` and run `sha256sum --check SHA256SUMS` inside the backup directory. Retain a separate backup of the current installation first.
2. Stop API and bot writers. Restore the database dump with `pg_restore --clean --if-exists --exit-on-error` into the intended database.
3. Restore `icons.tar.gz` into the corresponding icon volume, retaining numeric UID/GID ownership. The API runs as UID 1000 and needs read/write access. Restore into a new/recovered volume when possible; do not combine unrelated backups.
4. Start a schema-compatible API/web release and verify health, public icon responses, catalog counts, manual page order and representative credits before reopening writes.

Migration 008 is additive. An older API can still read its previous columns, but cannot serve the new manual-icon route. Operational rollback therefore needs this version's icon-serving capability or a coordinated database/volume restore; merely starting an older image can leave manual icons unavailable. No live deployment or restore is performed by this PR.

## Validation

Unit tests decode PNG/WebP and check transparency, native dimensions, bad types, corrupt input, byte/dimension limits, inaccessible storage and persisted-file integrity across storage instances. PostgreSQL/API tests check auth/CSRF, required/duplicate/unknown pages, idempotent and same-name creation, stale/concurrent reorder, alias conflicts, missing/expired stages, audits and both modes' preserved credits. Import tests additionally verify manual provenance/order survives repeat bootstrap and changed source snapshots cannot overwrite it.

The Docker CI job uses real multipart HTTP uploads, creates and reorders a shared item, searches for it, recreates the API container and compares the icon bytes, then validates a coordinated backup containing that icon. The existing browser suite continues to exercise the admin creation/order interactions. API and PostgreSQL tests run in disposable schemas; the Docker fixture is explicitly gated to its disposable CI database.
