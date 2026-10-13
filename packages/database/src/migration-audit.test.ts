/** Exercise the migration runner itself, using an isolated disposable schema. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { migrate } from './migrate.js';

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
  'an image must reject an applied migration absent from its bundled history',
  {
    skip: !process.env.TEST_DATABASE_URL,
    todo: 'GitHub #62 B05: migrate ignores unknown applied migrations; add an explicit compatibility policy.',
  },
  async () => {
    await withSchema(async (url, client) => {
      await migrate(url);
      await client.query(
        'INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',
        ['999_future.sql', 'f'.repeat(64)],
      );
      await assert.rejects(migrate(url));
    });
  },
);
