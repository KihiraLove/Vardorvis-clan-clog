/** One-time, forward-only correction of Temple clue grouping using pinned OSRS Wiki tabs. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { importBundledCatalog, readBundledSnapshot } from './catalog-import.js';
import { snapshotId, type CatalogSnapshot } from './catalog-model.js';

export interface ClueTaxonomy {
  wikiRevision: number;
  retiredPages: string[];
  rarePages: Record<string, { name: string; gameItemIds: number[] }>;
  regularMoves: Record<
    string,
    { removeGameItemIds: number[]; addGameItemIds: number[] }
  >;
}

const order = [
  'beginner_treasure_trails',
  'easy_treasure_trails',
  'medium_treasure_trails',
  'hard_treasure_trails',
  'hard_treasure_trails_rare',
  'elite_treasure_trails',
  'elite_treasure_trails_rare',
  'master_treasure_trails',
  'master_treasure_trails_rare',
  'shared_treasure_trail_rewards',
  'scroll_cases',
];
const rareIds = [
  'hard_treasure_trails_rare',
  'elite_treasure_trails_rare',
  'master_treasure_trails_rare',
];
const legacyIds = ['gilded', 'third_age', 'mimic'];

export async function readClueTaxonomy(): Promise<ClueTaxonomy> {
  const patch = JSON.parse(
    await readFile(new URL('../../../catalog/clue-taxonomy.json', import.meta.url), 'utf8'),
  ) as ClueTaxonomy;
  assert.equal(patch.wikiRevision, 15347607);
  assert.deepEqual(patch.retiredPages, legacyIds);
  assert.deepEqual(Object.keys(patch.rarePages), rareIds);
  assert.deepEqual(Object.keys(patch.regularMoves), [
    'elite_treasure_trails',
    'master_treasure_trails',
  ]);
  for (const [id, page] of Object.entries(patch.rarePages)) {
    assert.equal(page.name, id.replaceAll('_', ' ').replace(/\b[a-z]/gu, (s) => s.toUpperCase()).replace('Rare', '(Rare)'));
    assert.ok(page.gameItemIds.length > 0);
    assert.equal(new Set(page.gameItemIds).size, page.gameItemIds.length);
  }
  return patch;
}

/**
 * Do not change the immutable import snapshot or reallocate item IDs. Instead
 * update only page memberships and names after first import. A durable marker
 * prevents replay on subsequent boots, preserving any later admin ordering.
 */
export async function applyClueTaxonomy(
  client: Pick<pg.Client, 'query'>,
  snapshot: CatalogSnapshot,
  patch: ClueTaxonomy,
): Promise<'updated' | 'unchanged'> {
  const aliasToId = new Map(
    snapshot.items.flatMap((item) =>
      item.gameItemIds.map((gameId) => [gameId, item.id] as const),
    ),
  );
  const canonical = (gameId: number): number => {
    const id = aliasToId.get(gameId);
    if (!id) throw new Error('Unknown clue catalog game ID: ' + gameId);
    return id;
  };
  const involved = new Set<number>();
  for (const page of Object.values(patch.rarePages))
    page.gameItemIds.forEach((gameId) => involved.add(gameId));
  for (const move of Object.values(patch.regularMoves))
    [...move.removeGameItemIds, ...move.addGameItemIds].forEach((gameId) =>
      involved.add(gameId),
    );
  for (const gameId of involved) canonical(gameId);

  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(74261005)');
    const already = await client.query(
      'SELECT 1 FROM catalog_taxonomy_updates WHERE name=$1',
      ['clue-rare-15347607'],
    );
    if (already.rowCount) {
      await client.query('COMMIT');
      return 'unchanged';
    }
    const imported = await client.query<{ id: string }>(
      'SELECT id FROM catalog_versions WHERE source_url=$1',
      [snapshot.source.url],
    );
    if (
      imported.rows.length !== 1 ||
      imported.rows[0]!.id !== snapshotId(snapshot)
    )
      throw new Error('Clue correction requires the original pinned catalog import.');

    // Verify that no legacy page has been manually edited or contains manual items.
    // Never erase user-curated memberships or reorder history automatically.
    const sourcePages = new Map(snapshot.pages.map((page) => [page.id, page]));
    const expected = [...legacyIds, ...order.filter((id) => !rareIds.includes(id))];
    const pages = await client.query<{
      id: string;
      category: string;
      name: string;
      order_origin: string;
    }>(
      'SELECT id,category,name,order_origin FROM pages WHERE id=ANY($1::text[])',
      [expected],
    );
    if (
      pages.rows.length !== expected.length ||
      (await client.query('SELECT id FROM pages WHERE id=ANY($1::text[])', [rareIds]))
        .rowCount
    )
      throw new Error('Clue pages already differ; inspect the existing catalog before applying correction.');
    for (const pageId of legacyIds) {
      const saved = pages.rows.find((row) => row.id === pageId);
      const baseline = sourcePages.get(pageId);
      if (
        !baseline ||
        saved?.category !== 'clues' ||
        saved.name !== baseline.name ||
        saved.order_origin !== 'source'
      )
        throw new Error('Legacy clue page was modified: ' + pageId);
      const slots = await client.query<{ item_id: number; origin: string }>(
        'SELECT item_id,origin FROM page_items WHERE page_id=$1 ORDER BY slot',
        [pageId],
      );
      if (
        slots.rows.some((row) => row.origin !== 'source') ||
        JSON.stringify(slots.rows.map((row) => row.item_id)) !==
          JSON.stringify(baseline.itemIds)
      )
        throw new Error('Manual item/order on legacy clue page ' + pageId + '; migrate it manually before retiring the page.');
    }
    if (
      (await client.query(
        'SELECT id FROM catalog_audit WHERE page_id=ANY($1::text[]) LIMIT 1',
        [legacyIds],
      )).rowCount
    )
      throw new Error('Legacy clue pages have audit history; review before replacing them.');

    // Ensure the saved external aliases still point to the canonical identities.
    const mapped = await client.query<{ game_item_id: number; item_id: number }>(
      'SELECT game_item_id,item_id FROM game_item_ids WHERE game_item_id=ANY($1::integer[])',
      [[...involved]],
    );
    if (
      mapped.rows.length !== involved.size ||
      mapped.rows.some((row) => canonical(row.game_item_id) !== row.item_id)
    )
      throw new Error('Clue item alias mappings changed; no taxonomy changes applied.');

    // Remove four misplaced regular rewards, retaining relative order and all
    // manually added items on those pages. Add the same canonical ring to both.
    for (const [pageId, move] of Object.entries(patch.regularMoves)) {
      const rows = await client.query<{ item_id: number; origin: string }>(
        'SELECT item_id,origin FROM page_items WHERE page_id=$1 ORDER BY slot',
        [pageId],
      );
      const removed = move.removeGameItemIds.map(canonical);
      const added = move.addGameItemIds.map(canonical);
      if (
        removed.some((id) => !rows.rows.some((row) => row.item_id === id)) ||
        added.some((id) => rows.rows.some((row) => row.item_id === id))
      )
        throw new Error('Regular clue page differs from the source: ' + pageId);
      const updated = [
        ...rows.rows.filter((row) => !removed.includes(row.item_id)),
        ...added.map((item_id) => ({ item_id, origin: 'source' })),
      ];
      await client.query('DELETE FROM page_items WHERE page_id=$1', [pageId]);
      await client.query(
        'INSERT INTO page_items(page_id,item_id,slot,origin) SELECT $1,item_id,slot,origin FROM jsonb_to_recordset($2::jsonb) AS x(item_id integer,slot integer,origin text)',
        [
          pageId,
          JSON.stringify(updated.map((row, slot) => ({ ...row, slot }))),
        ],
      );
    }

    // Retire only the obsolete source pages; no items or approved credits are deleted.
    await client.query(
      'DELETE FROM page_items WHERE page_id=ANY($1::text[])',
      [legacyIds],
    );
    await client.query('DELETE FROM pages WHERE id=ANY($1::text[])', [legacyIds]);
    for (const [pageId, page] of Object.entries(patch.rarePages)) {
      await client.query(
        'INSERT INTO pages(id,category,name,sort_order) VALUES($1,$2,$3,$4)',
        [pageId, 'clues', page.name, order.indexOf(pageId)],
      );
      await client.query(
        'INSERT INTO page_items(page_id,item_id,slot,origin) SELECT $1,item_id,slot,$3 FROM jsonb_to_recordset($2::jsonb) AS x(item_id integer,slot integer)',
        [
          pageId,
          JSON.stringify(page.gameItemIds.map((gameId, slot) => ({
            item_id: canonical(gameId),
            slot,
          }))),
          'source',
        ],
      );
    }
    for (const [sortOrder, pageId] of order.entries())
      await client.query(
        'UPDATE pages SET sort_order=$2 WHERE id=$1 AND sort_order<>$2',
        [pageId, sortOrder],
      );

    await client.query(
      'INSERT INTO catalog_audit(actor_discord_id,action,before_value,after_value,reason) VALUES($1,$2,$3,$4,$5)',
      [
        'system/clue-taxonomy',
        'taxonomy',
        JSON.stringify({ retiredPages: legacyIds }),
        JSON.stringify({
          wikiRevision: patch.wikiRevision,
          newPages: Object.fromEntries(
            Object.entries(patch.rarePages).map(([id, page]) => [id, page.gameItemIds.length]),
          ),
          regularMoves: patch.regularMoves,
        }),
        'Correct Treasure Trails (Rare) membership from pinned OSRS Wiki collection log',
      ],
    );
    await client.query(
      'INSERT INTO catalog_taxonomy_updates(name) VALUES($1)',
      ['clue-rare-15347607'],
    );
    await client.query('COMMIT');
    return 'updated';
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function applyBundledClueTaxonomy(
  databaseUrl: string,
): Promise<'updated' | 'unchanged'> {
  const snapshot = await readBundledSnapshot();
  const patch = await readClueTaxonomy();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await applyClueTaxonomy(client, snapshot, patch);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  console.log('Clue taxonomy ' + (await applyBundledClueTaxonomy(process.env.DATABASE_URL)));
}
