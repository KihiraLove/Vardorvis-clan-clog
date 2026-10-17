import { databaseUrl as runtimeDatabaseUrl } from '@clog/database/dist/secrets.js';
/** Controlled fixtures for an isolated Compose project only; never run against clan data. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PgCompetitionStore } from '../apps/api/dist/competition-store.js';
import { fetchCompetition } from '../apps/api/dist/competition-wom.js';
import { PgXpStore } from '../apps/api/dist/xp-store.js';
import {
  PgSchedulingStore,
  lockScheduling,
  requireScheduledItem,
} from '../apps/api/dist/scheduling-store.js';
if (process.env.COMPETITION_SMOKE_DISPOSABLE !== 'true')
  throw new Error(
    'Set COMPETITION_SMOKE_DISPOSABLE=true only for an isolated disposable database.',
  );
const pool = new pg.Pool({
    connectionString: runtimeDatabaseUrl(
      process.env,
      process.env.POSTGRES_PASSWORD_FILE ? 'owner' : 'runtime',
    ),
  }),
  store = new PgCompetitionStore(pool),
  xp = new PgXpStore(pool),
  scheduling = new PgSchedulingStore(pool);
try {
  const privileges = (
    await pool.query(
      "SELECT current_user AS role,has_table_privilege(current_user,'competition_import_history','INSERT') AS insert,has_table_privilege(current_user,'competition_import_history','UPDATE') AS update,has_table_privilege(current_user,'competition_import_history','DELETE') AS delete",
    )
  ).rows[0];
  assert.equal(privileges.role, 'clog_runtime');
  assert.equal(privileges.insert, true);
  assert.equal(privileges.update, false);
  assert.equal(privileges.delete, false);
  assert.equal(
    (await pool.query('SELECT count(*)::int AS count FROM wom_competitions'))
      .rows[0].count,
    0,
    'requires an empty isolated fixture database',
  );
  const now = await store.clock(),
    day = 86400000;
  const source = (id, metric, start, end) => ({
    id,
    title: 'WOM smoke ' + id,
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(end).toISOString(),
    updatedAt: new Date(now).toISOString(),
    metrics: [{ metric }],
    participantCount: 2,
    participations: [
      {
        playerId: 1,
        player: { displayName: 'Fixture Winner' },
        deltas: [{ metric, values: { gained: '9007199254740993' } }],
      },
      {
        playerId: 2,
        player: { displayName: 'Fixture Zero' },
        deltas: [{ metric, values: { gained: 0 } }],
      },
    ],
  });
  const importFixture = async (id, kind, start, end) => {
    const snapshot = await fetchCompetition(
      'https://wiseoldman.net/competitions/' + id,
      now,
      async () =>
        Response.json(
          source(id, kind === 'SKILL' ? 'attack' : 'vardorvis', start, end),
        ),
    );
    const preview = await store.preview(snapshot, 'fixture-staff'),
      key = randomUUID();
    const receipt = await store.apply(
      preview.previewToken,
      preview.expectedRevision,
      preview.scheduleRevision,
      key,
      'fixture-staff',
      'Fixture Staff',
      'admin',
      false,
    );
    if (kind === 'SKILL') {
      assert.deepEqual(preview.pageIds, []);
      assert.deepEqual(preview.pages, []);
      assert.equal(receipt.scheduleId, null);
      if (snapshot.lifecycle !== 'finished')
        assert.equal(preview.action, 'import-metadata');
    }
    assert.deepEqual(
      await store.apply(
        preview.previewToken,
        preview.expectedRevision,
        preview.scheduleRevision,
        key,
        'fixture-staff',
        'Fixture Staff',
        'admin',
        false,
      ),
      receipt,
    );
    return { snapshot, preview, receipt };
  };
  const future = await importFixture(
      900001,
      'ACTIVITY',
      now + day,
      now + 2 * day,
    ),
    running = await importFixture(900002, 'ACTIVITY', now - day, now + day);
  await importFixture(900003, 'SKILL', now + day, now + 2 * day);
  await importFixture(900004, 'SKILL', now - 2 * day, now - day);
  await importFixture(900005, 'ACTIVITY', now - 2 * day, now - day);
  let state = await scheduling.state();
  assert.equal(state.enabled, false);
  assert.equal(state.schedules.length, 2);
  assert.equal(
    state.schedules.find((s) => s.id === future.receipt.scheduleId).startsAt,
    future.snapshot.competition.startsAt,
  );
  assert.ok(
    Date.parse(
      state.schedules.find((s) => s.id === running.receipt.scheduleId).startsAt,
    ) >= now,
  );
  const live = (
    await pool.query(
      'SELECT * FROM wom_competitions WHERE competition_id BETWEEN 900001 AND 900003',
    )
  ).rows;
  for (const c of live) {
    assert.equal(c.activity_results, null);
    assert.equal(c.results_imported_at, null);
  }
  const previews = (
    await pool.query(
      "SELECT snapshot FROM competition_previews WHERE snapshot->'competition'->>'id' IN ('900001','900002','900003')",
    )
  ).rows;
  assert.equal(JSON.stringify(previews).includes('participants'), false);
  const tracker = await xp.tracker();
  assert.equal(tracker.totals.attack, '9007199254740993');
  assert.equal(tracker.podium[0].displayName, 'Fixture Winner');
  assert.equal(tracker.events.length, 2);
  assert.equal(
    tracker.events.some((e) => e.id === 900005),
    false,
  );
  state = await scheduling.setEnabled(
    true,
    state.revision,
    'fixture-staff',
    'Fixture Staff',
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const enabled = await lockScheduling(client);
    const shared = (
      await client.query(
        "SELECT a.item_id FROM page_items a JOIN page_items b ON a.item_id=b.item_id WHERE a.page_id='vardorvis' AND b.page_id='the_whisperer' LIMIT 1",
      )
    ).rows[0];
    assert.ok(shared, 'catalog shared item fixture');
    await requireScheduledItem(client, enabled, shared.item_id);
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  const response = await fetch(
    'http://127.0.0.1:8080/api/v1/competitions/activities',
  );
  assert.equal(response.status, 200);
  const activities = await response.json();
  assert.deepEqual(
    activities.competitions.map((c) => c.id),
    [900001, 900002, 900005],
  );
  assert.equal(JSON.stringify(activities).includes('Fixture Winner'), false);
  await scheduling.setEnabled(
    false,
    state.revision,
    'fixture-staff',
    'Fixture Staff',
  );
  console.log(
    'Restricted-role competition imports, metadata privacy, exact podium, stable retries, schedules, shared items and public viewer passed.',
  );
} finally {
  await pool.end();
}
