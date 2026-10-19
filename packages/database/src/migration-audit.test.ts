/** Exercise the migration runner itself, using an isolated disposable schema. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { migrate, validateMigrationHistory } from './migrate.js';

async function withSchema(
  run: (url: string, client: pg.Client) => Promise<void>,
) {
  const connectionString = process.env.TEST_DATABASE_URL!;
  const schema = 'migration_audit_' + randomUUID().replaceAll('-', '');
  const root = new pg.Client({ connectionString });
  await root.connect();
  const url = new URL(connectionString);
  url.searchParams.set('options', '-c search_path=' + schema);
  const client = new pg.Client({ connectionString: url.toString() });
  try {
    await root.query('CREATE SCHEMA ' + schema);
    await client.connect();
    await run(url.toString(), client);
  } finally {
    await client.end();
    await root.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await root.end();
  }
}

test(
  'concurrent migrators serialize a fresh schema without duplicate ledger entries',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    await withSchema(async (url, client) => {
      await Promise.all([migrate(url), migrate(url)]);
      const rows = (await client.query('SELECT name FROM schema_migrations'))
        .rows;
      assert.equal(rows.length, 6);
      assert.equal(
        new Set(rows.map((row: { name: string }) => row.name)).size,
        6,
      );
      assert.equal(
        (await client.query('SELECT count(*)::int AS count FROM xp_state'))
          .rows[0].count,
        1,
      );
    });
  },
);

test(
  'a changed migration checksum rejects startup without changing the ledger',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    await withSchema(async (url, client) => {
      await migrate(url);
      await client.query(
        "UPDATE schema_migrations SET checksum=$1 WHERE name='001_baseline.sql'",
        ['0'.repeat(64)],
      );
      const before = (
        await client.query('SELECT * FROM schema_migrations ORDER BY name')
      ).rows;
      await assert.rejects(
        migrate(url),
        /Applied migration changed: 001_baseline.sql/u,
      );
      assert.deepEqual(
        (await client.query('SELECT * FROM schema_migrations ORDER BY name'))
          .rows,
        before,
      );
    });
  },
);

test(
  'a failed fresh migration rolls back both partial schema and its ledger',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    await withSchema(async (url, client) => {
      await client.query('CREATE TABLE items (fixture integer)');
      await assert.rejects(migrate(url), { code: '42P07' });
      const tables = (
        await client.query(
          'SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename',
        )
      ).rows;
      assert.deepEqual(tables, [{ tablename: 'items' }]);
    });
  },
);

test(
  'an image rejects unknown future ledger entries before mutating the schema',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    await withSchema(async (url, client) => {
      await migrate(url);
      await client.query(
        'INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',
        ['999_future.sql', 'f'.repeat(64)],
      );
      const ledger = (
        await client.query('SELECT * FROM schema_migrations ORDER BY name')
      ).rows;
      await assert.rejects(
        migrate(url),
        /Unknown applied migration: 999_future.sql/u,
      );
      assert.deepEqual(
        (await client.query('SELECT * FROM schema_migrations ORDER BY name'))
          .rows,
        ledger,
      );
    });
  },
);

test(
  'a missing baseline ledger entry cannot reinitialize a populated database',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    await withSchema(async (url, client) => {
      await migrate(url);
      await client.query('DELETE FROM schema_migrations');
      await assert.rejects(migrate(url), { code: '42723' });
      assert.equal(
        (await client.query('SELECT count(*)::int AS n FROM schema_migrations'))
          .rows[0].n,
        0,
      );
      assert.equal(
        (await client.query('SELECT count(*)::int AS n FROM catalog_sections'))
          .rows[0].n,
        5,
      );
    });
  },
);

test('manifest compatibility approves unchanged histories and upgrading a prefix but never downgrades unknown schema', () => {
  const entries = Array.from({ length: 14 }, (_, i) => ({
    name: String(i + 1).padStart(3, '0') + '_reviewed.sql',
    checksum: String(i + 1).padStart(64, '0'),
  }));
  assert.doesNotThrow(() => validateMigrationHistory(entries, []));
  assert.doesNotThrow(() =>
    validateMigrationHistory(entries, entries.slice(0, 13)),
  );
  assert.doesNotThrow(() =>
    validateMigrationHistory(entries.slice(0, 13), entries.slice(0, 13)),
  );
  assert.throws(
    () => validateMigrationHistory(entries.slice(0, 13), entries),
    /Unknown applied migration: 014_reviewed.sql/u,
  );
  assert.throws(
    () => validateMigrationHistory(entries, [entries[1]!]),
    /Non-prefix migration history/u,
  );
  assert.throws(
    () => validateMigrationHistory(entries, [entries[0]!, entries[2]!]),
    /Non-prefix migration history/u,
  );
  assert.throws(
    () =>
      validateMigrationHistory(entries, [
        { ...entries[0]!, checksum: 'f'.repeat(64) },
      ]),
    /Applied migration changed/u,
  );
  assert.throws(
    () =>
      validateMigrationHistory(
        entries.filter((_, i) => i !== 1),
        [],
      ),
    /Invalid ordered bundled migration manifest/u,
  );
  assert.throws(
    () =>
      validateMigrationHistory([{ ...entries[0]!, name: 'not_sql.txt' }], []),
    /Invalid ordered bundled migration manifest/u,
  );
  const stamped = entries
    .slice(0, 2)
    .map((entry, i) => ({ ...entry, applied_at: new Date(2000 - i * 1000) }));
  assert.throws(
    () => validateMigrationHistory(entries, stamped),
    /Reordered migration history/u,
  );
  assert.doesNotThrow(() =>
    validateMigrationHistory(
      entries,
      stamped.map((entry) => ({ ...entry, applied_at: new Date(1000) })),
    ),
  );
});

test(
  'fresh setup seeds generic defaults without historical audits or retired authentication',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    await withSchema(async (url, client) => {
      await migrate(url);
      const settings = (await client.query('SELECT * FROM site_settings'))
        .rows[0];
      assert.equal(settings.clan_name, 'Clan name');
      assert.equal(settings.hardcore_name, 'Clan name');
      assert.equal(settings.hardcore_enabled, false);
      assert.equal(settings.version, 2);
      assert.deepEqual(settings.public_copy, settings.hardcore_copy);
      assert.equal(settings.public_copy.xpTotalCaption, undefined);
      assert.equal(
        (await client.query('SELECT rules FROM runelite_settings')).rows[0]
          .rules.clanName,
        'Clan name',
      );
      assert.deepEqual(
        (
          await client.query(
            'SELECT name FROM catalog_sections ORDER BY sort_order',
          )
        ).rows.map((row) => row.name),
        ['Bosses', 'Raids', 'Clues', 'Minigames', 'Other'],
      );
      assert.ok(
        (await client.query('SELECT version FROM projection_state')).rows.every(
          (row) => row.version === '1',
        ),
      );
      for (const table of [
        'staff_accounts',
        'admin_sessions',
        'site_settings_audit',
        'clan_api_keys',
        'submissions',
        'wom_competitions',
      ])
        assert.equal(
          (await client.query('SELECT count(*)::int AS n FROM ' + table))
            .rows[0].n,
          0,
          table,
        );
      assert.equal(
        (
          await client.query(
            "SELECT to_regclass(current_schema() || '.oauth_states') AS retired",
          )
        ).rows[0].retired,
        null,
      );
      const before = (await client.query('SELECT * FROM site_settings')).rows;
      await migrate(url);
      assert.deepEqual(
        (await client.query('SELECT * FROM site_settings')).rows,
        before,
      );
    });
  },
);

test(
  'migration advisory-lock contention expires and leaves the ledger and data unchanged',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 25000 },
  async () => {
    await withSchema(async (url, client) => {
      await migrate(url);
      const blocker = new pg.Client({ connectionString: url });
      await blocker.connect();
      try {
        await blocker.query('SELECT pg_advisory_lock(74261005)');
        const before = (
          await client.query('SELECT * FROM schema_migrations ORDER BY name')
        ).rows;
        await assert.rejects(migrate(url, 250), { code: '55P03' });
        assert.deepEqual(
          (await client.query('SELECT * FROM schema_migrations ORDER BY name'))
            .rows,
          before,
        );
      } finally {
        await blocker.query('SELECT pg_advisory_unlock(74261005)');
        await blocker.end();
      }
      await migrate(url);
    });
  },
);
