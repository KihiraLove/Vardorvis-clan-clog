/** Real PostgreSQL import tests; mandatory in CI, explicitly skipped without a test DB. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { importCatalog, readBundledSnapshot } from './catalog-import.js';
import { applyClueTaxonomy, readClueTaxonomy } from './clue-taxonomy.js';

test(
  'concurrent full imports are atomic, uncollected and preserve later credits/manual edits',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const connectionString = process.env.TEST_DATABASE_URL!;
    const schema = 'catalog_test_' + randomUUID().replaceAll('-', '');
    const root = new pg.Client({ connectionString });
    await root.connect();
    await root.query('CREATE SCHEMA ' + schema);
    const clients = Array.from(
      { length: 2 },
      () =>
        new pg.Client({
          connectionString,
          options: '-c search_path=' + schema,
        }),
    );
    try {
      await Promise.all(clients.map((client) => client.connect()));
      const client = clients[0]!;
      const directory = new URL('../migrations/', import.meta.url);
      for (const file of (await readdir(directory))
        .filter((name) => /^\d+_.+\.sql$/u.test(name))
        .sort())
        await client.query(await readFile(new URL(file, directory), 'utf8'));
      const snapshot = await readBundledSnapshot();
      // A late alias conflict must also undo the already-inserted canonical items.
      await client.query(
        "INSERT INTO items(id, name, origin, overrides) VALUES(42, 'Manual item', 'manual', ARRAY['name','icon','pages'])",
      );
      await client.query(
        'INSERT INTO game_item_ids(game_item_id, item_id) VALUES($1,42)',
        [snapshot.items[0]!.gameItemIds[0]],
      );
      await assert.rejects(importCatalog(client, snapshot), { code: '23505' });
      assert.equal(
        (await client.query('SELECT count(*)::int AS n FROM items')).rows[0].n,
        1,
      );
      assert.equal(
        (await client.query('SELECT count(*)::int AS n FROM catalog_versions'))
          .rows[0].n,
        0,
      );
      await client.query('DELETE FROM game_item_ids WHERE item_id=42');
      const results = await Promise.all(
        clients.map((connection) => importCatalog(connection, snapshot)),
      );
      assert.deepEqual(results.sort(), ['imported', 'unchanged']);
      assert.equal(
        (await client.query('SELECT count(*)::int AS n FROM items')).rows[0].n,
        1718,
      );
      assert.equal(
        (await client.query('SELECT count(*)::int AS n FROM pages')).rows[0].n,
        124,
      );
      assert.equal(
        (await client.query('SELECT count(*)::int AS n FROM page_items'))
          .rows[0].n,
        1864,
      );
      assert.equal(
        (await client.query('SELECT count(*)::int AS n FROM game_item_ids'))
          .rows[0].n,
        1717,
      );
      assert.equal(
        (await client.query('SELECT count(*)::int AS n FROM submissions'))
          .rows[0].n,
        0,
      );
      assert.equal(
        (
          await client.query(
            'SELECT count(*)::int AS n FROM item_collection_state WHERE collected OR hardcore_collected',
          )
        ).rows[0].n,
        0,
      );
      for (const page of snapshot.pages)
        assert.deepEqual(
          (
            await client.query<{ item_id: number }>(
              'SELECT item_id FROM page_items WHERE page_id=$1 ORDER BY slot',
              [page.id],
            )
          ).rows.map((row) => row.item_id),
          page.itemIds,
        );
      const shared = snapshot.items.find((item) =>
        item.gameItemIds.includes(26241),
      )!;
      await client.query(
        `INSERT INTO submissions(id, discord_interaction_id, discord_user_id, discord_guild_id, raw_item_text, item_id, collector_name, collected_on, date_source, proof_url, status, reviewed_by, reviewed_at)
      VALUES($1, 'catalog-fixture', '1', '2', 'Virtus mask', $2, 'Fixture', '2026-10-08', 'admin', 'https://imgur.com/fixture', 'approved', '3', now())`,
        [randomUUID(), shared.id],
      );
      await client.query(
        "UPDATE items SET name='Manual correction' WHERE id=$1",
        [shared.id],
      );
      await client.query(
        "INSERT INTO page_items(page_id,item_id,slot,origin) VALUES('abyssal_sire',42,9,'manual')",
      );
      await client.query(
        "UPDATE page_items SET slot=slot+100000 WHERE page_id='abyssal_sire'",
      );
      await client.query(
        "UPDATE page_items SET slot=100009-slot WHERE page_id='abyssal_sire'",
      );
      await client.query(
        "UPDATE pages SET order_origin='manual' WHERE id='abyssal_sire'",
      );
      const savedSlots = (
        await client.query(
          "SELECT item_id,slot,origin FROM page_items WHERE page_id='abyssal_sire' ORDER BY slot",
        )
      ).rows;
      assert.equal(await importCatalog(client, snapshot), 'unchanged');
      assert.deepEqual(
        (
          await client.query(
            "SELECT item_id,slot,origin FROM page_items WHERE page_id='abyssal_sire' ORDER BY slot",
          )
        ).rows,
        savedSlots,
      );
      assert.equal(
        (
          await client.query(
            "SELECT order_origin FROM pages WHERE id='abyssal_sire'",
          )
        ).rows[0].order_origin,
        'manual',
      );
      assert.equal(
        (await client.query('SELECT origin FROM items WHERE id=42')).rows[0]
          .origin,
        'manual',
      );
      assert.equal(
        (await client.query('SELECT count(*)::int AS n FROM catalog_versions'))
          .rows[0].n,
        1,
      );
      assert.equal(
        (await client.query('SELECT name FROM items WHERE id=$1', [shared.id]))
          .rows[0].name,
        'Manual correction',
      );
      assert.equal(
        (await client.query('SELECT count(*)::int AS n FROM submissions'))
          .rows[0].n,
        1,
      );
      const states = await client.query(
        'SELECT s.collected, s.hardcore_collected FROM page_items p JOIN item_collection_state s ON s.item_id=p.item_id WHERE p.item_id=$1',
        [shared.id],
      );
      assert.ok(states.rows.length >= 4);
      assert.ok(
        states.rows.every(
          (row) => row.collected === true && row.hardcore_collected === false,
        ),
      );
      assert.equal(
        (
          await client.query(
            'SELECT count(*)::int AS n FROM game_item_ids WHERE item_id=42',
          )
        ).rows[0].n,
        0,
        'Manual items need no external alias',
      );
      const changed = structuredClone(snapshot);
      changed.items[0]!.name += ' changed';
      await assert.rejects(importCatalog(client, changed), /reviewed refresh/u);
      // The separate correction runs after the immutable first import; a manually
      // modified obsolete page must block the entire correction transaction.
      const patch = await readClueTaxonomy();
      await client.query(
        "INSERT INTO page_items(page_id,item_id,slot,origin) VALUES('gilded',42,20,'manual')",
      );
      await assert.rejects(
        applyClueTaxonomy(client, snapshot, patch),
        /Manual item\/order on legacy clue page/,
      );
      assert.equal(
        (await client.query('SELECT count(*)::int AS n FROM catalog_taxonomy_updates')).rows[0].n,
        0,
      );
      await client.query("DELETE FROM page_items WHERE page_id='gilded' AND item_id=42");

      const creditedBefore = (await client.query(
        "SELECT item_id,hardcore,collector_name FROM submissions WHERE status='approved'",
      )).rows;
      const originalNames = (await client.query(
        "SELECT id,name FROM items ORDER BY id",
      )).rows;
      const legacyBefore = (await client.query(
        "SELECT count(*)::int AS n FROM pages WHERE id=ANY($1::text[])",
        [patch.retiredPages],
      )).rows[0].n;
      assert.equal(legacyBefore, 3);
      assert.equal(await applyClueTaxonomy(client, snapshot, patch), 'updated');
      assert.equal(await applyClueTaxonomy(client, snapshot, patch), 'unchanged');
      assert.equal(
        (await client.query('SELECT count(*)::int AS n FROM pages')).rows[0].n,
        124,
      );
      assert.equal(
        (await client.query('SELECT count(*)::int AS n FROM page_items')).rows[0].n,
        1926,
      );
      assert.equal(
        (await client.query('SELECT count(*)::int AS n FROM pages WHERE id=ANY($1::text[])', [patch.retiredPages])).rows[0].n,
        0,
      );
      assert.deepEqual((await client.query('SELECT id,name FROM items ORDER BY id')).rows, originalNames);
      assert.deepEqual(
        (await client.query("SELECT item_id,hardcore,collector_name FROM submissions WHERE status='approved'")).rows,
        creditedBefore,
      );
      const aliases = new Map(
        snapshot.items.flatMap((item) => item.gameItemIds.map((gameId) => [gameId, item.id] as const)),
      );
      for (const [pageId, rarePage] of Object.entries(patch.rarePages)) {
        assert.deepEqual(
          (await client.query<{ item_id: number }>('SELECT item_id FROM page_items WHERE page_id=$1 ORDER BY slot', [pageId]))
            .rows.map((row) => row.item_id),
          rarePage.gameItemIds.map((id) => aliases.get(id)),
        );
      }
      const ringId = aliases.get(23185)!;
      assert.deepEqual(
        (await client.query<{ page_id: string }>(
          'SELECT page_id FROM page_items WHERE item_id=$1 ORDER BY page_id',
          [ringId],
        )).rows.map((row) => row.page_id),
        ['elite_treasure_trails', 'master_treasure_trails'],
      );
      assert.equal(
        (await client.query("SELECT count(*)::int AS n FROM catalog_audit WHERE action='taxonomy'")).rows[0].n,
        1,
      );
      // A later administrator reorder is never reverted by a repeat bootstrap.
      await client.query(
        "UPDATE pages SET order_origin='manual' WHERE id='master_treasure_trails_rare'",
      );
      assert.equal(await applyClueTaxonomy(client, snapshot, patch), 'unchanged');
      assert.equal(
        (await client.query("SELECT order_origin FROM pages WHERE id='master_treasure_trails_rare'")).rows[0].order_origin,
        'manual',
      );
    } finally {
      await Promise.all(clients.map((client) => client.end()));
      await root.query('DROP SCHEMA ' + schema + ' CASCADE');
      await root.end();
    }
  },
);
