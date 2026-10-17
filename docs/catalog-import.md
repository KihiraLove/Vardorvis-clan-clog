# Catalog and sources

The bundled catalog contains 1,717 canonical items across 124 source pages.
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
