/** Real PostgreSQL import tests; mandatory in CI, explicitly skipped without a test DB. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { importCatalog, readBundledSnapshot } from './catalog-import.js';

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
        "INSERT INTO items(id, name) VALUES(42, 'Manual item')",
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
      assert.equal(await importCatalog(client, snapshot), 'unchanged');
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
    } finally {
      await Promise.all(clients.map((client) => client.end()));
      await root.query('DROP SCHEMA ' + schema + ' CASCADE');
      await root.end();
    }
  },
);
