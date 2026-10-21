# Catalog and sources

The pinned baseline contains 1,717 canonical items across 124 source pages.
The Fractured Archive release adds 17 items and one raid page, for 1,734 items
and 125 pages on a fresh installation. Its pet also belongs to All Pets.
Items can occur on several pages without duplicating credit. Startup imports the
pinned snapshot once; it does not fetch live game data or overwrite staff edits.

[Provenance](../catalog/provenance.json) records captured TempleOSRS/Wiki sources,
revisions, hashes and coverage. [The identity registry](../catalog/identities.json)
keeps internal IDs stable; never regenerate existing IDs to match a reordered
source. [The asset manifest](../catalog/assets.json) records local icon sources,
hashes and dimensions. Browser fixtures use a separate small test catalog.

```bash
npm run build -w @clog/domain
npm run build -w @clog/database
npm run catalog:check
```

The builder runs offline and validates captured source hashes, coverage, aliases,
slot order and local assets. `npm run catalog:build` regenerates the snapshot;
review both the semantic diff and checksum before committing. Source retrieval
is an explicit maintenance action, not a normal build step.

The pinned source's clue pages are corrected once by bootstrap using
[clue-taxonomy.json](../catalog/clue-taxonomy.json). IDs, credits and non-clue
memberships stay intact. Catalog imports serialize with setup and fail on
conflicting identities rather than overwriting them.

Staff can add manual items/pages/sections and edit imported items. Origin and
overrides preserve the difference between source and staff choices. Reconciliation
requires an explicit reviewed mapping and reason; matching names alone cannot
merge identities. See [staff tools](staff-guide.md) and [asset attribution](assets.md).

## Release updates

New content ships through `catalog/updates/index.json`, an ordered list of immutable
batch IDs. Add `<batch-id>.json` beside the index and place each supplied still
WebP at `catalog/updates/assets/<sha256>.webp`. The first shipped batch is
[The Fractured Archive](../catalog/updates/2026-10-20-fractured-archive.json),
with [source and artwork provenance](../catalog/updates/2026-10-20-fractured-archive.provenance.json).
Runtime imports use these local, verified files without fetching live content.

A batch has `id`, `title`, `pages` and `items`. Each page supplies a stable `key`,
`name` and existing section `category`. Each item supplies a stable `key`, `name`,
distinct verified `gameItemIds`, `pageKeys`, and an `image` object with `sha256`,
`width` and `height`. Keys contain lowercase letters, digits, hyphens/underscores
and remain stable across later batches. Every referenced page needs a definition
in the same or an earlier batch. In-game variants share one item entry. Images
must be still WebP, at most 2 MiB and 512×512 pixels. Keep source/license provenance
with the content review; the manifest hash binds the exact shipped bytes.

Run `npm run catalog:updates:check` after compiling domain/database. It checks all
batch and legacy assets, dimensions, hashes, references and cumulative game-ID
ownership. Production image builds run this check. Never alter a published batch;
append a new batch to change supplied values. Include all preceding batches so
installations can skip releases. Fresh installations install all batches without
an upgrade prompt.

Startup validates and registers release metadata and image bytes under the catalog
writer lock. Existing installations receive proposals for missing pages/items;
they are created only after the administrator selects the corresponding groups
and saves. A persistent bootstrap marker distinguishes an existing installation
from a fresh install whose baseline/release setup was interrupted. Already-installed
content and collection history are never removed by this change.

Matching local game IDs and unique names prevent manual-entry duplicates. Names
alone suggest identity review; they never merge credit. Page discovery compares
verified item identities and displays matching/missing/extra membership as evidence.
An administrator can adopt one active candidate or explicitly create a separate
page. Adoption preserves local keys, ordering, memberships and schedule references;
WOM suggestions follow those saved mappings. Ambiguous or retired identities remain
blocked for explicit resolution.

The grouped reviewer keeps name, ID, membership and icon choices separate. The ID
group applies each listed addition/removal; it never steals another item's ID.
Unchecked groups remain pending. Earlier explicit keep decisions and exact request
receipts retain their original meaning. New item creation requires a selected
relationship to a resolved page; unchecked dependencies cause the save to fail
atomically with an explanation.

The original `catalog/assets.json` is pinned by `catalog/legacy-assets.sha256`.
Do not change the pin or replace/remove those images: publish new artwork through
updates instead. Startup retains selected legacy bytes in the database and uses
immutable hash URLs. New supplied bytes are also stored in the database. This
keeps retained images available after later upgrades and in normal database
backup/restore; uploaded custom assets retain their existing storage lifecycle.
Use new batches for new items/images rather than regenerating the legacy baseline.

The first administrator login or restored session opens a review only when fixes
remain. See [staff tools](staff-guide.md) for the grouped table, icons and Save/Cancel.
Restarting or rescanning can refresh discovery but cannot apply pending additions.
Exact save retries do not duplicate items, pages or reviewed corrections.
