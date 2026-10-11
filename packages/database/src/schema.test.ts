/** Disposable-PostgreSQL integration check; absent TEST_DATABASE_URL explicitly skips it. */
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
    // Reapplying the same checksummed migration must leave the schema usable.
    await migrate(url);
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const migrationRows = await client.query<{ name: string }>(
        'SELECT name FROM schema_migrations ORDER BY name',
      );
      assert.deepEqual(
        migrationRows.rows.map((row) => row.name),
        [
          '001_baseline.sql',
          '002_manual_submission_requests.sql',
          '003_staff_accounts.sql',
        ],
      );
      // Roll back fixtures; migrations persist in the disposable test database.
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
      assert.equal(
        (await client.query('SELECT hardcore_enabled FROM site_settings'))
          .rows[0].hardcore_enabled,
        false,
      );
      // The same canonical item may be approved independently on hardcore worlds.
      await client.query(
        "INSERT INTO submissions (id, discord_interaction_id, discord_user_id, discord_guild_id, raw_item_text, item_id, collector_name, collected_on, date_source, proof_url, hardcore, status, reviewed_by, reviewed_at) SELECT '00000000-0000-4000-8000-000000000002', 'fixture-hc', discord_user_id, discord_guild_id, raw_item_text, item_id, collector_name, collected_on, date_source, proof_url, true, 'approved', '3', now() FROM submissions WHERE discord_interaction_id = 'fixture'",
      );
      // Savepoints allow inspection after PostgreSQL rejects a duplicate approval.
      await client.query('SAVEPOINT duplicate_credit');
      await assert.rejects(
        client.query(
          "INSERT INTO submissions (id, discord_interaction_id, discord_user_id, discord_guild_id, raw_item_text, item_id, collector_name, collected_on, date_source, proof_url, status, reviewed_by, reviewed_at) SELECT '00000000-0000-4000-8000-000000000003', 'fixture-duplicate', discord_user_id, discord_guild_id, raw_item_text, item_id, collector_name, collected_on, date_source, proof_url, 'approved', '3', now() FROM submissions WHERE discord_interaction_id = 'fixture'",
        ),
        { code: '23505' },
      );
      await client.query('ROLLBACK TO SAVEPOINT duplicate_credit');
      await client.query(
        "UPDATE submissions SET status = 'revoked', review_reason = 'Incorrect evidence' WHERE discord_interaction_id = 'fixture'",
      );
      assert.deepEqual(await read(), [false, false]);
      assert.deepEqual(
        (
          await client.query(
            'SELECT collected, hardcore_collected FROM item_collection_state WHERE item_id = 900001',
          )
        ).rows,
        [{ collected: false, hardcore_collected: true }],
      );
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  },
);
