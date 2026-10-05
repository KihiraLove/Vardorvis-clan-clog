import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { migrate } from './migrate.js';

test(
  'fresh migrations, repeated migrations and shared-page collection projection',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const url = process.env.TEST_DATABASE_URL!;
    await migrate(url);
    await migrate(url);
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "INSERT INTO items (id, name) VALUES (900001, 'Fixture item')",
      );
      await client.query(
        "INSERT INTO pages (id, category, name, sort_order) VALUES ('fixture-a', 'Test', 'A', 0), ('fixture-b', 'Test', 'B', 1)",
      );
      await client.query(
        "INSERT INTO page_items (page_id, item_id, slot) VALUES ('fixture-a', 900001, 0), ('fixture-b', 900001, 0)",
      );
      const read = async () =>
        (
          await client.query<{ collected: boolean }>(
            'SELECT s.collected FROM page_items p JOIN item_collection_state s ON s.item_id = p.item_id WHERE p.item_id = 900001',
          )
        ).rows.map((row) => row.collected);
      assert.deepEqual(await read(), [false, false]);
      await client.query(
        "INSERT INTO submissions (id, discord_interaction_id, discord_user_id, discord_guild_id, raw_item_text, item_id, collector_name, collected_on, date_source, proof_url) VALUES ('00000000-0000-4000-8000-000000000001', 'fixture', '1', '2', 'Fixture item', 900001, 'KihiraVD', '2026-10-16', 'admin', 'https://imgur.com/fixture')",
      );
      assert.deepEqual(await read(), [false, false]);
      await client.query(
        "UPDATE submissions SET status = 'approved', reviewed_at = now(), reviewed_by = '3' WHERE discord_interaction_id = 'fixture'",
      );
      assert.deepEqual(await read(), [true, true]);
      await client.query(
        "UPDATE submissions SET status = 'revoked', review_reason = 'Incorrect evidence' WHERE discord_interaction_id = 'fixture'",
      );
      assert.deepEqual(await read(), [false, false]);
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  },
);
