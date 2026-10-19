/** Ended-only archival preserves source data while bounding current/history reads. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { PgLifecycleStore } from '@clog/database/dist/lifecycle.js';
import { PgCompetitionStore } from './competition-store.js';
import { PgXpStore } from './xp-store.js';
import { PgSchedulingStore } from './scheduling-store.js';
import { intakeScheduling } from './intake-scheduling.js';
import { classifyCollection } from '@clog/domain';
import { PgStore } from './store.js';
import { createApp } from './app.js';
import { hashPassword } from './passwords.js';
import type { CompetitionSnapshot } from './competition-types.js';
const sid = (n: number) =>
  '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const reason = 'Retain ended records for historical inspection';
const skill = (
  id: number,
  end = '2026-09-08T00:00:00.000Z',
): CompetitionSnapshot => ({
  competition: {
    id,
    kind: 'SKILL',
    title: 'Skill ' + id,
    sourceUrl: 'https://wiseoldman.net/competitions/' + id,
    metrics: ['attack'],
    startsAt: '2026-09-01T00:00:00.000Z',
    endsAt: end,
  },
  skills: ['attack'],
  lifecycle: 'finished',
  results: {
    participants: [],
    xp: {
      event: {
        id,
        title: 'Skill ' + id,
        sourceUrl: 'https://wiseoldman.net/competitions/' + id,
        skills: ['attack'],
        gains: { attack: '9007199254740993' },
      },
      participants: [
        {
          playerId: 1,
          displayName: 'Exact player',
          gains: { attack: '9007199254740993' },
        },
      ],
      startsAt: '2026-09-01T00:00:00.000Z',
      endsAt: end,
      sourceUpdatedAt: end,
      sourceHash: 'a'.repeat(64),
    },
  },
});
const activity = (
  id: number,
  start = '2026-09-01T00:00:00.000Z',
  end = '2026-09-08T00:00:00.000Z',
): CompetitionSnapshot => ({
  competition: {
    id,
    kind: 'ACTIVITY',
    title: 'Activity ' + id,
    sourceUrl: 'https://wiseoldman.net/competitions/' + id,
    metrics: ['vardorvis'],
    startsAt: start,
    endsAt: end,
  },
  skills: [],
  lifecycle: 'finished',
  results: {
    participants: [{ playerId: 1, displayName: 'Player', gained: '7' }],
  },
});
async function fixture(
  run: (
    pool: pg.Pool,
    lifecycle: PgLifecycleStore,
    scheduling: PgSchedulingStore,
    competitions: PgCompetitionStore,
    xp: PgXpStore,
  ) => Promise<void>,
) {
  const connectionString = process.env.TEST_DATABASE_URL!,
    schema = 'lifecycle_' + randomUUID().replaceAll('-', '');
  const root = new pg.Pool({ connectionString });
  await root.query('CREATE SCHEMA ' + schema);
  const pool = new pg.Pool({
    connectionString,
    options: '-c search_path=' + schema,
    max: 10,
    statement_timeout: 10000,
  });
  try {
    const migrations = new URL(
      '../../../packages/database/migrations/',
      import.meta.url,
    );
    for (const file of (await readdir(migrations))
      .filter((n) => n.endsWith('.sql'))
      .sort())
      await pool.query(await readFile(new URL(file, migrations), 'utf8'));
    await pool.query(
      "INSERT INTO pages(id,category,name,sort_order) VALUES('p','bosses','Page',0)",
    );
    await pool.query(
      "INSERT INTO items(id,name,icon_path) VALUES(42,'Retained item','/items/42.png')",
    );
    await pool.query(
      "INSERT INTO page_items(page_id,item_id,slot) VALUES('p',42,0)",
    );
    await run(
      pool,
      new PgLifecycleStore(pool),
      new PgSchedulingStore(pool),
      new PgCompetitionStore(pool),
      new PgXpStore(pool),
    );
  } finally {
    await pool.end();
    await root.query('DROP SCHEMA ' + schema + ' CASCADE');
    await root.end();
  }
}
async function schedules(
  pool: pg.Pool | pg.PoolClient,
  from: number,
  to: number,
  archived = false,
) {
  await pool.query(
    `INSERT INTO collection_log_schedules(id,title,starts_at,ends_at,archived_at) SELECT
    ('00000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,'Schedule ' || n,'2026-09-01','2026-09-08',
    CASE WHEN $3 THEN timestamptz '2026-09-09' ELSE NULL END FROM generate_series($1::int,$2::int) n`,
    [from, to, archived],
  );
  await pool.query(
    `INSERT INTO collection_log_schedule_pages(schedule_id,page_id) SELECT
    ('00000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,'p' FROM generate_series($1::int,$2::int) n`,
    [from, to],
  );
}
async function identities(
  pool: pg.Pool,
  from: number,
  to: number,
  kind = 'ACTIVITY',
  archived = false,
) {
  await pool.query(
    `INSERT INTO wom_competitions(competition_id,kind,title,source_url,metrics,skills,starts_at,ends_at,archived_at)
    SELECT n,$3,'Competition ' || n,'https://wiseoldman.net/competitions/' || n,
    CASE WHEN $3='SKILL' THEN '["attack"]'::jsonb ELSE '["vardorvis"]'::jsonb END,
    CASE WHEN $3='SKILL' THEN '["attack"]'::jsonb ELSE '[]'::jsonb END,'2026-09-01','2026-09-08',
    CASE WHEN $4 THEN timestamptz '2026-09-09' ELSE NULL END FROM generate_series($1::int,$2::int) n`,
    [from, to, kind, archived],
  );
}
async function importCompetition(
  store: PgCompetitionStore,
  snapshot: CompetitionSnapshot,
) {
  const preview = await store.preview(snapshot, 'staff'),
    key = randomUUID();
  const receipt = await store.apply(
    preview.previewToken,
    preview.expectedRevision,
    preview.scheduleRevision,
    key,
    'staff',
    'Staff',
    'admin',
    false,
  );
  return { preview, key, receipt };
}
test(
  'archival is explicit, ended-only, reversible and retains linked schedules, XP/results, receipts and immutable memberships',
  { skip: !process.env.TEST_DATABASE_URL },
  async () =>
    fixture(async (pool, lifecycle, scheduling, competitions, xp) => {
      const snapshot = skill(42).results!.xp!,
        preview = await xp.preview(snapshot, 'staff'),
        key = randomUUID();
      const receipt = await xp.apply(
        preview.previewToken,
        preview.expectedRevision,
        key,
        'staff',
        'Staff',
        false,
      );
      const activityImport = await importCompetition(
        competitions,
        activity(43),
      );
      await schedules(pool, 1, 3);
      await pool.query(
        "UPDATE collection_log_schedules SET starts_at=now()-interval '1 day',ends_at=now()+interval '1 day' WHERE id=$1",
        [sid(1)],
      );
      await pool.query(
        "UPDATE collection_log_schedules SET starts_at=now()+interval '1 day',ends_at=now()+interval '2 days' WHERE id=$1",
        [sid(2)],
      );
      await pool.query(
        'UPDATE wom_competitions SET schedule_id=$1,schedule_created=true WHERE competition_id=42',
        [sid(1)],
      );
      for (const id of [sid(1), sid(2)])
        await assert.rejects(
          lifecycle.change(
            'schedules',
            id,
            'archive',
            'Operator',
            reason,
            true,
          ),
          { status: 409 },
        );
      await assert.rejects(
        lifecycle.change('schedules', sid(3), 'archive', '', reason, true),
        { status: 400 },
      );
      const beforeSchedule = await lifecycle.detail('schedules', sid(3)),
        totals = await xp.tracker();
      const receiptsBefore = (
        await pool.query('SELECT * FROM xp_import_history ORDER BY id')
      ).rows;
      const competitionReceipts = (
        await pool.query('SELECT * FROM competition_import_history ORDER BY id')
      ).rows;
      const activityBefore = await lifecycle.detail('competitions', '43');
      assert.equal(
        (
          await lifecycle.change(
            'schedules',
            sid(3),
            'archive',
            'Operator',
            reason,
          )
        ).outcome,
        'eligible',
      );
      assert.deepEqual(
        await lifecycle.detail('schedules', sid(3)),
        beforeSchedule,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM lifecycle_archive_audit',
          )
        ).rows[0].n,
        0,
      );
      await lifecycle.change(
        'schedules',
        sid(3),
        'archive',
        'Operator',
        reason,
        true,
      );
      await lifecycle.change(
        'competitions',
        '42',
        'archive',
        'Operator',
        reason,
        true,
      );
      await lifecycle.change(
        'competitions',
        '43',
        'archive',
        'Operator',
        reason,
        true,
      );
      assert.equal((await scheduling.state()).schedules.length, 2);
      assert.equal((await competitions.activities()).competitions.length, 0);
      const afterTotals = await xp.tracker();
      assert.deepEqual({ ...afterTotals, revision: totals.revision }, totals);
      const historical = await lifecycle.detail('competitions', '42');
      assert.ok('xp' in historical);
      assert.equal(
        historical.xp.source_snapshot.event.gains.attack,
        '9007199254740993',
      );
      assert.equal(historical.linkedSchedule!.record.archived_at, null);
      assert.deepEqual(historical.linkedSchedule!.pageIds, ['p']);
      const activityAfter = await lifecycle.detail('competitions', '43');
      assert.deepEqual(
        { ...activityAfter.record, archived_at: null },
        activityBefore.record,
      );
      assert.equal(
        (await lifecycle.detail('schedules', sid(3))).record.id,
        sid(3),
      );
      await assert.rejects(
        pool.query(
          'DELETE FROM collection_log_schedule_pages WHERE schedule_id=$1',
          [sid(3)],
        ),
        { code: '55000' },
      );
      await assert.rejects(
        pool.query('DELETE FROM collection_log_schedules WHERE id=$1', [
          sid(3),
        ]),
        { code: '55000' },
      );
      await assert.rejects(
        pool.query(
          "UPDATE xp_events SET title='Lost evidence' WHERE competition_id=42",
        ),
        { code: '55000' },
      );
      await assert.rejects(competitions.preview(activity(43), 'staff'), {
        status: 409,
      });
      await assert.rejects(xp.preview(snapshot, 'staff'), { status: 409 });
      await pool.query('DELETE FROM xp_previews');
      await pool.query('DELETE FROM competition_previews');
      assert.deepEqual(
        await xp.apply(
          preview.previewToken,
          preview.expectedRevision,
          key,
          'staff',
          'Staff',
          false,
        ),
        receipt,
      );
      assert.deepEqual(
        await competitions.apply(
          activityImport.preview.previewToken,
          activityImport.preview.expectedRevision,
          activityImport.preview.scheduleRevision,
          activityImport.key,
          'staff',
          'Staff',
          'admin',
          false,
        ),
        activityImport.receipt,
      );
      assert.deepEqual(
        (await pool.query('SELECT * FROM xp_import_history ORDER BY id')).rows,
        receiptsBefore,
      );
      assert.deepEqual(
        (
          await pool.query(
            'SELECT * FROM competition_import_history ORDER BY id',
          )
        ).rows,
        competitionReceipts,
      );
      assert.equal(
        (
          await lifecycle.change(
            'competitions',
            '42',
            'archive',
            'Operator',
            reason,
            true,
          )
        ).outcome,
        'unchanged',
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM lifecycle_archive_audit',
          )
        ).rows[0].n,
        3,
      );
      await lifecycle.change(
        'competitions',
        '42',
        'restore',
        'Operator',
        'Correct the retained XP result',
        true,
      );
      assert.ok(await xp.preview(snapshot, 'staff'));
      await lifecycle.change(
        'schedules',
        sid(3),
        'restore',
        'Operator',
        'Inspect original window',
        true,
      );
      assert.deepEqual(
        await lifecycle.detail('schedules', sid(3)),
        beforeSchedule,
      );
      const client = await pool.connect();
      try {
        const evidence = await intakeScheduling(
          client,
          true,
          false,
          new Date(),
        );
        assert.equal(
          classifyCollection(evidence, 42, false).collectionType,
          'event',
        );
      } finally {
        client.release();
      }
    }),
);

test(
  '500/501 schedules and 1,999/2,000/2,001 identities retain history and recover slots through ended archival',
  { skip: !process.env.TEST_DATABASE_URL },
  async () =>
    fixture(async (pool, lifecycle, scheduling, competitions) => {
      await schedules(pool, 1, 500);
      assert.equal((await scheduling.state()).schedules.length, 500);
      const fields = {
        title: 'New schedule',
        startsAt: '2026-09-01T00:00:00.000Z',
        endsAt: '2026-09-08T00:00:00.000Z',
        pageIds: ['p'],
      };
      await assert.rejects(
        scheduling.save(
          fields,
          (await scheduling.state()).revision,
          'staff',
          'Staff',
        ),
        { status: 422 },
      );
      await schedules(pool, 501, 501);
      await assert.rejects(scheduling.state(), { status: 503 });
      assert.equal(
        (await lifecycle.list('schedules', 'current')).records.length,
        20,
      );
      await lifecycle.change(
        'schedules',
        sid(1),
        'archive',
        'Operator',
        reason,
        true,
      );
      assert.equal((await scheduling.state()).schedules.length, 500);
      await assert.rejects(
        lifecycle.change(
          'schedules',
          sid(1),
          'restore',
          'Operator',
          reason,
          true,
        ),
        { status: 409 },
      );
      await lifecycle.change(
        'schedules',
        sid(2),
        'archive',
        'Operator',
        reason,
        true,
      );
      assert.equal(
        (
          await scheduling.save(
            fields,
            (await scheduling.state()).revision,
            'staff',
            'Staff',
          )
        ).schedules.length,
        500,
      );
      await identities(pool, 1, 1999);
      assert.equal((await competitions.activities()).competitions.length, 1999);
      await identities(pool, 2000, 2000);
      assert.equal((await competitions.activities()).competitions.length, 2000);
      const source = skill(3000, '2099-09-08T00:00:00.000Z');
      delete source.results;
      source.lifecycle = 'running';
      await assert.rejects(competitions.preview(source, 'staff'), {
        status: 409,
      });
      await identities(pool, 2001, 2001);
      await assert.rejects(competitions.activities(), { status: 503 });
      await lifecycle.change(
        'competitions',
        '2001',
        'archive',
        'Operator',
        reason,
        true,
      );
      assert.equal((await competitions.activities()).competitions.length, 2000);
      await lifecycle.change(
        'competitions',
        '1',
        'archive',
        'Operator',
        reason,
        true,
      );
      await importCompetition(competitions, source);
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM wom_competitions WHERE archived_at IS NULL',
          )
        ).rows[0].n,
        2000,
      );
      await assert.rejects(
        lifecycle.change(
          'competitions',
          '1',
          'restore',
          'Operator',
          reason,
          true,
        ),
        { status: 409 },
      );
      assert.equal((await lifecycle.list('competitions')).records.length, 2);
      assert.equal(
        (await lifecycle.detail('competitions', '1')).record.title,
        'Competition 1',
      );
    }),
);

test(
  'archiving metadata never frees an all-time XP slot, including the unified apply path',
  { skip: !process.env.TEST_DATABASE_URL },
  async () =>
    fixture(async (pool, lifecycle, _scheduling, competitions, xp) => {
      await identities(pool, 1, 2000, 'SKILL');
      const snapshot = skill(1).results!.xp!;
      await pool.query(
        "INSERT INTO xp_events(competition_id,title,source_url,skills,gains,source_hash,source_snapshot) SELECT n,'XP','https://wiseoldman.net/competitions/' || n,'[\"attack\"]','{\"attack\":\"1\"}',repeat('a',64),$1::jsonb FROM generate_series(1,2000) n",
        [JSON.stringify({ ...snapshot, participants: [] })],
      );
      const totals = (await xp.tracker()).totals;
      await lifecycle.change(
        'competitions',
        '1',
        'archive',
        'Operator',
        reason,
        true,
      );
      assert.deepEqual((await xp.tracker()).totals, totals);
      assert.equal((await xp.tracker()).events.length, 2000);
      await assert.rejects(xp.preview(skill(3000).results!.xp!, 'staff'), {
        status: 409,
      });
      await assert.rejects(competitions.preview(skill(3000), 'staff'), {
        status: 409,
      });
      const metadata = skill(3000, '2099-09-08T00:00:00.000Z');
      delete metadata.results;
      const live = await importCompetition(competitions, metadata);
      const token = 'saved-capacity-preview',
        hash = createHash('sha256').update(token).digest('hex');
      await pool.query(
        "INSERT INTO competition_previews(token_hash,actor_id,expected_revision,schedule_revision,snapshot,page_ids,expires_at) VALUES($1,'staff',$2,$3,$4,'{}',now()+interval '1 minute')",
        [
          hash,
          live.receipt.revision,
          (await _scheduling.state()).revision,
          JSON.stringify(skill(3000)),
        ],
      );
      await assert.rejects(
        competitions.apply(
          token,
          live.receipt.revision,
          (await _scheduling.state()).revision,
          randomUUID(),
          'staff',
          'Staff',
          'admin',
          false,
        ),
        { status: 409 },
      );
      assert.equal(
        (await pool.query('SELECT count(*)::int AS n FROM xp_events')).rows[0]
          .n,
        2000,
      );
    }),
);

test(
  'archive races with scheduling/imports serialize without reopening or resurrecting historical records',
  { skip: !process.env.TEST_DATABASE_URL },
  async () =>
    fixture(async (pool, lifecycle, scheduling, competitions) => {
      await schedules(pool, 1, 1);
      const revision = (await scheduling.state()).revision;
      const attempts = await Promise.allSettled([
        lifecycle.change(
          'schedules',
          sid(1),
          'archive',
          'Operator',
          reason,
          true,
        ),
        scheduling.save(
          {
            title: 'Explicit staff extension',
            startsAt: '2026-09-01T00:00:00.000Z',
            endsAt: '2099-09-08T00:00:00.000Z',
            pageIds: ['p'],
          },
          revision,
          'staff',
          'Staff',
          sid(1),
        ),
      ]);
      assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 1);
      const row = (await lifecycle.detail('schedules', sid(1))).record;
      assert.ok(
        row.archived_at
          ? row.ends_at === '2026-09-08T00:00:00+00:00'
          : String(row.ends_at).startsWith('2099-'),
      );
      await importCompetition(competitions, activity(42));
      const refresh = activity(42);
      refresh.results!.participants[0]!.gained = '9';
      const preview = await competitions.preview(refresh, 'staff');
      const concurrent = await Promise.allSettled([
        lifecycle.change(
          'competitions',
          '42',
          'archive',
          'Operator',
          reason,
          true,
        ),
        competitions.apply(
          preview.previewToken,
          preview.expectedRevision,
          preview.scheduleRevision,
          randomUUID(),
          'staff',
          'Staff',
          'admin',
          false,
        ),
      ]);
      assert.equal(concurrent[0]!.status, 'fulfilled');
      const historical = await lifecycle.detail('competitions', '42');
      assert.ok(historical.record.archived_at);
      await assert.rejects(competitions.preview(refresh, 'staff'), {
        status: 409,
      });
      const cursor = (await lifecycle.list('competitions', 'current'))
        .pageCursor;
      await lifecycle.change(
        'competitions',
        '42',
        'restore',
        'Operator',
        reason,
        true,
      );
      await assert.rejects(lifecycle.list('competitions', 'current', cursor), {
        status: 409,
      });
    }),
);

test(
  'paged current/history seeks stay bounded past old caps and invalidation is transactional',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) =>
    fixture(async (pool, lifecycle) => {
      await identities(pool, 1, 10001, 'ACTIVITY', true);
      const first = await lifecycle.list('competitions'),
        seen: string[] = [],
        cursors: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await lifecycle.list('competitions', 'archived', cursor);
        seen.push(...page.records.map((r) => r.id));
        cursors.push(page.pageCursor);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      assert.deepEqual(
        seen,
        Array.from({ length: 10001 }, (_, n) => String(n + 1)),
      );
      for (const page of [500, 250, 0])
        assert.deepEqual(
          (
            await lifecycle.list('competitions', 'archived', cursors[page])
          ).records.map((r) => r.id),
          seen.slice(page * 20, page * 20 + 20),
        );
      await assert.rejects(
        lifecycle.list('competitions', 'current', first.nextCursor!),
        { status: 409 },
      );
      await assert.rejects(
        lifecycle.list('schedules', 'archived', first.nextCursor!),
        { status: 409 },
      );
      await assert.rejects(
        lifecycle.list('competitions', 'archived', first.nextCursor!, 1),
        { status: 409 },
      );
      await assert.rejects(lifecycle.list('competitions', 'archived', 'bad'), {
        status: 409,
      });
      const writer = await pool.connect();
      try {
        await writer.query('BEGIN');
        await writer.query(
          "INSERT INTO wom_competitions(competition_id,kind,title,source_url,metrics,skills,starts_at,ends_at) VALUES(20000,'ACTIVITY','Concurrent','https://wiseoldman.net/competitions/20000','[\"vardorvis\"]','[]','2026-09-01','2026-09-08')",
        );
        assert.equal(
          (await lifecycle.list('competitions', 'archived', first.nextCursor!))
            .revision,
          first.revision,
        );
        await writer.query('ROLLBACK');
        assert.equal(
          (await lifecycle.list('competitions', 'archived', first.pageCursor))
            .revision,
          first.revision,
        );
      } finally {
        await writer.query('ROLLBACK');
        writer.release();
      }
      await lifecycle.change(
        'competitions',
        '1',
        'restore',
        'Operator',
        reason,
        true,
      );
      await assert.rejects(
        lifecycle.list('competitions', 'archived', first.nextCursor!),
        { status: 409 },
      );
      await pool.query('ANALYZE wom_competitions');
      const plan = (
        await pool.query(
          'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT competition_id,title,ends_at FROM wom_competitions WHERE archived_at IS NOT NULL AND competition_id>9000 ORDER BY competition_id LIMIT 21',
        )
      ).rows[0]['QUERY PLAN'][0];
      assert.equal(
        plan.Plan.Plans[0]['Index Name'],
        'competitions_archived_page',
      );
      assert.equal(plan.Plan.Plans[0]['Actual Rows'], 21);
      assert.equal(plan.Plan.Plans[0]['Rows Removed by Filter'] ?? 0, 0);
      t.diagnostic(
        JSON.stringify({
          records: 10001,
          index: plan.Plan.Plans[0]['Index Name'],
          rows: 21,
          milliseconds: plan['Execution Time'],
          buffers:
            plan.Plan['Shared Hit Blocks'] + plan.Plan['Shared Read Blocks'],
        }),
      );
    }),
);

test(
  'archive deadlines are rechecked after locks and imports preserve an archived linked window',
  { skip: !process.env.TEST_DATABASE_URL },
  async () =>
    fixture(async (pool, lifecycle, _scheduling, competitions) => {
      await identities(pool, 1, 4);
      await pool.query(
        "UPDATE wom_competitions SET starts_at=now()-interval '1 hour',ends_at=now()+interval '1 hour' WHERE competition_id=1",
      );
      await pool.query(
        "UPDATE wom_competitions SET starts_at=now()+interval '1 hour',ends_at=now()+interval '2 hours' WHERE competition_id=2",
      );
      await pool.query(
        'UPDATE wom_competitions SET ends_at=clock_timestamp() WHERE competition_id=3',
      );
      for (const id of ['1', '2'])
        await assert.rejects(
          lifecycle.change(
            'competitions',
            id,
            'archive',
            'Operator',
            reason,
            true,
          ),
          { status: 409 },
        );
      assert.equal(
        (
          await lifecycle.change(
            'competitions',
            '3',
            'archive',
            'Operator',
            reason,
            true,
          )
        ).outcome,
        'applied',
      );
      const writer = await pool.connect();
      try {
        await writer.query('BEGIN');
        await writer.query(
          'SELECT singleton FROM collection_scheduling WHERE singleton FOR UPDATE',
        );
        const pending = lifecycle.change(
          'competitions',
          '4',
          'archive',
          'Operator',
          reason,
          true,
        );
        const rejected = assert.rejects(pending, { status: 409 });
        await writer.query(
          "UPDATE wom_competitions SET ends_at=now()+interval '1 day' WHERE competition_id=4",
        );
        await writer.query('COMMIT');
        await rejected;
        assert.equal(
          (await lifecycle.detail('competitions', '4')).record.archived_at,
          null,
        );
      } finally {
        await writer.query('ROLLBACK');
        writer.release();
      }
      await schedules(pool, 1, 1);
      await lifecycle.change(
        'schedules',
        sid(1),
        'archive',
        'Operator',
        reason,
        true,
      );
      await pool.query(
        'UPDATE wom_competitions SET schedule_id=$1,schedule_created=true WHERE competition_id=1',
        [sid(1)],
      );
      const record = (await lifecycle.detail('competitions', '1')).record;
      const source = activity(
        1,
        record.starts_at as string,
        record.ends_at as string,
      );
      delete source.results;
      source.lifecycle = 'running';
      const imported = await importCompetition(competitions, source);
      assert.equal(imported.preview.action, 'preserve-deletion');
      assert.ok(
        imported.preview.warnings.some((warning) =>
          warning.includes('archived and retained'),
        ),
      );
      assert.ok(
        imported.preview.warnings.every(
          (warning) => !warning.includes('deleted'),
        ),
      );
      const retained = await lifecycle.detail('schedules', sid(1));
      assert.ok(retained.record.archived_at);
      assert.deepEqual(retained.pageIds, ['p']);
    }),
);

test(
  'private historical routes require an administrator and preserve bounded contracts and detail evidence',
  { skip: !process.env.TEST_DATABASE_URL },
  async () =>
    fixture(async (pool, lifecycle) => {
      const backend = new PgStore(pool),
        password = 'lifecycle-local-test-password';
      await backend.ensureDefaultAdmin(await hashPassword(password));
      await pool.query('UPDATE staff_accounts SET must_change_password=false');
      await identities(pool, 1, 25, 'ACTIVITY', true);
      const app = createApp(undefined, undefined, {
        store: backend,
        lifecycle,
        auth: {
          origin: 'https://clog.example.com',
          secret: 'a'.repeat(64),
          secure: true,
        },
        logger: false,
      });
      try {
        const path = '/api/v1/admin/lifecycle/competitions';
        assert.equal((await app.inject(path)).statusCode, 401);
        const login = await app.inject({
          url: '/api/v1/auth/login',
          method: 'POST',
          headers: { origin: 'https://clog.example.com' },
          payload: { username: 'admin', password },
        });
        const cookie = String(login.headers['set-cookie']).split(';')[0]!;
        const first = await app.inject({ url: path, headers: { cookie } });
        assert.equal(first.statusCode, 200);
        assert.equal(first.headers['cache-control'], 'no-store');
        assert.equal(first.json().records.length, 20);
        const next = await app.inject({
          url: path + '?cursor=' + first.json().nextCursor,
          headers: { cookie },
        });
        assert.equal(next.json().records.length, 5);
        assert.equal(
          (await app.inject({ url: path + '/1', headers: { cookie } })).json()
            .record.title,
          'Competition 1',
        );
        assert.equal(
          (await app.inject({ url: path + '?limit=21', headers: { cookie } }))
            .statusCode,
          400,
        );
        assert.equal(
          (await app.inject({ url: path + '?cursor=bad', headers: { cookie } }))
            .statusCode,
          409,
        );
        await pool.query("UPDATE staff_accounts SET role='moderator'");
        assert.equal(
          (await app.inject({ url: path, headers: { cookie } })).statusCode,
          403,
        );
      } finally {
        await app.close();
      }
    }),
);
