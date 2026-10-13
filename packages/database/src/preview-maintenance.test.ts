import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import {
  runPreviewMaintenance,
  validatePreviewMaintenanceOptions,
} from './preview-maintenance.js';

const options = {
  dryRun: false,
  batchSize: 1,
  maxBatches: 1,
  graceMinutes: 60,
};
test('preview maintenance cannot be configured for an unbounded or too-early purge', () => {
  assert.deepEqual(validatePreviewMaintenanceOptions(options), options);
  for (const changes of [
    { batchSize: 0 },
    { batchSize: 501 },
    { maxBatches: 0 },
    { maxBatches: 21 },
    { graceMinutes: 59 },
    { graceMinutes: 10081 },
    { maxBatches: Number.NaN },
  ])
    assert.throws(
      () => validatePreviewMaintenanceOptions({ ...options, ...changes }),
      /batch-size/,
    );
});

test(
  'bounded expiry purge is dry-run-first, crash/replay safe and does not delete immutable receipts',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = 'maintenance_' + randomUUID().replaceAll('-', '');
    const root = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await root.connect();
    const clients: pg.Client[] = [];
    async function connection() {
      const client = new pg.Client({
        connectionString: process.env.TEST_DATABASE_URL,
        options: '-c search_path=' + schema,
        connectionTimeoutMillis: 5000,
      });
      await client.connect();
      clients.push(client);
      return client;
    }
    try {
      await root.query('CREATE SCHEMA ' + schema);
      const worker = await connection();
      const reader = await connection();
      const second = await connection();
      for (const table of ['xp_previews', 'competition_previews']) {
        await worker.query(
          'CREATE TABLE ' +
            table +
            ' (token_hash text PRIMARY KEY, snapshot jsonb NOT NULL, expires_at timestamptz NOT NULL)',
        );
        await worker.query(
          'CREATE INDEX ON ' + table + '(expires_at,token_hash)',
        );
      }
      // Real receipt tables are immutable and unrelated to previews.
      await worker.query(
        'CREATE TABLE xp_import_history (request_key text PRIMARY KEY, receipt text NOT NULL)',
      );
      await worker.query(
        'CREATE TABLE competition_import_history (request_key text PRIMARY KEY, receipt text NOT NULL)',
      );
      await worker.query('CREATE TABLE import_audit (event text PRIMARY KEY)');
      await worker.query(
        "INSERT INTO xp_import_history VALUES ('xp-key','applied'), ('xp-key-2','unchanged')",
      );
      await worker.query(
        "INSERT INTO competition_import_history VALUES ('competition-key','applied')",
      );
      await worker.query("INSERT INTO import_audit VALUES ('recorded')");
      const seed = async (table: string, token: string, ageMinutes: number) =>
        worker.query(
          'INSERT INTO ' +
            table +
            " (token_hash,snapshot,expires_at) VALUES($1,'{}'::jsonb,clock_timestamp() - ($2::int * interval '1 minute'))",
          [token, ageMinutes],
        );
      await seed('xp_previews', 'xp-old-1', 180);
      await seed('xp_previews', 'xp-old-2', 120);
      await seed('xp_previews', 'xp-grace', 59);
      await seed('xp_previews', 'xp-live', -5);
      await seed('competition_previews', 'competition-old-1', 180);
      await seed('competition_previews', 'competition-old-2', 120);
      await seed('competition_previews', 'competition-grace', 59);
      await seed('competition_previews', 'competition-live', -5);

      const inspect = await runPreviewMaintenance(worker, {
        ...options,
        dryRun: true,
      });
      assert.equal(inspect.mode, 'dry-run');
      for (const table of ['xp_previews', 'competition_previews'] as const) {
        assert.equal(inspect.tables[table].before.total, 4);
        assert.equal(inspect.tables[table].before.eligible, 2);
        assert.equal(inspect.tables[table].deleted, 0);
        assert.equal(inspect.tables[table].after.total, 4);
      }
      const first = await runPreviewMaintenance(worker, options);
      assert.equal(first.tables.xp_previews.deleted, 1);
      assert.equal(first.tables.competition_previews.deleted, 1);
      assert.equal(first.tables.xp_previews.after.eligible, 1);
      assert.equal(first.tables.competition_previews.after.eligible, 1);
      assert.equal(first.maximumDeletesPerTable, 1);

      // Simulate interrupted/aborted apply: FOR KEY SHARE guards a row
      // already consumed by an apply transaction, and SKIP LOCKED never waits.
      await reader.query('BEGIN');
      await reader.query(
        "SELECT token_hash FROM xp_previews WHERE token_hash='xp-old-2' FOR KEY SHARE",
      );
      const competing = await runPreviewMaintenance(worker, options);
      assert.equal(competing.tables.xp_previews.deleted, 0);
      assert.equal(competing.tables.competition_previews.deleted, 1);
      await reader.query('ROLLBACK');
      const resumed = await runPreviewMaintenance(worker, options);
      assert.equal(resumed.tables.xp_previews.deleted, 1);
      assert.equal(resumed.tables.competition_previews.deleted, 0);

      // Another invocation cannot perform cleanup while a maintenance owner
      // holds the advisory lock. No second purge is started by accident.
      await reader.query('SELECT pg_advisory_lock(74261079)');
      await assert.rejects(
        runPreviewMaintenance(second, options),
        /Another import preview maintenance command is active/,
      );
      await reader.query('SELECT pg_advisory_unlock(74261079)');

      // Transaction rollback simulates a crash midway through a batch.
      await seed('xp_previews', 'xp-interrupted', 180);
      await worker.query('BEGIN');
      await worker.query(
        "DELETE FROM xp_previews WHERE token_hash='xp-interrupted'",
      );
      await worker.query('ROLLBACK');
      assert.equal(
        (
          await worker.query(
            "SELECT 1 FROM xp_previews WHERE token_hash='xp-interrupted'",
          )
        ).rowCount,
        1,
      );
      const restarted = await runPreviewMaintenance(second, options);
      assert.equal(restarted.tables.xp_previews.deleted, 1);
      const again = await runPreviewMaintenance(second, {
        ...options,
        maxBatches: 20,
      });
      assert.equal(again.tables.xp_previews.deleted, 0);
      assert.equal(again.tables.competition_previews.deleted, 0);
      for (const table of ['xp_previews', 'competition_previews']) {
        const left = (
          await worker.query<{ token_hash: string }>(
            'SELECT token_hash FROM ' + table + ' ORDER BY token_hash',
          )
        ).rows.map((r) => r.token_hash);
        assert.deepEqual(
          left,
          table === 'xp_previews'
            ? ['xp-grace', 'xp-live']
            : ['competition-grace', 'competition-live'],
        );
      }
      // Previously completed idempotency keys can still return their original
      // outcome independently of the deleted token's preview snapshot.
      assert.deepEqual(
        (
          await worker.query(
            'SELECT request_key,receipt FROM xp_import_history ORDER BY request_key',
          )
        ).rows,
        [
          { request_key: 'xp-key', receipt: 'applied' },
          { request_key: 'xp-key-2', receipt: 'unchanged' },
        ],
      );
      assert.deepEqual(
        (
          await worker.query(
            'SELECT request_key,receipt FROM competition_import_history',
          )
        ).rows,
        [{ request_key: 'competition-key', receipt: 'applied' }],
      );
      assert.equal(
        (await worker.query('SELECT event FROM import_audit')).rows[0]?.event,
        'recorded',
      );
    } finally {
      for (const client of clients) {
        await client.query('ROLLBACK').catch(() => undefined);
        await client.end().catch(() => undefined);
      }
      await root.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
      await root.end();
    }
  },
);
