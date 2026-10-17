import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { PgCompetitionStore } from './competition-store.js';
import { PgSchedulingStore } from './scheduling-store.js';
import { PgXpStore } from './xp-store.js';
import { fetchCompetition } from './competition-wom.js';

test(
  'SKILL metadata imports never open pages and preserve lifecycle, receipts, staff schedules and final XP reconciliation',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const connectionString = process.env.TEST_DATABASE_URL!;
    const root = new pg.Pool({ connectionString });
    const schema = 'skill_metadata_' + randomUUID().replaceAll('-', '');
    await root.query('CREATE SCHEMA ' + schema);
    const pool = new pg.Pool({
      connectionString,
      options: '-c search_path=' + schema,
    });
    const store = new PgCompetitionStore(pool),
      schedules = new PgSchedulingStore(pool),
      xp = new PgXpStore(pool);
    const now = await store.clock(),
      day = 86400000;
    const snapshot = (
      id: number,
      start: number,
      end: number,
      gained = '9007199254740993',
      metric = 'attack',
    ) =>
      fetchCompetition(
        'https://wiseoldman.net/competitions/' + id,
        now,
        async () =>
          Response.json({
            id,
            title: 'Event ' + id,
            metrics: [{ metric }],
            startsAt: new Date(start).toISOString(),
            endsAt: new Date(end).toISOString(),
            updatedAt: new Date(now).toISOString(),
            participantCount: 1,
            participations: [
              {
                playerId: 1,
                player: { displayName: 'Player One' },
                deltas: [{ metric, values: { gained } }],
              },
            ],
          }),
      );
    type Preview = Awaited<ReturnType<typeof store.preview>>;
    const preview = (s: Awaited<ReturnType<typeof snapshot>>) =>
      store.preview(s, 'actor');
    const apply = (
      p: Preview,
      key = randomUUID(),
      role: 'admin' | 'moderator' = 'moderator',
      ack = false,
      actor = 'actor',
    ) =>
      store.apply(
        p.previewToken,
        p.expectedRevision,
        p.scheduleRevision,
        key,
        actor,
        'Staff',
        role,
        ack,
      );
    const updatePreview = (p: Preview, field: string, value: string) =>
      pool.query(
        "UPDATE competition_previews SET snapshot=jsonb_set(snapshot,ARRAY['competition',$1],to_jsonb($2::text)) WHERE token_hash=encode(sha256($3::bytea),'hex')",
        [field, value, p.previewToken],
      );
    try {
      const migrations = new URL(
        '../../../packages/database/migrations/',
        import.meta.url,
      );
      for (const file of (await readdir(migrations))
        .filter((name) => name.endsWith('.sql'))
        .sort())
        await pool.query(await readFile(new URL(file, migrations), 'utf8'));
      await pool.query(
        "INSERT INTO pages(id,name,category,sort_order) VALUES('staff-page','Staff page','bosses',0)",
      );
      await t.test(
        'future and running metadata is page-free, moderator-accessible and publicly unavailable until results',
        async () => {
          const before = await schedules.state();
          for (const [id, start] of [
            [801, now + day],
            [802, now - day],
          ]) {
            const s = await snapshot(id!, start!, now + 2 * day),
              p = await preview(s);
            assert.equal(p.action, 'import-metadata');
            assert.deepEqual(p.pageIds, []);
            assert.deepEqual(p.pages, []);
            assert.deepEqual(p.participants, []);
            assert.deepEqual(p.changes, []);
            assert.equal(p.scheduleStartsAt, null);
            assert.equal((await apply(p)).scheduleId, null);
            assert.deepEqual(await schedules.state(), before);
            const row = (
              await pool.query(
                'SELECT * FROM wom_competitions WHERE competition_id=$1',
                [id],
              )
            ).rows[0];
            assert.equal(row.schedule_id, null);
            assert.equal(row.schedule_created, false);
            assert.equal(row.starts_at.toISOString(), s.competition.startsAt);
            assert.equal(row.ends_at.toISOString(), s.competition.endsAt);
            assert.equal(row.results_imported_at, null);
            assert.equal(row.activity_results, null);
          }
          const tracker = await xp.tracker();
          assert.equal(tracker.totals.attack, '0');
          assert.deepEqual(tracker.podium, []);
          assert.equal(tracker.events.length, 2);
          for (const e of tracker.events) {
            assert.equal(e.gains.attack, null);
            assert.deepEqual(e.podium, []);
          }
          assert.equal(
            (await pool.query('SELECT count(*)::int AS count FROM xp_events'))
              .rows[0].count,
            0,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int AS count FROM collection_schedule_audit',
              )
            ).rows[0].count,
            0,
          );
          await assert.rejects(
            store.preview(
              await snapshot(803, now + day, now + 2 * day),
              'actor',
              ['staff-page'],
            ),
            { status: 422 },
          );
        },
      );
      await t.test(
        'concurrent identical applies and replay after expiry return one durable metadata receipt',
        async () => {
          const s = await snapshot(803, now + day, now + 2 * day),
            p = await preview(s),
            key = randomUUID();
          const receipts = await Promise.all([
            apply(p, key),
            apply(p, key),
            apply(p, key),
          ]);
          assert.deepEqual(receipts[1], receipts[0]);
          assert.deepEqual(receipts[2], receipts[0]);
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int AS count FROM competition_import_history WHERE competition_id=803',
              )
            ).rows[0].count,
            1,
          );
          await pool.query(
            "UPDATE competition_previews SET expires_at=now()-interval '1 hour' WHERE token_hash=encode(sha256($1::bytea),'hex')",
            [p.previewToken],
          );
          await updatePreview(p, 'endsAt', new Date(now - 1).toISOString());
          assert.deepEqual(await apply(p, key), receipts[0]);
          await assert.rejects(apply(p, key, 'moderator', true), {
            status: 409,
          });
          assert.equal((await apply(await preview(s))).outcome, 'unchanged');
        },
      );
      await t.test(
        'future to running remains metadata-only; crossing the end requires a fresh preview',
        async () => {
          const before = await schedules.state();
          const p = await preview(
            await snapshot(804, now + day, now + 2 * day),
          );
          await updatePreview(p, 'startsAt', new Date(now - day).toISOString());
          assert.equal((await apply(p)).scheduleId, null);
          assert.deepEqual(await schedules.state(), before);
          assert.equal(
            (
              await pool.query(
                "SELECT new_values->>'lifecycle' AS lifecycle,new_values->>'action' AS action FROM competition_import_history WHERE competition_id=804",
              )
            ).rows[0].lifecycle,
            'running',
          );
          const ended = await preview(
            await snapshot(805, now - day, now + day),
          );
          await updatePreview(ended, 'endsAt', new Date(now - 1).toISOString());
          await assert.rejects(apply(ended), { status: 409 });
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM wom_competitions WHERE competition_id=805',
              )
            ).rowCount,
            0,
          );
          assert.equal((await xp.tracker()).totals.attack, '0');
        },
      );
      await t.test(
        'finished XP is staff-accessible, exact, credited once and correction-acknowledged; activity is isolated',
        async () => {
          const finished = await snapshot(804, now - day, now - 1),
            p = await preview(finished),
            key = randomUUID();
          const receipt = await apply(p, key, 'moderator');
          assert.equal(receipt.scheduleId, null);
          assert.equal((await xp.tracker()).totals.attack, '9007199254740993');
          await pool.query(
            "UPDATE competition_previews SET expires_at=now()-interval '1 hour' WHERE token_hash=encode(sha256($1::bytea),'hex')",
            [p.previewToken],
          );
          assert.deepEqual(await apply(p, key, 'admin'), receipt);
          assert.deepEqual(await apply(p, key, 'moderator'), receipt);
          assert.equal(
            (await apply(await preview(finished), randomUUID(), 'admin'))
              .outcome,
            'unchanged',
          );
          const correction = await preview(
            await snapshot(804, now - day, now - 1, '10'),
          );
          await assert.rejects(apply(correction, randomUUID(), 'admin'), {
            status: 422,
          });
          await apply(correction, randomUUID(), 'admin', true);
          assert.equal((await xp.tracker()).totals.attack, '10');
          await apply(
            await preview(
              await snapshot(806, now - day, now - 1, '999999', 'vardorvis'),
            ),
          );
          assert.equal((await xp.tracker()).totals.attack, '10');
          assert.equal(
            (await xp.tracker()).events.some((e) => e.id === 806),
            false,
          );
        },
      );
      await t.test(
        'stale, foreign-actor and old page-opening previews reject without scheduling effects',
        async () => {
          const before = await schedules.state();
          const a = await preview(
            await snapshot(807, now + day, now + 2 * day),
          );
          const b = await preview(
            await snapshot(808, now + day, now + 2 * day),
          );
          await assert.rejects(
            apply(a, randomUUID(), 'moderator', false, 'other-actor'),
            { status: 409 },
          );
          await apply(a);
          await assert.rejects(apply(b), { status: 409 });
          const old = await preview(
            await snapshot(808, now + day, now + 2 * day),
          );
          await pool.query(
            "UPDATE competition_previews SET page_ids=ARRAY['staff-page'] WHERE token_hash=encode(sha256($1::bytea),'hex')",
            [old.previewToken],
          );
          await assert.rejects(apply(old), { status: 409 });
          assert.deepEqual(await schedules.state(), before);
        },
      );
      await t.test(
        'already linked staff windows and deletion markers survive metadata and finished refreshes',
        async () => {
          let state = await schedules.save(
            {
              title: 'Explicit staff window',
              startsAt: new Date(now - day).toISOString(),
              endsAt: new Date(now + 3 * day).toISOString(),
              pageIds: ['staff-page'],
            },
            (await schedules.state()).revision,
            'actor',
            'Staff',
          );
          const linked = state.schedules[0]!;
          await pool.query(
            'UPDATE wom_competitions SET schedule_id=$1,schedule_created=true WHERE competition_id=801',
            [linked.id],
          );
          const p = await preview(
            await snapshot(801, now + day, now + 2 * day),
          );
          assert.equal(p.action, 'import-metadata');
          assert.deepEqual(p.pageIds, []);
          assert.match(p.warnings.join(' '), /staff schedule is preserved/);
          assert.equal((await apply(p)).scheduleId, linked.id);
          assert.deepEqual(await schedules.state(), state);
          assert.equal(
            (
              await apply(
                await preview(await snapshot(801, now - day, now - 1, '77')),
                randomUUID(),
                'admin',
              )
            ).scheduleId,
            linked.id,
          );
          assert.deepEqual(await schedules.state(), state);
          state = await schedules.remove(
            linked.id,
            state.revision,
            'actor',
            'Staff',
          );
          await pool.query(
            'UPDATE wom_competitions SET schedule_created=true WHERE competition_id=802',
          );
          const deleted = await preview(
            await snapshot(802, now - day, now + 2 * day),
          );
          assert.equal((await apply(deleted)).scheduleId, null);
          assert.deepEqual(await schedules.state(), state);
        },
      );
      await t.test(
        'legacy XP imports still reject live results and refresh the same page-free identity',
        async () => {
          const live = await snapshot(809, now - day, now + day);
          const futureXp = (await snapshot(809, now - 2 * day, now - day, '13'))
            .results!.xp!;
          await apply(await preview(live));
          await assert.rejects(
            xp.preview(
              { ...futureXp, endsAt: new Date(now + day).toISOString() },
              'actor',
            ),
            { status: 422 },
          );
          const p = await xp.preview(futureXp, 'actor');
          const key = randomUUID();
          const receipt = await xp.apply(
            p.previewToken,
            p.expectedRevision,
            key,
            'actor',
            'Staff',
            false,
          );
          assert.deepEqual(
            await xp.apply(
              p.previewToken,
              p.expectedRevision,
              key,
              'actor',
              'Staff',
              false,
            ),
            receipt,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT schedule_id FROM wom_competitions WHERE competition_id=809',
              )
            ).rows[0].schedule_id,
            null,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int AS count FROM wom_competitions WHERE competition_id=809',
              )
            ).rows[0].count,
            1,
          );
        },
      );
      await t.test(
        'a failed metadata audit rolls back the identity and revision without touching schedules',
        async () => {
          const p = await preview(
            await snapshot(810, now + day, now + 2 * day),
          );
          const before = await schedules.state(),
            revision = (await xp.tracker()).revision;
          await pool.query(
            "CREATE FUNCTION fail_metadata_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$;CREATE TRIGGER fail_metadata_audit BEFORE INSERT ON competition_import_history FOR EACH ROW EXECUTE FUNCTION fail_metadata_audit()",
          );
          await assert.rejects(apply(p));
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM wom_competitions WHERE competition_id=810',
              )
            ).rowCount,
            0,
          );
          assert.equal((await xp.tracker()).revision, revision);
          assert.deepEqual(await schedules.state(), before);
        },
      );
    } finally {
      await pool.end();
      await root.query('DROP SCHEMA ' + schema + ' CASCADE');
      await root.end();
    }
  },
);
