/** Exercise real index traversal beyond the former queue/history caps. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { PgStore } from './store.js';
import { PgReviewStore } from './review-store.js';

async function fixture(
  run: (pool: pg.Pool, review: PgReviewStore) => Promise<void>,
) {
  const connectionString = process.env.TEST_DATABASE_URL!;
  const schema = 'review_page_' + randomUUID().replaceAll('-', '');
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
    for (const file of (await readdir(migrations))
      .filter((f) => f.endsWith('.sql'))
      .sort())
      await pool.query(await readFile(new URL(file, migrations), 'utf8'));
    await pool.query("INSERT INTO items(id,name) VALUES(42,'Evidence item')");
    await run(pool, new PgReviewStore(pool, new PgStore(pool)));
  } finally {
    await pool.end();
    await root.query('DROP SCHEMA ' + schema + ' CASCADE');
    await root.end();
  }
}
const id = (n: number) =>
  '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
async function claims(pool: pg.Pool, start: number, end: number) {
  // Equal timestamps and differences smaller than a JS millisecond exercise both key parts.
  await pool.query(
    `INSERT INTO submissions(id,source,raw_item_text,collector_name,collected_on,date_source,proof_url,submitted_at)
    SELECT ('00000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,'manual','Evidence item','Collector',
      '2026-10-01','admin','',timestamptz '2026-10-01' + (n / 3) * interval '1 microsecond'
    FROM generate_series($1::int,$2::int) n`,
    [start, end],
  );
}
async function events(
  pool: pg.Pool,
  review: PgReviewStore,
  start: number,
  end: number,
) {
  const row = (await review.detail(id(1)))!.submission;
  await pool.query(
    `INSERT INTO audit_events(submission_id,actor_discord_id,actor_name,action,reason,old_values,new_values)
    SELECT $1,'staff','Reviewer','edit','Evidence ' || n,$2::jsonb,$2::jsonb FROM generate_series($3::int,$4::int) n`,
    [id(1), JSON.stringify(row), start, end],
  );
}

test(
  'SQL pages traverse below/at/above 20,000 claims and 5,000 events without discarding evidence',
  { skip: !process.env.TEST_DATABASE_URL },
  async () =>
    fixture(async (pool, review) => {
      await claims(pool, 1, 19999);
      for (const count of [19999, 20000, 20001]) {
        if (count !== 19999) await claims(pool, count, count);
        const page = await review.queue('pending', false, 20);
        assert.equal(page.submissions.length, 20);
        assert.equal(page.submissions[0]!.id, id(count));
        assert.equal('pageTime' in page.submissions[0]!, false);
      }
      const cursors: string[] = [],
        seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await review.queue('pending', false, 20, cursor);
        cursors.push(page.pageCursor);
        seen.push(...page.submissions.map((s) => s.id));
        assert.ok(page.submissions.length <= 20);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      assert.deepEqual(
        seen,
        Array.from({ length: 20001 }, (_, i) => id(20001 - i)),
      );
      for (const page of [1000, 500, 0]) {
        const previous = await review.queue(
          'pending',
          false,
          20,
          cursors[page],
        );
        assert.deepEqual(
          previous.submissions.map((s) => s.id),
          seen.slice(page * 20, page * 20 + 20),
        );
      }
      const original = (await review.detail(id(1)))!.submission;
      const requestKey = randomUUID();
      await pool.query(
        'INSERT INTO manual_submission_requests(actor_id,request_key,payload_hash,submission_id,response) VALUES($1,$2,$3,$4,$5)',
        ['staff', requestKey, 'a'.repeat(64), id(1), JSON.stringify(original)],
      );
      await events(pool, review, 1, 4999);
      for (const count of [4999, 5000, 5001]) {
        if (count !== 4999) await events(pool, review, count, count);
        const page = (await review.detail(id(1)))!;
        assert.equal(page.audit.length, 20);
        assert.equal(page.audit[0]!.reason, 'Evidence ' + count);
        assert.ok(page.nextAuditCursor);
      }
      const auditIds: string[] = [],
        historyCursors: string[] = [];
      cursor = undefined;
      do {
        const page: NonNullable<Awaited<ReturnType<PgReviewStore['detail']>>> =
          (await review.detail(id(1), cursor))!;
        historyCursors.push(page.auditCursor);
        for (const entry of page.audit) {
          assert.deepEqual(entry.before, original);
          assert.deepEqual(entry.after, original);
          assert.equal(entry.reason, 'Evidence ' + (5001 - auditIds.length));
          auditIds.push(entry.id);
        }
        cursor = page.nextAuditCursor ?? undefined;
      } while (cursor);
      assert.equal(auditIds.length, 5001);
      assert.equal(new Set(auditIds).size, 5001);
      for (const page of [250, 125, 0])
        assert.deepEqual(
          (await review.detail(id(1), historyCursors[page]))!.audit.map(
            (a) => a.id,
          ),
          auditIds.slice(page * 20, page * 20 + 20),
        );
      assert.equal(
        (await pool.query('SELECT count(*)::int AS n FROM audit_events'))
          .rows[0].n,
        5001,
      );
      assert.deepEqual(
        (await pool.query('SELECT response FROM manual_submission_requests'))
          .rows[0].response,
        original,
      );
    }),
);

test(
  'transactional revisions reject concurrent changes, cross-filter/history cursors and malformed anchors',
  { skip: !process.env.TEST_DATABASE_URL },
  async () =>
    fixture(async (pool, review) => {
      await claims(pool, 1, 25);
      await events(pool, review, 1, 25);
      const queue = await review.queue('pending', false, 20),
        detail = (await review.detail(id(1)))!;
      for (const [status, unmatched, limit] of [
        ['pending', true, 20],
        ['reviewed', false, 20],
        ['pending', false, 1],
      ] as const)
        await assert.rejects(
          review.queue(status, unmatched, limit, queue.nextCursor!),
          { status: 409 },
        );
      await assert.rejects(review.detail(id(2), detail.nextAuditCursor!), {
        status: 409,
      });
      await assert.rejects(review.detail(id(1), detail.nextAuditCursor!, 1), {
        status: 409,
      });
      await assert.rejects(review.detail(id(1), queue.nextCursor!), {
        status: 409,
      });
      await assert.rejects(
        review.queue('pending', false, 20, detail.nextAuditCursor!),
        { status: 409 },
      );
      for (const key of [
        ['2026-02-30T00:00:00.000000Z', id(1)],
        ['2026-10-01T00:00:00.000000Z', 'bad'],
        [12],
        {},
        null,
      ]) {
        const cursor = Buffer.from(
          JSON.stringify({ revision: queue.revision, key }),
        ).toString('base64url');
        if (key !== null)
          await assert.rejects(review.queue('pending', false, 20, cursor), {
            status: 409,
          });
      }
      for (const key of [['9223372036854775808'], [12], ['0'], ['1;SELECT 1']])
        await assert.rejects(
          review.detail(
            id(1),
            Buffer.from(
              JSON.stringify({ revision: detail.auditRevision, key }),
            ).toString('base64url'),
          ),
          { status: 409 },
        );
      for (const cursor of ['bad', '', 'x'.repeat(1025)])
        await assert.rejects(review.queue('pending', false, 20, cursor), {
          status: 409,
        });
      for (const size of [0, 21, 1.1]) {
        await assert.rejects(review.queue('pending', false, size), {
          status: 400,
        });
        await assert.rejects(review.detail(id(1), undefined, size), {
          status: 400,
        });
      }
      const writer = await pool.connect();
      try {
        await writer.query('BEGIN');
        await writer.query(
          "UPDATE submissions SET collector_name='Concurrent collector',version=version+1 WHERE id=$1",
          [id(1)],
        );
        // Repeatable reads do not block on an uncommitted counter/row; the old revision remains usable.
        assert.equal(
          (await review.queue('pending', false, 20, queue.nextCursor!))
            .revision,
          queue.revision,
        );
        assert.equal(
          (await review.detail(id(1), detail.nextAuditCursor!))!.submission
            .version,
          1,
        );
        await writer.query('COMMIT');
        for (const cursor of [queue.pageCursor, queue.nextCursor!])
          await assert.rejects(review.queue('pending', false, 20, cursor), {
            status: 409,
          });
        for (const cursor of [detail.auditCursor, detail.nextAuditCursor!])
          await assert.rejects(review.detail(id(1), cursor), { status: 409 });
        const fresh = await review.queue('pending', false, 20),
          audit = (await review.detail(id(1)))!;
        await writer.query('BEGIN');
        await writer.query(
          `INSERT INTO audit_events(submission_id,actor_discord_id,actor_name,action,old_values,new_values) VALUES($1,'staff','Late commit','edit',$2,$2)`,
          [id(1), JSON.stringify(audit.submission)],
        );
        assert.equal(
          (await review.detail(id(1), audit.nextAuditCursor!))!.auditRevision,
          audit.auditRevision,
        );
        await writer.query('COMMIT');
        await assert.rejects(review.detail(id(1), audit.nextAuditCursor!), {
          status: 409,
        });
        await assert.rejects(
          review.queue('pending', false, 20, fresh.pageCursor),
          { status: 409 },
        );
        const beforeRollback = await review.queue('pending', false, 20);
        await writer.query('BEGIN');
        await writer.query(
          "UPDATE submissions SET review_note='Rolled back' WHERE id=$1",
          [id(1)],
        );
        await writer.query('ROLLBACK');
        assert.equal(
          (await review.queue('pending', false, 20, beforeRollback.pageCursor))
            .revision,
          beforeRollback.revision,
        );
        await claims(pool, 26, 26);
        await assert.rejects(
          review.queue('pending', false, 20, beforeRollback.nextCursor!),
          { status: 409 },
        );
        const beforeDecision = await review.queue('pending', false, 20);
        await review.mutate(
          id(2),
          1,
          {
            expectedVersion: 1,
            action: 'reject',
            reason: 'Reviewed while paging',
          },
          'staff',
          'Reviewer',
        );
        await assert.rejects(
          review.queue('pending', false, 20, beforeDecision.nextCursor!),
          { status: 409 },
        );
        assert.equal(
          (await review.queue('reviewed', false, 20)).submissions[0]!.id,
          id(2),
        );
      } finally {
        await writer.query('ROLLBACK');
        writer.release();
      }
    }),
);

test(
  'indexed page query work stays bounded at deep positions in a 60,003-claim ledger',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) =>
    fixture(async (pool, review) => {
      await claims(pool, 1, 60003);
      await pool.query(
        'UPDATE submissions SET item_id=42 WHERE id >= $1 AND id < $2',
        [id(20002), id(40003)],
      );
      await pool.query(
        "UPDATE submissions SET status='rejected',reviewed_by='staff',reviewed_at=now(),review_reason='Reviewed' WHERE id >= $1",
        [id(40003)],
      );
      // A sparse history among unrelated events must seek its composite index.
      await pool.query(
        "INSERT INTO audit_events(submission_id,actor_discord_id,actor_name,action,old_values,new_values) SELECT $1,'staff','Other history','edit','{}','{}' FROM generate_series(1,100000)",
        [id(2)],
      );
      await events(pool, review, 1, 5001);
      const auditAnchor =
        BigInt(
          (await pool.query('SELECT max(id)::text AS id FROM audit_events'))
            .rows[0].id,
        ) - 4000n;
      await pool.query('ANALYZE submissions');
      await pool.query('ANALYZE audit_events');
      const plans = [];
      for (const [name, predicate] of [
        ['submissions_pending_page', "status='pending'"],
        ['submissions_unmatched_page', "status='pending' AND item_id IS NULL"],
        [
          'submissions_reviewed_page',
          "status IN ('approved','rejected','revoked')",
        ],
      ]) {
        const anchor = (
          await pool.query(
            'SELECT submitted_at::text AS at,id FROM submissions WHERE ' +
              predicate +
              ' ORDER BY submitted_at DESC,id DESC OFFSET 19000 LIMIT 1',
          )
        ).rows[0];
        const result = (
          await pool.query(
            'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT id,version,raw_item_text FROM submissions WHERE ' +
              predicate +
              ' AND (submitted_at,id) < ($1::timestamptz,$2::uuid) ORDER BY submitted_at DESC,id DESC LIMIT 21',
            [anchor.at, anchor.id],
          )
        ).rows[0]['QUERY PLAN'][0];
        const scan = result.Plan.Plans[0];
        assert.equal(scan['Index Name'], name);
        assert.equal(scan['Actual Rows'], 21);
        assert.equal(scan['Rows Removed by Filter'] ?? 0, 0);
        plans.push({
          index: name,
          returned: scan['Actual Rows'],
          milliseconds: result['Execution Time'],
          buffers:
            result.Plan['Shared Hit Blocks'] +
            result.Plan['Shared Read Blocks'],
        });
      }
      const audit = (
        await pool.query(
          'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT id,old_values,new_values FROM audit_events WHERE submission_id=$1 AND (submission_id,id) < ($1::uuid,$2::bigint) ORDER BY id DESC LIMIT 21',
          [id(1), auditAnchor.toString()],
        )
      ).rows[0]['QUERY PLAN'][0];
      assert.ok(
        ['audit_submission_page', 'audit_events_pkey'].includes(
          audit.Plan.Plans[0]['Index Name'],
        ),
      );
      assert.equal(audit.Plan.Plans[0]['Rows Removed by Filter'] ?? 0, 0);
      assert.equal(audit.Plan.Plans[0]['Actual Rows'], 21);
      plans.push({
        index: audit.Plan.Plans[0]['Index Name'],
        returned: 21,
        milliseconds: audit['Execution Time'],
        buffers:
          audit.Plan['Shared Hit Blocks'] + audit.Plan['Shared Read Blocks'],
      });
      const tail = (
        await pool.query(
          'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT id,old_values,new_values FROM audit_events WHERE submission_id=$1 AND (submission_id,id) < ($1::uuid,$2::bigint) ORDER BY id DESC LIMIT 21',
          [id(1), '100002'],
        )
      ).rows[0]['QUERY PLAN'][0];
      assert.equal(tail.Plan.Plans[0]['Index Name'], 'audit_submission_page');
      assert.equal(tail.Plan.Plans[0]['Actual Rows'], 1);
      assert.equal(tail.Plan.Plans[0]['Rows Removed by Filter'] ?? 0, 0);
      plans.push({
        index: tail.Plan.Plans[0]['Index Name'],
        returned: 1,
        milliseconds: tail['Execution Time'],
        buffers:
          tail.Plan['Shared Hit Blocks'] + tail.Plan['Shared Read Blocks'],
      });
      const start = performance.now();
      const first = await review.queue('pending', false, 20);
      const queueMs = performance.now() - start;
      assert.equal(first.submissions.length, 20);
      const detailStart = performance.now();
      await review.detail(id(1));
      t.diagnostic(
        JSON.stringify({
          claims: 60003,
          events: 105001,
          selectedHistoryEvents: 5001,
          queueRows: 21,
          detailRows: 23,
          queueSelects: 2,
          detailSelects: 3,
          queueMilliseconds: queueMs,
          detailMilliseconds: performance.now() - detailStart,
          plans,
        }),
      );
    }),
);
