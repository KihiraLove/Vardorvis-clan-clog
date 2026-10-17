/** Real SQL history traversal preserves append-only receipts beyond the old cap. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { PgXpStore } from './xp-store.js';
import type { XpSnapshot } from './xp-types.js';

const snapshot: XpSnapshot = {
  event: {
    id: 42,
    title: 'Exact XP',
    sourceUrl: 'https://wiseoldman.net/competitions/42',
    skills: ['attack'],
    gains: { attack: '9007199254740993' },
  },
  participants: [
    {
      playerId: 1,
      displayName: 'Collector',
      gains: { attack: '9007199254740993' },
    },
  ],
  startsAt: '2026-09-01T00:00:00.000Z',
  endsAt: '2026-09-08T00:00:00.000Z',
  sourceUpdatedAt: '2026-09-08T00:00:00.000Z',
  sourceHash: 'a'.repeat(64),
};
const id = (n: number) =>
  '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const changes = [
  {
    skill: 'attack',
    before: '9007199254740993',
    after: '9007199254740994',
    change: '1',
  },
];
const unchanged = [{ ...changes[0], after: changes[0]!.before, change: '0' }];
async function fixture(
  run: (pool: pg.Pool, store: PgXpStore) => Promise<void>,
) {
  const connectionString = process.env.TEST_DATABASE_URL!;
  const schema = 'xp_history_' + randomUUID().replaceAll('-', '');
  const root = new pg.Pool({ connectionString });
  await root.query('CREATE SCHEMA ' + schema);
  const pool = new pg.Pool({
    connectionString,
    options: '-c search_path=' + schema,
    statement_timeout: 8000,
  });
  try {
    const migrations = new URL(
      '../../../packages/database/migrations/',
      import.meta.url,
    );
    for (const name of (await readdir(migrations))
      .filter((n) => n.endsWith('.sql'))
      .sort())
      await pool.query(await readFile(new URL(name, migrations), 'utf8'));
    await run(pool, new PgXpStore(pool));
  } finally {
    await pool.end();
    await root.query('DROP SCHEMA ' + schema + ' CASCADE');
    await root.end();
  }
}
async function firstImport(store: PgXpStore) {
  const preview = await store.preview(snapshot, 'staff'),
    key = randomUUID();
  const result = await store.apply(
    preview.previewToken,
    preview.expectedRevision,
    key,
    'staff',
    'History admin',
    false,
  );
  return { preview, key, result };
}
async function append(
  pool: pg.Pool | pg.PoolClient,
  start: number,
  end: number,
) {
  await pool.query(
    `INSERT INTO xp_import_history(id,actor_discord_id,actor_name,request_key,token_hash,expected_revision,competition_id,title,imported_at,outcome,changes,resulting_revision)
    SELECT ('00000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,'fixture','History admin',
    ('00000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,repeat('a',64),'xp-2',42,'Receipt ' || n,
    timestamptz '2026-10-01' + (n / 3) * interval '1 microsecond',
    CASE WHEN n % 2 = 0 THEN 'applied' ELSE 'unchanged' END,
    CASE WHEN n % 2 = 0 THEN $3::jsonb ELSE $4::jsonb END,'xp-2' FROM generate_series($1::int,$2::int) n`,
    [start, end, JSON.stringify(changes), JSON.stringify(unchanged)],
  );
}

test(
  'XP history pages traverse 1,999/2,000/2,001 receipts with exact values, ties and stable previous navigation',
  { skip: !process.env.TEST_DATABASE_URL },
  async () =>
    fixture(async (pool, store) => {
      await firstImport(store);
      await append(pool, 1, 1998);
      for (const total of [1999, 2000, 2001]) {
        if (total !== 1999) await append(pool, total - 1, total - 1);
        const first = await store.history();
        assert.equal(first.imports.length, 20);
        assert.ok(first.nextCursor);
      }
      const cursors: string[] = [],
        seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await store.history(cursor);
        cursors.push(page.pageCursor);
        for (const entry of page.imports) {
          if (entry.id.startsWith('00000000-')) {
            assert.equal(entry.actorName, 'History admin');
            assert.deepEqual(
              entry.changes,
              Number(entry.id.slice(-12)) % 2 === 0 ? changes : unchanged,
            );
          }
          assert.equal('token_hash' in entry, false);
          seen.push(entry.id);
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      assert.equal(seen.length, 2001);
      assert.equal(new Set(seen).size, 2001);
      assert.deepEqual(
        seen.slice(1),
        Array.from({ length: 2000 }, (_, n) => id(2000 - n)),
      );
      for (const page of [100, 50, 0])
        assert.deepEqual(
          (await store.history(cursors[page])).imports.map((r) => r.id),
          seen.slice(page * 20, page * 20 + 20),
        );
      assert.equal(
        (await pool.query('SELECT count(*)::int AS n FROM xp_import_history'))
          .rows[0].n,
        2001,
      );
    }),
);

test(
  'unchanged imports invalidate history independently of XP totals, preserve replay and reject malformed/stale cursors',
  { skip: !process.env.TEST_DATABASE_URL },
  async () =>
    fixture(async (pool, store) => {
      const original = await firstImport(store);
      await append(pool, 1, 45);
      const before = await store.history(),
        totals = await store.tracker();
      const receiptBefore = (
        await pool.query(
          'SELECT * FROM xp_import_history WHERE request_key=$1',
          [original.key],
        )
      ).rows;
      const preview = await store.preview(snapshot, 'staff');
      const unchangedKey = randomUUID();
      const result = await store.apply(
        preview.previewToken,
        preview.expectedRevision,
        unchangedKey,
        'staff',
        'History admin',
        false,
      );
      assert.equal(result.outcome, 'unchanged');
      assert.equal(result.revision, totals.revision);
      assert.deepEqual(await store.tracker(), totals);
      for (const cursor of [before.pageCursor, before.nextCursor!])
        await assert.rejects(store.history(cursor), { status: 409 });
      const first = await store.history();
      await assert.rejects(store.history(first.nextCursor!, 1), {
        status: 409,
      });
      for (const cursor of [
        '',
        'bad',
        'x'.repeat(1025),
        Buffer.from(
          JSON.stringify({
            revision: first.revision,
            limit: 20,
            key: { at: '2026-02-30T00:00:00.000000Z', id: id(1) },
          }),
        ).toString('base64url'),
      ])
        await assert.rejects(store.history(cursor), { status: 409 });
      for (const limit of [0, 21, 1.5])
        await assert.rejects(store.history(undefined, limit), { status: 400 });
      const writer = await pool.connect();
      try {
        await writer.query('BEGIN');
        await append(writer, 46, 46);
        assert.equal(
          (await store.history(first.nextCursor!)).revision,
          first.revision,
        );
        await writer.query('ROLLBACK');
        assert.equal(
          (await store.history(first.pageCursor)).revision,
          first.revision,
        );
        await writer.query('BEGIN');
        await append(writer, 46, 46);
        await writer.query('COMMIT');
        await assert.rejects(store.history(first.nextCursor!), { status: 409 });
      } finally {
        await writer.query('ROLLBACK');
        writer.release();
      }
      await append(pool, 47, 2100);
      await pool.query('DELETE FROM xp_previews');
      const count = (
        await pool.query('SELECT count(*) AS n FROM xp_import_history')
      ).rows[0].n;
      assert.deepEqual(
        await new PgXpStore(pool).apply(
          original.preview.previewToken,
          original.preview.expectedRevision,
          original.key,
          'staff',
          'History admin',
          false,
        ),
        original.result,
      );
      assert.deepEqual(
        await new PgXpStore(pool).apply(
          preview.previewToken,
          preview.expectedRevision,
          unchangedKey,
          'staff',
          'History admin',
          false,
        ),
        result,
      );
      assert.equal(
        (await pool.query('SELECT count(*) AS n FROM xp_import_history'))
          .rows[0].n,
        count,
      );
      assert.deepEqual(
        (
          await pool.query(
            'SELECT * FROM xp_import_history WHERE request_key=$1',
            [original.key],
          )
        ).rows,
        receiptBefore,
      );
    }),
);

test(
  'XP history uses the same bounded index seeks at 2,001 and 50,001 receipts including the final page',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) =>
    fixture(async (pool, store) => {
      await firstImport(store);
      await append(pool, 1, 2000);
      const measurements = [];
      for (const total of [2001, 50001]) {
        if (total === 50001) await append(pool, 2001, 50000);
        await pool.query('ANALYZE xp_import_history');
        for (const n of [undefined, 2000, 2]) {
          const anchor = n
            ? (
                await pool.query(
                  'SELECT imported_at::text AS at,id FROM xp_import_history WHERE id=$1',
                  [id(n)],
                )
              ).rows[0]
            : undefined;
          const sql =
            'SELECT id::text,competition_id::text,title,actor_name,imported_at,outcome,changes FROM xp_import_history ' +
            (anchor
              ? 'WHERE (imported_at,id) < ($1::timestamptz,$2::uuid) '
              : '') +
            'ORDER BY xp_import_history.imported_at DESC,xp_import_history.id DESC LIMIT 21';
          const plan = (
            await pool.query(
              'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + sql,
              anchor ? [anchor.at, anchor.id] : [],
            )
          ).rows[0]['QUERY PLAN'][0];
          const scan = plan.Plan.Plans[0];
          assert.equal(scan['Index Name'], 'xp_history_latest');
          assert.equal(scan['Actual Rows'], n === 2 ? 1 : 21);
          assert.equal(scan['Rows Removed by Filter'] ?? 0, 0);
          measurements.push({
            total,
            anchor: n ?? 'first',
            rows: scan['Actual Rows'],
            milliseconds: plan['Execution Time'],
            buffers:
              plan.Plan['Shared Hit Blocks'] + plan.Plan['Shared Read Blocks'],
          });
        }
        const start = performance.now();
        await store.history();
        t.diagnostic(
          JSON.stringify({
            total,
            selects: 2,
            maxRows: 22,
            storeMilliseconds: performance.now() - start,
          }),
        );
      }
      t.diagnostic(JSON.stringify({ plans: measurements }));
    }),
);
