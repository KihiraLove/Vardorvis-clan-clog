/** Exercise the migration runner itself, using an isolated disposable schema. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
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
      assert.equal(rows.length, 14);
      assert.equal(
        new Set(rows.map((row: { name: string }) => row.name)).size,
        14,
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
  'a missing middle migration and out-of-order timestamps reject an existing database',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    await withSchema(async (url, client) => {
      await migrate(url);
      await client.query(
        "DELETE FROM schema_migrations WHERE name='006_clan_logos.sql'",
      );
      const before = (
        await client.query('SELECT * FROM schema_migrations ORDER BY name')
      ).rows;
      await assert.rejects(
        migrate(url),
        /Non-prefix migration history at: 007_site_customization.sql/u,
      );
      assert.deepEqual(
        (await client.query('SELECT * FROM schema_migrations ORDER BY name'))
          .rows,
        before,
      );
    });
    await withSchema(async (url, client) => {
      await migrate(url);
      await client.query(
        "UPDATE schema_migrations SET applied_at=now()-interval '1 day' WHERE name='014_wom_competitions.sql'",
      );
      await assert.rejects(
        migrate(url),
        /Reordered migration history at: 014_wom_competitions.sql/u,
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
  'populated 013 to 014 upgrade backfills legacy competitions and rolls back a broken batch',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    await withSchema(async (url, client) => {
      const directory = new URL('../migrations/', import.meta.url);
      const names = (await readdir(directory))
        .filter((name) => name.endsWith('.sql'))
        .sort();
      await client.query(
        'CREATE TABLE schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      for (const name of names.filter(
        (name) => name <= '013_collection_log_schedules.sql',
      )) {
        const sql = await readFile(new URL(name, directory), 'utf8');
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',
          [name, createHash('sha256').update(sql).digest('hex')],
        );
        await client.query('COMMIT');
      }
      assert.equal(
        (
          await client.query(
            'SELECT count(*)::int AS count FROM schema_migrations',
          )
        ).rows[0].count,
        13,
      );
      await client.query(
        "UPDATE site_settings SET clan_name='A preserved clan',version=4",
      );
      await client.query(
        `INSERT INTO xp_events(competition_id,title,source_url,skills,gains,source_hash,source_snapshot)
         VALUES(98765,'Legacy WOM','https://wiseoldman.net/competitions/98765','["mining"]','{"mining":"123"}',$1,$2)`,
        ['a'.repeat(64), JSON.stringify({ startsAt: '2026-10-01T00:00:00Z' })],
      );
      const before = (await client.query('SELECT * FROM xp_events')).rows;
      await assert.rejects(migrate(url), { code: '23502' });
      assert.deepEqual(
        (await client.query('SELECT * FROM xp_events')).rows,
        before,
      );
      assert.equal(
        (
          await client.query(
            'SELECT count(*)::int AS count FROM schema_migrations',
          )
        ).rows[0].count,
        13,
      );
      assert.equal(
        (
          await client.query(
            "SELECT to_regclass('wom_competitions') AS table_name",
          )
        ).rows[0].table_name,
        null,
      );
      await client.query(
        'UPDATE xp_events SET source_snapshot=$1 WHERE competition_id=98765',
        [
          JSON.stringify({
            startsAt: '2026-10-01T00:00:00Z',
            endsAt: '2026-10-02T00:00:00Z',
          }),
        ],
      );
      const recovered = (await client.query('SELECT * FROM xp_events')).rows;
      await Promise.all([migrate(url), migrate(url)]);
      assert.equal(
        (
          await client.query(
            "SELECT name FROM schema_migrations WHERE name='014_wom_competitions.sql'",
          )
        ).rowCount,
        1,
      );
      assert.deepEqual(
        (
          await client.query(
            'SELECT competition_id,kind,title,skills FROM wom_competitions',
          )
        ).rows,
        [
          {
            competition_id: '98765',
            kind: 'SKILL',
            title: 'Legacy WOM',
            skills: ['mining'],
          },
        ],
      );
      assert.deepEqual(
        (
          await client.query(
            'SELECT competition_id,title,source_url,skills,gains,source_hash,source_snapshot,imported_at FROM xp_events',
          )
        ).rows,
        recovered,
      );
      assert.deepEqual(
        (await client.query('SELECT clan_name,version FROM site_settings'))
          .rows,
        [{ clan_name: 'A preserved clan', version: 4 }],
      );
      await migrate(url);
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
