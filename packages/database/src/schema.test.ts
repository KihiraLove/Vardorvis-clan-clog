/** Disposable-PostgreSQL integration check; absent TEST_DATABASE_URL explicitly skips it. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
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
          '004_runelite_submissions.sql',
          '005_clan_api_keys.sql',
          '006_clan_logos.sql',
          '007_site_customization.sql',
          '008_default_clan_name.sql',
          '009_runelite_world_types.sql',
          '010_hardcore_appearance.sql',
          '011_catalog_page_management.sql',
          '012_runelite_auto_review.sql',
          '013_collection_log_schedules.sql',
          '014_wom_competitions.sql',
          '015_review_notes.sql',
          '016_asset_maintenance.sql',
          '017_review_pagination.sql',
          '018_xp_history_pagination.sql',
          '019_lifecycle_archive.sql',
          '020_public_projections.sql',
          '021_retire_oauth_states.sql',
          '022_submission_duplicate_filters.sql',
          '023_runelite_chat_proof.sql',
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

test(
  'generic clan-name upgrade preserves administrator-chosen names, including an explicit return to Vardorvis',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const connectionString = process.env.TEST_DATABASE_URL!;
    const root = new pg.Pool({ connectionString });
    const directory = new URL('../migrations/', import.meta.url);
    const names = (await readdir(directory))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    try {
      for (const chosen of ['Explicit clan', 'Vardorvis']) {
        const schema = 'name_upgrade_' + randomUUID().replaceAll('-', '');
        await root.query('CREATE SCHEMA ' + schema);
        const pool = new pg.Pool({
          connectionString,
          options: '-c search_path=' + schema,
        });
        try {
          for (const name of names.filter((name) => name < '008_'))
            await pool.query(await readFile(new URL(name, directory), 'utf8'));
          await pool.query('UPDATE site_settings SET clan_name=$1,version=2', [
            chosen,
          ]);
          await pool.query(
            "INSERT INTO site_settings_audit(actor_discord_id,old_enabled,new_enabled,version,old_clan_name,new_clan_name) VALUES('owner',false,false,2,'Some previous name',$1)",
            [chosen],
          );
          await pool.query(
            await readFile(
              new URL('008_default_clan_name.sql', directory),
              'utf8',
            ),
          );
          assert.deepEqual(
            (await pool.query('SELECT clan_name,version FROM site_settings'))
              .rows,
            [{ clan_name: chosen, version: 2 }],
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::integer AS n FROM site_settings_audit',
              )
            ).rows[0].n,
            1,
          );
        } finally {
          await pool.end();
          await root.query('DROP SCHEMA ' + schema + ' CASCADE');
        }
      }
    } finally {
      await root.end();
    }
  },
);
