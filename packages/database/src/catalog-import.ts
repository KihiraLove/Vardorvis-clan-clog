import { databaseUrl as readDatabaseUrl } from './secrets.js';
/** Atomic, insert-only bootstrap. Refreshes and admin overrides are separate workflows. */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import {
  freezeBundledImages,
  installSnapshotRefresh,
  prepareCatalogRelease,
} from './catalog-update-install.js';
import { installCatalogUpdate } from './catalog-update-store.js';
import {
  snapshotId,
  validateSnapshot,
  type CatalogSnapshot,
} from './catalog-model.js';

export async function readBundledSnapshot(): Promise<CatalogSnapshot> {
  const value: unknown = JSON.parse(
    await readFile(
      new URL('../../../catalog/snapshot.json', import.meta.url),
      'utf8',
    ),
  );
  validateSnapshot(value);
  const expected = (
    await readFile(
      new URL('../../../catalog/snapshot.sha256', import.meta.url),
      'utf8',
    )
  ).trim();
  if (snapshotId(value) !== expected)
    throw new Error('Bundled catalog checksum mismatch');
  return value;
}

/** Caller supplies an idle connected client; this function owns its transaction. */
export async function importCatalog(
  client: Pick<pg.Client, 'query'>,
  snapshot: CatalogSnapshot,
): Promise<'imported' | 'unchanged'> {
  const id = snapshotId(snapshot);
  await client.query('BEGIN');
  try {
    // Share the migration lock so two first boots cannot import at the same time.
    await client.query('SELECT pg_advisory_xact_lock(74261005)');
    const prior = await client.query<{ id: string }>(
      'SELECT id FROM catalog_versions WHERE source_url = $1',
      [snapshot.source.url],
    );
    if (prior.rows.length) {
      if (!prior.rows.some((row) => row.id === id))
        throw new Error(
          'A different catalog is already imported; use a reviewed refresh workflow',
        );
      // A rerun never resets later admin edits, manual items, page placement or credits.
      await client.query('COMMIT');
      return 'unchanged';
    }
    // Plain INSERT intentionally fails on conflicting IDs or pages. No existing rows
    // are overwritten, and any conflict rolls back the entire attempted import.
    await client.query(
      `INSERT INTO items(id, name, icon_path)
      SELECT id, name, icon_path FROM jsonb_to_recordset($1::jsonb) AS x(id integer, name text, icon_path text)`,
      [
        JSON.stringify(
          snapshot.items.map((item) => ({
            id: item.id,
            name: item.name,
            icon_path: item.iconPath,
          })),
        ),
      ],
    );
    await client.query(
      `INSERT INTO game_item_ids(game_item_id, item_id)
      SELECT game_item_id, item_id FROM jsonb_to_recordset($1::jsonb) AS x(game_item_id integer, item_id integer)`,
      [
        JSON.stringify(
          snapshot.items.flatMap((item) =>
            item.gameItemIds.map((gameItemId) => ({
              game_item_id: gameItemId,
              item_id: item.id,
            })),
          ),
        ),
      ],
    );
    await client.query(
      `INSERT INTO pages(id, category, name, sort_order)
      SELECT id, category, name, sort_order FROM jsonb_to_recordset($1::jsonb) AS x(id text, category text, name text, sort_order integer)`,
      [
        JSON.stringify(
          snapshot.pages.map((page) => ({
            id: page.id,
            category: page.category,
            name: page.name,
            sort_order: page.sortOrder,
          })),
        ),
      ],
    );
    await client.query(
      `INSERT INTO page_items(page_id, item_id, slot)
      SELECT page_id, item_id, slot FROM jsonb_to_recordset($1::jsonb) AS x(page_id text, item_id integer, slot integer)`,
      [
        JSON.stringify(
          snapshot.pages.flatMap((page) =>
            page.itemIds.map((itemId, slot) => ({
              page_id: page.id,
              item_id: itemId,
              slot,
            })),
          ),
        ),
      ],
    );
    await client.query(
      'INSERT INTO catalog_versions(id, source_url, source_revision) VALUES($1, $2, $3)',
      [id, snapshot.source.url, snapshot.source.revision],
    );
    // No submissions, audit events or per-world collection state are synthesized.
    await client.query('COMMIT');
    return 'imported';
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function importBundledCatalog(
  databaseUrl: string,
): Promise<'imported' | 'unchanged' | 'updated'> {
  const snapshot = await readBundledSnapshot();
  const release = await prepareCatalogRelease(snapshot);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const prior = (
      await client.query(
        'SELECT id FROM catalog_versions WHERE source_url=$1',
        [snapshot.source.url],
      )
    ).rows;
    const hash = snapshotId(snapshot);
    let result: 'imported' | 'unchanged' | 'updated';
    if (prior.length && !prior.some((r) => r.id === hash)) {
      await installSnapshotRefresh(client, snapshot, release.images, hash);
      await client.query(
        'INSERT INTO catalog_versions(id,source_url,source_revision) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',
        [hash, snapshot.source.url, snapshot.source.revision],
      );
      result = 'updated';
    } else result = await importCatalog(client, snapshot);
    await freezeBundledImages(client, release.images);
    for (const batch of release.updates.batches)
      if (
        (await installCatalogUpdate(
          client,
          batch,
          release.updates.images,
          prior.length === 0,
        )) === 'installed' &&
        result === 'unchanged'
      )
        result = 'updated';
    return result;
  } finally {
    await client.end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (!readDatabaseUrl()) throw new Error('DATABASE_URL is required');
  console.log('Catalog ' + (await importBundledCatalog(readDatabaseUrl())));
}
