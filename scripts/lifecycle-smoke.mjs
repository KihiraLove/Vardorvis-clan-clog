/** Owner CLI / restricted-runtime acceptance on the disposable production stack. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { PgLifecycleStore } from './packages/database/dist/lifecycle.js';
import { PgXpStore } from './apps/api/dist/xp-store.js';
import { PgSchedulingStore } from './apps/api/dist/scheduling-store.js';
const plain = (value) => JSON.parse(JSON.stringify(value));
if (process.env.LIFECYCLE_SMOKE_DISPOSABLE !== 'true')
  throw new Error('Disposable stack only.');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const lifecycle = new PgLifecycleStore(pool),
  xp = new PgXpStore(pool),
  scheduling = new PgSchedulingStore(pool);
const file = '/tmp/lifecycle-smoke.json';
try {
  assert.equal(
    (await pool.query('SELECT current_user AS role')).rows[0].role,
    'clog_runtime',
  );
  if (process.argv[2] === 'seed') {
    const page = (
      await pool.query('SELECT id FROM pages WHERE active ORDER BY id LIMIT 1')
    ).rows[0].id;
    const before = await scheduling.state();
    const saved = await scheduling.save(
      {
        title: 'Ended archival fixture',
        startsAt: '2026-09-01T00:00:00.000Z',
        endsAt: '2026-09-08T00:00:00.000Z',
        pageIds: [page],
      },
      before.revision,
      'fixture',
      'Fixture staff',
    );
    const scheduleId = saved.schedules.find(
      (row) => !before.schedules.some((old) => old.id === row.id),
    ).id;
    const retained = {
      scheduleId,
      schedules: before.schedules,
      schedule: await lifecycle.detail('schedules', scheduleId),
      skill: await lifecycle.detail('competitions', '900004'),
      activity: await lifecycle.detail('competitions', '900005'),
      xp: await xp.tracker(),
      receipts: (
        await pool.query('SELECT * FROM xp_import_history ORDER BY id')
      ).rows,
      competitionReceipts: (
        await pool.query('SELECT * FROM competition_import_history ORDER BY id')
      ).rows,
    };
    assert.ok(
      retained.receipts.length < 20 && retained.competitionReceipts.length < 20,
    );
    assert.equal(retained.skill.record.archived_at, null);
    const revision = (await lifecycle.list('competitions')).revision;
    await assert.rejects(
      lifecycle.change(
        'competitions',
        '900005',
        'archive',
        'Runtime',
        'Must roll back without an owner audit grant',
        true,
      ),
      { code: '42501' },
    );
    assert.equal((await lifecycle.list('competitions')).revision, revision);
    assert.deepEqual(
      await lifecycle.detail('competitions', '900005'),
      retained.activity,
    );
    const privileges = (
      await pool.query(
        "SELECT has_table_privilege(current_user,'lifecycle_archive_audit','SELECT') AS read,has_table_privilege(current_user,'lifecycle_archive_audit','INSERT') AS append,has_table_privilege(current_user,'lifecycle_archive_audit','UPDATE') AS edit,has_table_privilege(current_user,'lifecycle_archive_audit','DELETE') AS remove",
      )
    ).rows[0];
    assert.deepEqual(privileges, {
      read: true,
      append: false,
      edit: false,
      remove: false,
    });
    await writeFile(file, JSON.stringify(retained));
    console.log(JSON.stringify({ scheduleId }));
  } else {
    const before = JSON.parse(await readFile(file, 'utf8'));
    const skill = await lifecycle.detail('competitions', '900004');
    assert.ok(skill.record.archived_at);
    assert.deepEqual(
      { ...skill.record, archived_at: null },
      before.skill.record,
    );
    assert.deepEqual(skill.xp, before.skill.xp);
    const current = await xp.tracker();
    assert.deepEqual({ ...current, revision: before.xp.revision }, before.xp);
    assert.deepEqual((await scheduling.state()).schedules, before.schedules);
    const schedule = await lifecycle.detail('schedules', before.scheduleId);
    assert.ok(schedule.record.archived_at);
    assert.deepEqual(schedule.pageIds, before.schedule.pageIds);
    assert.deepEqual(
      plain(
        (await pool.query('SELECT * FROM xp_import_history ORDER BY id')).rows,
      ),
      before.receipts,
    );
    assert.deepEqual(
      plain(
        (
          await pool.query(
            'SELECT * FROM competition_import_history ORDER BY id',
          )
        ).rows,
      ),
      before.competitionReceipts,
    );
    const response = await fetch(
      'http://127.0.0.1:8080/api/v1/competitions/activities',
    );
    const ids = (await response.json()).competitions.map((row) => row.id);
    assert.equal(ids.includes(900005), process.argv[2] === 'restored');
    assert.equal(
      (await fetch('http://127.0.0.1:8080/api/v1/admin/lifecycle/competitions'))
        .status,
      401,
    );
    const journal = (
      await pool.query(
        'SELECT action,actor_name,reason,old_values,new_values FROM lifecycle_archive_audit ORDER BY created_at,id',
      )
    ).rows;
    assert.equal(journal.length, process.argv[2] === 'restored' ? 4 : 3);
    assert.ok(
      journal.every(
        (row) => row.actor_name === 'Smoke operator' && row.reason.length > 0,
      ),
    );
    assert.equal(
      (await lifecycle.list('competitions')).records.length,
      process.argv[2] === 'restored' ? 1 : 2,
    );
    await assert.rejects(
      pool.query(
        'DELETE FROM collection_log_schedule_pages WHERE schedule_id=$1',
        [before.scheduleId],
      ),
      { code: '55000' },
    );
    console.log(
      'Historical reads, owner archival/restore, runtime denial, retained XP, schedules and receipts passed.',
    );
  }
} finally {
  await pool.end();
}
