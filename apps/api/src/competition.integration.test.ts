import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { PgCompetitionStore } from './competition-store.js';
import { PgXpStore } from './xp-store.js';
import {
  PgSchedulingStore,
  lockScheduling,
  requireScheduledItem,
} from './scheduling-store.js';
import { PgStore } from './store.js';
import { createApp } from './app.js';
import { hashPassword } from './passwords.js';
import { fetchCompetition } from './competition-wom.js';
import type { CompetitionSnapshot } from './competition-types.js';
test(
  'unified competitions preserve legacy data, isolate kinds, schedule atomically, reconcile results and enforce staff permissions',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const connectionString = process.env.TEST_DATABASE_URL!,
      root = new pg.Pool({ connectionString }),
      schema = 'competition_test_' + randomUUID().replaceAll('-', '');
    await root.query('CREATE SCHEMA ' + schema);
    const pool = new pg.Pool({
      connectionString,
      options: '-c search_path=' + schema,
      max: 12,
      statement_timeout: 5000,
    });
    const store = new PgCompetitionStore(pool),
      xp = new PgXpStore(pool),
      scheduling = new PgSchedulingStore(pool),
      backend = new PgStore(pool);
    const auth = {
      origin: 'https://clog.example.com',
      secret: 'a'.repeat(64),
      secure: true,
      bootstrapPassword: 'b'.repeat(64),
    };
    const now = await store.clock(),
      day = 86400000;
    const source = (
      id: number,
      metric: string,
      start: number,
      end: number,
      gained = '50',
    ) => ({
      id,
      title: 'Competition ' + id,
      metrics: [{ metric }],
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(end).toISOString(),
      updatedAt: new Date(now).toISOString(),
      participantCount: 2,
      participations: [
        {
          playerId: 1,
          player: { displayName: 'Player One' },
          deltas: [{ metric, values: { gained } }],
        },
        {
          playerId: 2,
          player: { displayName: 'Zero' },
          deltas: [{ metric, values: { gained: 0 } }],
        },
      ],
    });
    let fakeSource: unknown = source(500, 'vardorvis', now - day, now + day);
    const app = createApp(undefined, undefined, {
      store: backend,
      competitions: store,
      scheduling,
      xp,
      auth,
      logger: false,
      fetchCompetition: (url, at) =>
        fetchCompetition(url, at, async () => Response.json(fakeSource)),
    });
    const snapshot = async (
      id: number,
      kind: 'SKILL' | 'ACTIVITY',
      start: number,
      end: number,
      gained = '50',
    ) =>
      fetchCompetition(
        'https://wiseoldman.net/competitions/' + id,
        now,
        async () =>
          Response.json(
            source(
              id,
              kind === 'SKILL' ? 'attack' : 'vardorvis',
              start,
              end,
              gained,
            ),
          ),
      );
    const preview = async (s: CompetitionSnapshot, pages?: string[]) =>
      store.preview(s, 'actor', pages);
    const apply = async (
      p: Awaited<ReturnType<typeof preview>>,
      key = randomUUID(),
      role: 'admin' | 'moderator' = 'admin',
      ack = false,
    ) =>
      store.apply(
        p.previewToken,
        p.expectedRevision,
        p.scheduleRevision,
        key,
        'actor',
        'Staff',
        role,
        ack,
      );
    try {
      const migrations = new URL(
        '../../../packages/database/migrations/',
        import.meta.url,
      );
      const files = (await readdir(migrations))
        .filter((f) => f.endsWith('.sql'))
        .sort();
      for (const file of files.filter((f) => !f.startsWith('014')))
        await pool.query(await readFile(new URL(file, migrations), 'utf8'));
      const legacy = await snapshot(
        99,
        'SKILL',
        now - 3 * day,
        now - day,
        '123',
      );
      await pool.query(
        'INSERT INTO xp_events(competition_id,title,source_url,skills,gains,source_hash,source_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          99,
          legacy.competition.title,
          legacy.competition.sourceUrl,
          JSON.stringify(['attack']),
          JSON.stringify({ attack: '123' }),
          legacy.results!.xp!.sourceHash,
          JSON.stringify(legacy.results!.xp),
        ],
      );
      await pool.query(
        "INSERT INTO xp_import_history(id,actor_discord_id,actor_name,request_key,token_hash,expected_revision,competition_id,title,outcome,changes,resulting_revision) VALUES($1,'legacy','Legacy Staff',$2,$3,'xp-1',99,'Legacy competition','applied','[]','xp-2')",
        [randomUUID(), randomUUID(), 'a'.repeat(64)],
      );
      const liveLegacy = await snapshot(98, 'SKILL', now - day, now + day);
      await pool.query(
        "INSERT INTO xp_previews(token_hash,actor_discord_id,expected_revision,snapshot,expires_at) VALUES($1,'legacy','xp-1',$2,now()+interval '1 hour')",
        [
          'b'.repeat(64),
          JSON.stringify({
            ...legacy.results!.xp,
            startsAt: liveLegacy.competition.startsAt,
            endsAt: liveLegacy.competition.endsAt,
          }),
        ],
      );
      await pool.query(
        await readFile(new URL('014_wom_competitions.sql', migrations), 'utf8'),
      );
      assert.equal(
        (await pool.query('SELECT count(*)::int AS count FROM xp_previews'))
          .rows[0].count,
        0,
      );
      assert.equal((await xp.history()).imports[0]?.actorName, 'Legacy Staff');
      const legacyPreview = await preview(legacy);
      assert.equal((await apply(legacyPreview)).outcome, 'unchanged');
      assert.equal((await xp.tracker()).totals.attack, '123');
      assert.equal(
        (
          await pool.query(
            'SELECT kind FROM wom_competitions WHERE competition_id=99',
          )
        ).rows[0].kind,
        'SKILL',
      );
      await pool.query(
        "INSERT INTO pages(id,name,category,sort_order) VALUES('vardorvis','Vardorvis','bosses',0),('other','Other','bosses',1),('inactive','Inactive','bosses',2);UPDATE pages SET active=false WHERE id='inactive';INSERT INTO items(id,name) VALUES(1,'Shared');INSERT INTO page_items(page_id,item_id,slot) VALUES('vardorvis',1,0),('other',1,0)",
      );
      const future = await snapshot(100, 'ACTIVITY', now + day, now + 2 * day);
      let p = await preview(future);
      assert.equal(p.action, 'create-schedule');
      assert.deepEqual(p.pageIds, ['vardorvis']);
      assert.equal(p.participants.length, 0);
      const key = randomUUID(),
        receipt = await apply(p, key);
      assert.deepEqual(await apply(p, key), receipt);
      await pool.query(
        "UPDATE competition_previews SET expires_at=now()-interval '1 hour' WHERE token_hash=encode(sha256($1::bytea),'hex')",
        [p.previewToken],
      );
      assert.deepEqual(
        await new PgCompetitionStore(pool).apply(
          p.previewToken,
          p.expectedRevision,
          p.scheduleRevision,
          key,
          'actor',
          'Staff',
          'admin',
          false,
        ),
        receipt,
      );
      await assert.rejects(apply(p, key, 'admin', true), { status: 409 });
      let state = await scheduling.state();
      assert.equal(state.enabled, false);
      assert.equal(state.schedules.length, 1);
      assert.equal(state.schedules[0]?.startsAt, future.competition.startsAt);
      const metadata = (
        await pool.query(
          'SELECT * FROM wom_competitions WHERE competition_id=100',
        )
      ).rows[0];
      assert.equal(metadata.activity_results, null);
      assert.equal(metadata.results_imported_at, null);
      const persisted =
        JSON.stringify(
          (
            await pool.query(
              "SELECT snapshot FROM competition_previews WHERE snapshot->>'lifecycle'<>'finished'",
            )
          ).rows,
        ) +
        JSON.stringify(
          (
            await pool.query(
              "SELECT old_values,new_values,receipt FROM competition_import_history WHERE new_values->>'lifecycle'<>'finished'",
            )
          ).rows,
        );
      assert.equal(persisted.includes('participations'), false);
      assert.equal(persisted.includes('Player One'), false);
      assert.equal(
        (await pool.query('SELECT count(*)::int AS count FROM xp_events'))
          .rows[0].count,
        1,
      );
      const running = await snapshot(101, 'ACTIVITY', now - day, now + day);
      p = await preview(running);
      const before = await store.clock();
      const runningReceipt = await apply(p);
      const after = await store.clock();
      state = await scheduling.state();
      const window = state.schedules.find(
        (s) => s.id === runningReceipt.scheduleId,
      )!;
      assert.ok(
        Date.parse(window.startsAt) >= before &&
          Date.parse(window.startsAt) <= after,
      );
      assert.equal(window.endsAt, running.competition.endsAt);
      const edited = {
        title: 'Staff edited',
        startsAt: new Date(now - 1000).toISOString(),
        endsAt: window.endsAt,
        pageIds: ['other'],
      };
      await scheduling.save(
        edited,
        state.revision,
        'actor',
        'Staff',
        window.id,
      );
      p = await preview(running);
      assert.equal(p.action, 'preserve-schedule');
      assert.deepEqual(p.pageIds, ['other']);
      await apply(p);
      assert.equal(
        (await scheduling.state()).schedules.find((s) => s.id === window.id)
          ?.title,
        'Staff edited',
      );
      state = await scheduling.state();
      await scheduling.remove(window.id, state.revision, 'actor', 'Staff');
      p = await preview(running);
      assert.equal(p.action, 'preserve-deletion');
      await apply(p);
      assert.equal((await scheduling.state()).schedules.length, 1);
      const skillFuture = await snapshot(
        102,
        'SKILL',
        now + day,
        now + 2 * day,
      );
      p = await preview(skillFuture);
      assert.deepEqual(p.pageIds, []);
      await assert.rejects(apply(p), { status: 422 });
      await assert.rejects(preview(skillFuture, ['inactive']), { status: 422 });
      p = await preview(skillFuture, ['other']);
      await apply(p);
      const skillEntry = (await xp.tracker()).events.find((e) => e.id === 102)!;
      assert.equal(skillEntry.gains.attack, null);
      assert.deepEqual(skillEntry.podium, []);
      const liveSkillRow = (
        await pool.query(
          'SELECT results_imported_at,activity_results FROM wom_competitions WHERE competition_id=102',
        )
      ).rows[0];
      assert.equal(liveSkillRow.results_imported_at, null);
      assert.equal(liveSkillRow.activity_results, null);
      assert.equal(
        (await pool.query('SELECT 1 FROM xp_events WHERE competition_id=102'))
          .rowCount,
        0,
      );
      const mismatchedSkill = await fetchCompetition(
        'https://wiseoldman.net/competitions/102',
        now,
        async () =>
          Response.json(source(102, 'mining', now - 2 * day, now - day)),
      );
      await assert.rejects(xp.preview(mismatchedSkill.results!.xp!, 'actor'), {
        status: 422,
      });
      const finished = await snapshot(
        103,
        'SKILL',
        now - 2 * day,
        now - day,
        '9007199254740993',
      );
      p = await preview(finished);
      assert.equal(p.action, 'import-results');
      assert.equal(p.participants.length, 1);
      const count = (await scheduling.state()).schedules.length;
      await assert.rejects(apply(p, randomUUID(), 'moderator'), {
        status: 403,
      });
      await apply(p);
      assert.equal((await scheduling.state()).schedules.length, count);
      assert.equal((await xp.tracker()).totals.attack, '9007199254741116');
      assert.equal(
        (await xp.tracker()).podium?.[0]?.gained,
        '9007199254741116',
      );
      p = await preview(finished);
      assert.equal((await apply(p)).outcome, 'unchanged');
      p = await preview(
        await snapshot(103, 'SKILL', now - 2 * day, now - day, '10'),
      );
      await assert.rejects(apply(p), { status: 422 });
      await apply(p, randomUUID(), 'admin', true);
      assert.equal((await xp.tracker()).totals.attack, '133');
      p = await preview(
        await snapshot(104, 'ACTIVITY', now - 2 * day, now - day, '999'),
      );
      await apply(p);
      assert.equal((await xp.tracker()).totals.attack, '133');
      assert.equal(
        (await xp.tracker()).events.some((e) => e.id === 104),
        false,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT activity_results FROM wom_competitions WHERE competition_id=104',
          )
        ).rows[0].activity_results.length,
        1,
      );
      await assert.rejects(
        pool.query(
          "INSERT INTO xp_events(competition_id,title,source_url,skills,gains,source_hash,source_snapshot) VALUES(104,'bad','bad','[]','{}',$1,'{}')",
          ['a'.repeat(64)],
        ),
        { code: '23503' },
      );
      await assert.rejects(
        preview({
          ...finished,
          competition: { ...finished.competition, kind: 'ACTIVITY' },
        }),
        { status: 422 },
      );
      p = await preview(
        await snapshot(105, 'ACTIVITY', now + day, now + 2 * day),
      );
      await scheduling.setEnabled(
        true,
        (await scheduling.state()).revision,
        'actor',
        'Staff',
      );
      await assert.rejects(apply(p), { status: 409 });
      const boundary = await snapshot(106, 'ACTIVITY', now - day, now + day);
      p = await preview(boundary);
      await pool.query(
        "UPDATE competition_previews SET snapshot=jsonb_set(snapshot,'{competition,endsAt}',to_jsonb($1::text)) WHERE token_hash=encode(sha256($2::bytea),'hex')",
        [new Date(now - 1).toISOString(), p.previewToken],
      );
      await assert.rejects(apply(p), { status: 409 });
      const toRunning = await snapshot(
        107,
        'ACTIVITY',
        now + day,
        now + 2 * day,
      );
      p = await preview(toRunning);
      await pool.query(
        "UPDATE competition_previews SET snapshot=jsonb_set(snapshot,'{competition,startsAt}',to_jsonb($1::text)) WHERE token_hash=encode(sha256($2::bytea),'hex')",
        [new Date(now - 1).toISOString(), p.previewToken],
      );
      const r = await apply(p);
      assert.ok(
        Date.parse(
          (await scheduling.state()).schedules.find(
            (s) => s.id === r.scheduleId,
          )!.startsAt,
        ) >= now,
      );
      const gate = await pool.connect();
      try {
        await gate.query('BEGIN');
        const enabled = await lockScheduling(gate);
        await requireScheduledItem(gate, enabled, 1);
        await gate.query('ROLLBACK');
      } finally {
        gate.release();
      }
      p = await preview(
        await snapshot(108, 'ACTIVITY', now + day, now + 2 * day),
      );
      await pool.query(
        "CREATE FUNCTION fail_competition_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$;CREATE TRIGGER fail_competition_audit BEFORE INSERT ON competition_import_history FOR EACH ROW EXECUTE FUNCTION fail_competition_audit()",
      );
      const previous = await scheduling.state();
      await assert.rejects(apply(p));
      assert.deepEqual(await scheduling.state(), previous);
      assert.equal(
        (
          await pool.query(
            'SELECT 1 FROM wom_competitions WHERE competition_id=108',
          )
        ).rowCount,
        0,
      );
      await pool.query(
        'DROP TRIGGER fail_competition_audit ON competition_import_history',
      );
      const activities = (await store.activities()).competitions;
      assert.deepEqual(
        activities.map((c) => c.id),
        [107, 100, 101, 104],
      );
      assert.equal(JSON.stringify(activities).includes('Player One'), false);
      // Real session, role and CSRF boundaries, including the legacy XP endpoint.
      await app.ready();
      const admin = (await backend.accountByUsername('admin'))!;
      await backend.updateAccount(
        admin.id,
        admin.credentialVersion,
        'owner',
        await hashPassword('owner-password'),
      );
      const mod = await backend.createModerator(
        'reviewer',
        await hashPassword('first-password'),
        admin.id,
      );
      const acct = (await backend.accountById(mod.id))!;
      await backend.updateAccount(
        mod.id,
        acct.credentialVersion,
        'reviewer',
        await hashPassword('review-password'),
      );
      const login = async (username: string, password: string) => {
        const r = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: { origin: auth.origin },
          payload: { username, password },
        });
        assert.equal(r.statusCode, 200, r.body);
        return {
          origin: auth.origin,
          cookie: String(r.headers['set-cookie']).split(';')[0]!,
          'x-csrf-token': r.json().csrfToken as string,
        };
      };
      const owner = await login('owner', 'owner-password'),
        moderator = await login('reviewer', 'review-password'),
        url = '/api/v1/admin/competitions/preview',
        payload = {
          competitionUrl: 'https://wiseoldman.net/competitions/500',
        };
      assert.equal(
        (await app.inject({ method: 'POST', url, payload })).statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { cookie: moderator.cookie },
            payload,
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: moderator,
            payload: { ...payload, kind: 'INVALID' },
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (await app.inject({ method: 'POST', url, headers: moderator, payload }))
          .statusCode,
        200,
      );
      const detectedActivity = await app.inject({
        method: 'POST',
        url,
        headers: moderator,
        payload,
      });
      assert.equal(detectedActivity.json().competition.kind, 'ACTIVITY');
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: owner,
            payload: { ...payload, kind: 'SKILL' },
          })
        ).statusCode,
        422,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: moderator,
            payload: { ...payload, kind: 'ACTIVITY' },
          })
        ).statusCode,
        200,
      );
      fakeSource = source(500, 'attack', now - 2 * day, now - day);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: moderator,
            payload,
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: owner,
            payload,
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: moderator,
            payload: { ...payload, kind: 'ACTIVITY' },
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: owner,
            payload: { ...payload, kind: 'ACTIVITY' },
          })
        ).statusCode,
        422,
      );
      const detectedSkill = await app.inject({
        method: 'POST',
        url,
        headers: owner,
        payload: { ...payload, kind: 'SKILL' },
      });
      assert.equal(detectedSkill.statusCode, 200, detectedSkill.body);
      assert.equal(detectedSkill.json().competition.kind, 'SKILL');
      fakeSource = source(501, 'attack', now + day, now + 2 * day);
      const futureSkill = await app.inject({
        method: 'POST',
        url,
        headers: moderator,
        payload: { competitionUrl: 'https://wiseoldman.net/competitions/501' },
      });
      assert.equal(futureSkill.statusCode, 200, futureSkill.body);
      assert.equal(futureSkill.json().competition.kind, 'SKILL');
      assert.equal(futureSkill.json().participants.length, 0);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/admin/xp/imports/preview',
            headers: moderator,
            payload: { ...payload, kind: 'SKILL' },
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (await app.inject('/api/v1/competitions/activities')).statusCode,
        200,
      );
    } finally {
      await app.close();
      await pool.end();
      await root.query('DROP SCHEMA ' + schema + ' CASCADE');
      await root.end();
    }
  },
);
