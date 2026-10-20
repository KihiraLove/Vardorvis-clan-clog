/** Exercise compatible imports and weighted/multi-metric reconciliation on the release baseline. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { migrate } from '@clog/database/dist/migrate.js';
import { PgCompetitionStore } from './competition-store.js';
import { PgSchedulingStore } from './scheduling-store.js';
import { PgXpStore } from './xp-store.js';
import { fetchCompetition } from './competition-wom.js';
import type { CompetitionMetric } from '@clog/domain';

test(
  'fresh baseline supports compatible imports and every WOM metric type',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    const root = new pg.Pool({ connectionString: url.href });
    const schema = 'multi_wom_' + randomUUID().replaceAll('-', '');
    await root.query('CREATE SCHEMA ' + schema);
    url.searchParams.set('options', '-c search_path=' + schema);
    const pool = new pg.Pool({ connectionString: url.href });
    t.after(async () => {
      await pool.end();
      await root.query('DROP SCHEMA ' + schema + ' CASCADE');
      await root.end();
    });
    await migrate(url.href);
    await pool.query(
      `INSERT INTO wom_competitions(competition_id,kind,title,source_url,metrics,skills,starts_at,ends_at,results_imported_at,activity_results,source_hash,archived_at)
    VALUES(8000,'ACTIVITY','Archived legacy','https://wiseoldman.net/competitions/8000','["vardorvis"]','[]',now()-interval '3 days',now()-interval '2 days',now(),
      '[{"playerId":1,"displayName":"Old player","gained":"10"}]',$1,now()),
    (8001,'ACTIVITY','Legacy results','https://wiseoldman.net/competitions/8001','["zulrah"]','[]',now()-interval '3 days',now()-interval '2 days',now(),
      '[{"playerId":1,"displayName":"Fewer kills","gained":"5"},{"playerId":2,"displayName":"More kills","gained":"10"}]',$1,NULL)`,
      ['a'.repeat(64)],
    );
    const before = (
      await pool.query(
        'SELECT to_jsonb(c) AS row FROM wom_competitions c ORDER BY competition_id',
      )
    ).rows;
    const imports = new PgCompetitionStore(pool),
      xp = new PgXpStore(pool),
      schedules = new PgSchedulingStore(pool);
    const now = await imports.clock(),
      day = 86400000;
    const snapshot = (
      id: number,
      metrics: CompetitionMetric[],
      values: { id: number; name: string; gains: Record<string, string> }[],
      future = false,
    ) =>
      fetchCompetition(
        'https://wiseoldman.net/competitions/' + id,
        now,
        async () =>
          Response.json({
            id,
            title: 'Competition ' + id,
            metrics,
            startsAt: new Date(now + (future ? day : -3 * day)).toISOString(),
            endsAt: new Date(now + (future ? 2 * day : -day)).toISOString(),
            updatedAt: new Date(now).toISOString(),
            participantCount: values.length,
            participations: values.map((p) => ({
              playerId: p.id,
              player: { displayName: p.name },
              deltas: Object.entries(p.gains).map(([metric, gained]) => ({
                metric,
                values: { gained },
              })),
            })),
          }),
      );
    type Preview = Awaited<ReturnType<typeof imports.preview>>;
    const apply = (p: Preview) =>
      imports.apply(
        p.previewToken,
        p.expectedRevision,
        p.scheduleRevision,
        randomUUID(),
        'staff',
        'Staff',
        'admin',
        true,
      );

    await t.test(
      'repeated startup preserves current and archived imports without creating import history',
      async () => {
        await migrate(url.href);
        await migrate(url.href);
        assert.deepEqual(
          (
            await pool.query(
              'SELECT to_jsonb(c) AS row FROM wom_competitions c ORDER BY competition_id',
            )
          ).rows,
          before,
        );
        assert.deepEqual(
          (
            await pool.query('SELECT name FROM schema_migrations ORDER BY name')
          ).rows.map((r) => r.name),
          ['001_baseline.sql', '002_custom_competition_metrics.sql'],
        );
        const publicRows = await imports.activities();
        assert.equal(publicRows.competitions.length, 1);
        assert.equal(publicRows.competitions[0]?.title, 'Legacy results');
        assert.equal(publicRows.competitions[0]?.standings, undefined);
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::int AS count FROM competition_import_history',
            )
          ).rows[0].count,
          0,
        );
      },
    );
    await pool.query(
      "INSERT INTO pages(id,category,name,sort_order) VALUES('vardorvis','bosses','Vardorvis',0),('zulrah','bosses','Zulrah',1),('shared_treasure_trail_rewards','clues','Shared clues',0),('hard_treasure_trails','clues','Hard clues',1),('elite_treasure_trails','clues','Elite clues',2)",
    );

    await t.test(
      'multi-boss imports suggest a union and preserve staff edits and deliberate schedule deletion',
      async () => {
        const s = await snapshot(
          8100,
          [
            { metric: 'vardorvis', weight: '0.5' },
            { metric: 'zulrah', weight: '2' },
          ],
          [],
          true,
        );
        const p = await imports.preview(s, 'staff');
        assert.deepEqual(p.pageIds, ['vardorvis', 'zulrah']);
        const receipt = await apply(p);
        assert.ok(receipt.scheduleId);
        let state = await schedules.state();
        const saved = state.schedules.find((s) => s.id === receipt.scheduleId)!;
        await schedules.save(
          {
            title: 'Staff edit',
            startsAt: saved.startsAt,
            endsAt: saved.endsAt,
            pageIds: ['zulrah'],
          },
          state.revision,
          'staff',
          'Staff',
          saved.id,
        );
        const again = await imports.preview(s, 'staff');
        assert.equal(again.action, 'preserve-schedule');
        assert.deepEqual(again.pageIds, ['zulrah']);
        await apply(again);
        state = await schedules.state();
        assert.equal(state.schedules[0]?.title, 'Staff edit');
        await schedules.remove(saved.id, state.revision, 'staff', 'Staff');
        const deleted = await imports.preview(s, 'staff');
        assert.equal(deleted.action, 'preserve-deletion');
        await apply(deleted);
        assert.equal((await schedules.state()).schedules.length, 0);
      },
    );
    await t.test(
      'multi-activity mappings deduplicate shared pages',
      async () => {
        const s = await snapshot(
          8101,
          [
            { metric: 'clue_scrolls_hard', weight: '1' },
            { metric: 'clue_scrolls_elite', weight: '1' },
          ],
          [],
          true,
        );
        const p = await imports.preview(s, 'staff');
        assert.equal(
          p.pageIds.filter((id) => id === 'shared_treasure_trail_rewards')
            .length,
          1,
        );
        assert.ok(p.pageIds.includes('hard_treasure_trails'));
        assert.ok(p.pageIds.includes('elite_treasure_trails'));
      },
    );
    await t.test(
      'computed competitions import live metadata without requiring pages and finished decimal results without XP',
      async () => {
        const metrics = [
          { metric: 'ehp', weight: '1' },
          { metric: 'ehb', weight: '1' },
        ];
        const live = await imports.preview(
          await snapshot(8102, metrics, [], true),
          'staff',
        );
        assert.equal(live.action, 'import-metadata');
        assert.deepEqual(live.pageIds, []);
        await apply(live);
        const p = await imports.preview(
          await snapshot(8103, metrics, [
            {
              id: 5,
              name: 'Efficient',
              gains: { ehp: '1.25', ehb: '2.5', total: '3.75' },
            },
          ]),
          'staff',
        );
        assert.deepEqual(p.changes, []);
        assert.equal(p.standings?.[0]?.gained, '3.75');
        await apply(p);
        assert.equal((await xp.tracker()).events.length, 0);
        const shown = (
          await pool.query(
            'SELECT competition_results AS standings FROM wom_competitions WHERE competition_id=8103',
          )
        ).rows[0];
        assert.equal(shown.standings?.[0]?.gained, '3.75');
        assert.equal(shown.standings?.[0]?.deltas?.length, 3);
      },
    );
    await t.test(
      'weighted skill imports reconcile both protocols, publish WOM standings and never inflate raw XP',
      async () => {
        const metrics = [
          { metric: 'attack', weight: '0.25' },
          { metric: 'fishing', weight: '2' },
        ];
        const players = [
          {
            id: 2,
            name: 'Weighted winner',
            gains: { attack: '0', fishing: '20', total: '40' },
          },
          {
            id: 1,
            name: 'Most XP',
            gains: { attack: '100', fishing: '0', total: '25' },
          },
        ];
        const s = await snapshot(8104, metrics, players);
        const legacy = await xp.preview(s.results!.xp!, 'staff');
        await xp.apply(
          legacy.previewToken,
          legacy.expectedRevision,
          randomUUID(),
          'staff',
          'Staff',
          true,
        );
        const p = await imports.preview(s, 'staff');
        assert.equal((await apply(p)).outcome, 'unchanged');
        let tracker = await xp.tracker();
        assert.equal(tracker.totals.attack, '100');
        assert.equal(tracker.totals.fishing, '20');
        assert.equal(
          tracker.events[0]?.competition?.standings?.[0]?.displayName,
          'Weighted winner',
        );
        assert.equal(tracker.podium?.[0]?.displayName, 'Most XP');
        const corrected = await snapshot(
          8104,
          [
            { metric: 'attack', weight: '0.5' },
            { metric: 'fishing', weight: '2' },
          ],
          players,
        );
        const changed = await imports.preview(corrected, 'staff');
        assert.ok(changed.changes.every((c) => c.change === '0'));
        assert.equal((await apply(changed)).outcome, 'applied');
        tracker = await xp.tracker();
        assert.equal(tracker.totals.attack, '100');
        assert.equal(
          tracker.events[0]?.competition?.metricDefinitions?.[0]?.weight,
          '0.5',
        );
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::int AS count FROM xp_events WHERE competition_id=8104',
            )
          ).rows[0].count,
          1,
        );
      },
    );
    await t.test(
      'The Fractured Archive imports final results without catalog data and schedules future/running Activity competitions',
      async () => {
        const metric = 'the_fractured_archive';
        const metrics = [{ metric, weight: '1' }];
        const xpBefore = await xp.tracker();
        const finished = await snapshot(8110, metrics, [
          { id: 10, name: 'Archive winner', gains: { [metric]: '25' } },
        ]);
        const results = await imports.preview(finished, 'staff');
        assert.equal(results.competition.kind, 'ACTIVITY');
        assert.equal(results.action, 'import-results');
        assert.deepEqual(results.pageIds, []);
        assert.deepEqual(results.changes, []);
        assert.equal(results.standings?.[0]?.gained, '25');
        assert.equal((await apply(results)).scheduleId, null);
        assert.equal(
          (await apply(await imports.preview(finished, 'staff'))).outcome,
          'unchanged',
        );
        const xpAfter = await xp.tracker();
        assert.deepEqual(xpAfter.totals, xpBefore.totals);
        assert.deepEqual(xpAfter.events, xpBefore.events);
        assert.deepEqual(xpAfter.podium, xpBefore.podium);
        const activities = await imports.activities();
        assert.deepEqual(
          activities.competitions.find((c) => c.id === 8110)?.metrics,
          [metric],
        );

        // Older catalogs can still select an existing active page explicitly.
        const future = await snapshot(8111, metrics, [], true);
        const missing = await imports.preview(future, 'staff');
        assert.deepEqual(missing.pageIds, []);
        assert.ok(
          missing.warnings.some((w) =>
            w.includes('mapped pages are unavailable'),
          ),
        );
        await assert.rejects(apply(missing), { status: 422 });
        const manual = await imports.preview(future, 'staff', ['vardorvis']);
        assert.ok((await apply(manual)).scheduleId);

        await pool.query(
          "INSERT INTO pages(id,category,name,sort_order) VALUES('the_fractured_archive','raids','The Fractured Archive',0)",
        );
        for (const [id, running] of [
          [8112, false],
          [8113, true],
        ] as const) {
          const s = await snapshot(id, metrics, [], true);
          if (running)
            s.competition.startsAt = new Date(now - day).toISOString();
          const p = await imports.preview(s, 'staff');
          assert.equal(p.lifecycle, running ? 'running' : 'future');
          assert.equal(p.action, 'create-schedule');
          assert.deepEqual(p.pageIds, [metric]);
          const receipt = await apply(p);
          const saved = (await schedules.state()).schedules.find(
            (s) => s.id === receipt.scheduleId,
          )!;
          assert.deepEqual(saved.pageIds, [metric]);
          assert.equal(saved.endsAt, s.competition.endsAt);
          if (running) assert.ok(Date.parse(saved.startsAt) >= now);
          else assert.equal(saved.startsAt, s.competition.startsAt);
        }
      },
    );
  },
);
