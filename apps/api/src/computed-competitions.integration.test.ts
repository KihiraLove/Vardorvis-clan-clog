/** Standalone computed imports use the real staff API and preserve XP/world histories. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { WorkBudget } from '@clog/domain';
import { createApp } from './app.js';
import { PgStore } from './store.js';
import { PgCompetitionStore } from './competition-store.js';
import { PgSchedulingStore } from './scheduling-store.js';
import { PgXpStore } from './xp-store.js';
import { PgAccessControlStore } from './access-control.js';
import { fetchCompetition } from './competition-wom.js';
import { hashPassword } from './passwords.js';
import { PreviewWork } from './preview-work.js';
import type {
  CompetitionPreview,
  CompetitionReceipt,
} from './competition-types.js';

for (const metric of ['ehp', 'ehb'] as const) {
  test(
    `${metric.toUpperCase()} imports preserve decimal results through preview, apply and refresh`,
    { skip: !process.env.TEST_DATABASE_URL },
    async (t) => {
      const root = new pg.Pool({
        connectionString: process.env.TEST_DATABASE_URL!,
      });
      const schema =
        'computed_' + metric + '_' + randomUUID().replaceAll('-', '');
      await root.query('CREATE SCHEMA ' + schema);
      const pool = new pg.Pool({
        connectionString: process.env.TEST_DATABASE_URL!,
        options: '-c search_path=' + schema,
      });
      const backend = new PgStore(pool),
        imports = new PgCompetitionStore(pool),
        scheduling = new PgSchedulingStore(pool),
        xp = new PgXpStore(pool),
        access = new PgAccessControlStore(pool);
      const sources = new Map<number, unknown>();
      const requests: string[] = [];
      const auth = {
        origin: 'https://clog.example.com',
        secret: 'a'.repeat(64),
        secure: true,
        bootstrapPassword: 'b'.repeat(64),
      };
      const app = createApp(
        () => backend.ready(),
        () => backend.settings(),
        {
          store: backend,
          competitions: imports,
          scheduling,
          xp,
          accessControl: access,
          auth,
          logger: false,
          // Admission limits have dedicated tests; keep this fixture's many previews in one window.
          previews: new PreviewWork(
            new WorkBudget({ concurrent: 2, perMinute: 100 }, [
              { concurrent: 1, perMinute: 100 },
            ]),
          ),
          fetchCompetition: (url, at, _request, cancellation) =>
            fetchCompetition(
              url,
              at,
              async (input) => {
                const address = String(input);
                requests.push(address);
                assert.match(
                  address,
                  /^https:\/\/api\.wiseoldman\.net\/v2\/competitions\/\d+$/u,
                );
                return Response.json(
                  sources.get(Number(address.split('/').at(-1))),
                );
              },
              cancellation,
            ),
        },
      );
      t.after(async () => {
        await app.close();
        await pool.end();
        await root.query('DROP SCHEMA ' + schema + ' CASCADE');
        await root.end();
      });
      const directory = new URL(
        '../../../packages/database/migrations/',
        import.meta.url,
      );
      for (const name of (await readdir(directory))
        .filter((name) => name.endsWith('.sql'))
        .sort())
        await pool.query(await readFile(new URL(name, directory), 'utf8'));
      await app.ready();
      const ownerAccount = (await backend.accountByUsername('admin'))!;
      await backend.updateAccount(
        ownerAccount.id,
        ownerAccount.credentialVersion,
        'owner',
        await hashPassword('owner-password'),
      );
      const created = await backend.createModerator(
        'reviewer',
        await hashPassword('temporary-password'),
        ownerAccount.id,
      );
      const moderatorAccount = (await backend.accountById(created.id))!;
      await backend.updateAccount(
        created.id,
        moderatorAccount.credentialVersion,
        'reviewer',
        await hashPassword('review-password'),
      );
      const login = async (username: string, password: string) => {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: { origin: auth.origin },
          payload: { username, password },
        });
        assert.equal(response.statusCode, 200, response.body);
        return {
          origin: auth.origin,
          cookie: String(response.headers['set-cookie']).split(';')[0]!,
          'x-csrf-token': response.json().csrfToken as string,
        };
      };
      const owner = await login('owner', 'owner-password'),
        moderator = await login('reviewer', 'review-password');
      const now = await imports.clock(),
        day = 86400000;
      const source = (
        id: number,
        lifecycle: 'future' | 'running' | 'finished',
        selected = metric as string,
      ) => ({
        id,
        title: `${selected.toUpperCase()} competition`,
        metrics: [
          {
            metric: selected,
            weight: '1',
            createdAt: new Date(now - 3 * day).toISOString(),
          },
        ],
        startsAt: new Date(
          now + (lifecycle === 'future' ? day : -2 * day),
        ).toISOString(),
        endsAt: new Date(
          now + (lifecycle === 'finished' ? -day : 2 * day),
        ).toISOString(),
        updatedAt: new Date(now).toISOString(),
        participantCount: 6,
        ignoredRawEvidence: 'raw-source-must-not-be-saved',
        participations: [
          '9007199254740993.123456789012345678',
          '2.5',
          '2.50',
          '1.250000',
          '0.000000000000000001',
          '0',
        ].map((gained, index) => ({
          playerId: 101 + index,
          player: { displayName: 'Player ' + (101 + index) },
          deltas: [
            {
              metric: selected,
              values: { gained: gained as string | number | null },
            },
          ],
        })),
      });
      type Source = ReturnType<typeof source>;
      const previewRequest = (
        id: number,
        headers = moderator,
        extra: Record<string, unknown> = {},
      ) =>
        app.inject({
          method: 'POST',
          url: '/api/v1/admin/competitions/preview',
          headers,
          payload: {
            competitionUrl: 'https://wiseoldman.net/competitions/' + id,
            ...extra,
          },
        });
      const preview = async (value: Source) => {
        sources.set(value.id, value);
        const before = requests.length;
        const response = await previewRequest(value.id);
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(
          requests.length,
          before + 1,
          'Computed imports must not request a skill breakdown',
        );
        return response.json<CompetitionPreview>();
      };
      const applyRequest = (
        p: CompetitionPreview,
        key = randomUUID(),
        headers = moderator,
        extra: Record<string, unknown> = {},
      ) =>
        app.inject({
          method: 'POST',
          url: '/api/v1/admin/competitions/imports',
          headers: { ...headers, 'idempotency-key': key },
          payload: {
            previewToken: p.previewToken,
            expectedRevision: p.expectedRevision,
            scheduleRevision: p.scheduleRevision,
            ...extra,
          },
        });
      const apply = async (p: CompetitionPreview, key = randomUUID()) => {
        const response = await applyRequest(p, key);
        assert.equal(response.statusCode, 200, response.body);
        const receipt = response.json<CompetitionReceipt>();
        assert.equal(receipt.scheduleId, null);
        return receipt;
      };
      const saved = async (id: number) =>
        (
          await pool.query(
            'SELECT * FROM wom_competitions WHERE competition_id=$1',
            [id],
          )
        ).rows[0]!;
      const audit = async () =>
        (
          await pool.query(
            'SELECT * FROM competition_import_history ORDER BY id',
          )
        ).rows;

      // Keep genuine XP and world-specific credits in place while computed imports run.
      const training = source(9100, 'finished', 'attack');
      training.participations = [
        {
          playerId: 1,
          player: { displayName: 'Training player' },
          deltas: [{ metric: 'attack', values: { gained: '123' } }],
        },
      ];
      training.participantCount = 1;
      await apply(await preview(training));
      await pool.query(`INSERT INTO items(id,name) VALUES(1,'Existing drop');
        INSERT INTO pages(id,name,category,sort_order) VALUES('vardorvis','Vardorvis','bosses',0),('ehp','EHP named page','other',0),('ehb','EHB named page','other',1);
        INSERT INTO page_items(page_id,item_id,slot) VALUES('vardorvis',1,0),('ehp',1,0),('ehb',1,0);
        INSERT INTO collection_permanent_pages(page_id) VALUES('vardorvis');
        UPDATE site_settings SET hardcore_enabled=true;
        INSERT INTO submissions(id,source,raw_item_text,item_id,collector_name,collected_on,date_source,proof_url,hardcore,status,reviewed_by,reviewed_at)
        VALUES('00000000-0000-4000-8000-000000000001','manual','Existing drop',1,'Normal collector','2026-10-18','admin','',false,'approved','owner',now()),
        ('00000000-0000-4000-8000-000000000002','manual','Existing drop',1,'HC collector','2026-10-18','admin','',true,'approved','owner',now());`);
      await scheduling.save(
        {
          title: 'Staff window',
          startsAt: new Date(now - day).toISOString(),
          endsAt: new Date(now + day).toISOString(),
          pageIds: ['vardorvis'],
        },
        (await scheduling.state()).revision,
        ownerAccount.id,
        'Owner',
      );
      const initialXp = await xp.tracker(),
        initialScheduling = await scheduling.state();
      const worldState = async () => {
        const result: unknown[] = [];
        for (const table of [
          'items',
          'pages',
          'page_items',
          'submissions',
          'collection_credits',
          'site_settings',
          'collection_permanent_pages',
          'collection_schedule_audit',
        ])
          result.push(
            (
              await pool.query(
                'SELECT to_jsonb(t) AS row FROM ' +
                  table +
                  ' t ORDER BY to_jsonb(t)::text',
              )
            ).rows,
          );
        return result;
      };
      const initialWorld = await worldState();
      const assertIsolated = async () => {
        const tracker = await xp.tracker();
        assert.deepEqual(tracker.totals, initialXp.totals);
        assert.deepEqual(tracker.events, initialXp.events);
        assert.deepEqual(tracker.podium, initialXp.podium);
        assert.deepEqual(await scheduling.state(), initialScheduling);
        assert.equal(initialScheduling.enabled, false);
        assert.deepEqual(await worldState(), initialWorld);
        assert.equal(
          (await pool.query('SELECT count(*)::int AS n FROM xp_events')).rows[0]
            .n,
          1,
        );
        assert.equal(
          (await pool.query('SELECT count(*)::int AS n FROM xp_import_history'))
            .rows[0].n,
          1,
        );
      };

      await t.test(
        'future/running imports retain only metadata and never require or open pages',
        async () => {
          for (const [id, lifecycle] of [
            [9200, 'future'],
            [9201, 'running'],
          ] as const) {
            const value = source(id, lifecycle);
            const p = await preview(value);
            assert.equal(p.lifecycle, lifecycle);
            assert.equal(p.action, 'import-metadata');
            assert.deepEqual(p.pageIds, []);
            assert.deepEqual(p.pages, []);
            assert.deepEqual(p.participants, []);
            assert.equal(p.standings, undefined);
            assert.equal(p.scheduleStartsAt, null);
            assert.deepEqual(p.changes, []);
            assert.equal(
              (await previewRequest(id, moderator, { pageIds: [metric] }))
                .statusCode,
              422,
            );
            await apply(p);
            const row = await saved(id);
            assert.deepEqual(row.metrics, [metric]);
            assert.equal(row.results_imported_at, null);
            assert.equal(row.activity_results, null);
            assert.deepEqual(row.competition_results, []);
            assert.equal(row.schedule_created, false);
            assert.deepEqual(row.skills, []);
            const evidence =
              JSON.stringify(
                (
                  await pool.query(
                    "SELECT snapshot FROM competition_previews WHERE snapshot->'competition'->>'id'=$1",
                    [String(id)],
                  )
                ).rows,
              ) +
              JSON.stringify(
                (await audit()).filter(
                  (entry) => Number(entry.competition_id) === id,
                ),
              );
            assert.equal(evidence.includes('Player 101'), false);
            assert.equal(
              evidence.includes('raw-source-must-not-be-saved'),
              false,
            );
            await assertIsolated();
          }
        },
      );

      const finished = source(9201, 'finished');
      let firstPreview: CompetitionPreview, firstReceipt: CompetitionReceipt;
      const firstKey = randomUUID();
      await t.test(
        'finished standalone results retain the full ranked roster and exact decimal hours',
        async () => {
          firstPreview = await preview(finished);
          assert.equal(firstPreview.action, 'import-results');
          assert.deepEqual(firstPreview.changes, []);
          assert.deepEqual(firstPreview.pageIds, []);
          assert.deepEqual(
            firstPreview.competition.metricDefinitions,
            finished.metrics,
          );
          const expected = [
            '9007199254740993.123456789012345678',
            '2.5',
            '2.5',
            '1.25',
            '0.000000000000000001',
          ];
          assert.deepEqual(
            firstPreview.standings?.map((p) => p.gained),
            expected,
          );
          assert.deepEqual(
            firstPreview.standings?.map((p) => p.playerId),
            [101, 102, 103, 104, 105],
          );
          assert.deepEqual(
            firstPreview.standings?.map((p) => p.rank),
            [1, 2, 3, 4, 5],
          );
          for (const player of firstPreview.standings!)
            assert.deepEqual(player.deltas, [
              { metric, gained: player.gained },
            ]);
          assert.equal(
            (await applyRequest(firstPreview, randomUUID(), owner)).statusCode,
            409,
            'Preview is bound to the moderator who requested it',
          );
          firstReceipt = await apply(firstPreview, firstKey);
          const row = await saved(finished.id);
          assert.deepEqual(row.competition_results, firstPreview.standings);
          assert.deepEqual(row.activity_results, firstPreview.standings);
          assert.ok(row.results_imported_at);
          assert.deepEqual(
            (await audit()).find((entry) => entry.request_key === firstKey)
              .new_values.competitionResults,
            firstPreview.standings,
          );
          const publicActivities = (
            await app.inject('/api/v1/competitions/activities')
          ).json();
          assert.equal(
            JSON.stringify(publicActivities).includes('Player 101'),
            false,
          );
          assert.equal(
            (await xp.tracker()).events.some(
              (event) => event.id === finished.id,
            ),
            false,
          );
          await assertIsolated();
        },
      );

      await t.test(
        'repeat imports, changed rosters and original request replays reconcile safely',
        async () => {
          const repeat = await preview(finished);
          assert.equal((await apply(repeat)).outcome, 'unchanged');
          const revised = structuredClone(finished);
          revised.title = 'Corrected ' + metric.toUpperCase();
          revised.metrics[0]!.weight = '0.5';
          revised.participations[0]!.player.displayName = 'Renamed player';
          revised.participations[0]!.deltas[0]!.values.gained =
            '3.125000000000000001';
          revised.participations[3]!.playerId = 107;
          revised.participations[3]!.player.displayName = 'New player';
          revised.participations[3]!.deltas[0]!.values.gained = '2.75';
          const p = await preview(revised);
          assert.deepEqual(p.changes, []);
          assert.equal((await apply(p)).outcome, 'applied');
          const row = await saved(finished.id);
          assert.deepEqual(row.metric_definitions, revised.metrics);
          assert.deepEqual(row.competition_results, p.standings);
          assert.equal(
            row.competition_results.find(
              (p: { playerId: number }) => p.playerId === 101,
            ).displayName,
            'Renamed player',
          );
          assert.equal(
            row.competition_results.some(
              (p: { playerId: number }) => p.playerId === 104,
            ),
            false,
          );
          assert.equal(
            row.competition_results[0].gained,
            '3.125000000000000001',
          );
          await pool.query(
            "DELETE FROM competition_previews WHERE token_hash=encode(sha256($1::bytea),'hex')",
            [firstPreview.previewToken],
          );
          assert.deepEqual(await apply(firstPreview, firstKey), firstReceipt);
          assert.equal(
            (
              await applyRequest(firstPreview, firstKey, moderator, {
                acknowledgeCorrections: true,
              })
            ).statusCode,
            409,
          );
          assert.equal(
            (await audit()).filter((entry) => entry.request_key === firstKey)
              .length,
            1,
          );
          await assertIsolated();
        },
      );

      await t.test(
        'malformed or incomplete refreshes cannot overwrite a good computed import',
        async () => {
          const before = await saved(finished.id),
            history = await audit();
          const malformed: unknown[] = [
            { ...finished, participantCount: 7 },
            { ...finished, updatedAt: null },
            {
              ...finished,
              participations: finished.participations.slice(0, 5),
            },
            {
              ...finished,
              participations: [
                finished.participations[0],
                ...finished.participations.slice(0, 5),
              ],
            },
            {
              ...finished,
              participations: finished.participations.map((p, i) =>
                i ? p : { ...p, deltas: [] },
              ),
            },
            // A malformed zero-score participant still invalidates the complete source.
            {
              ...finished,
              participations: finished.participations.map((p, i) =>
                i !== 5 ? p : { ...p, deltas: [] },
              ),
            },
            { ...finished, metrics: [{ metric, weight: '0' }] },
          ];
          for (const gained of [null, '-1', 'NaN', Number.MAX_SAFE_INTEGER + 1])
            malformed.push({
              ...finished,
              participations: finished.participations.map((p, i) =>
                i ? p : { ...p, deltas: [{ metric, values: { gained } }] },
              ),
            });
          for (const value of malformed) {
            sources.set(finished.id, value);
            const response = await previewRequest(finished.id);
            assert.equal(response.statusCode, 422, response.body);
          }
          sources.set(finished.id, source(finished.id, 'running'));
          assert.equal((await previewRequest(finished.id)).statusCode, 422);
          sources.set(
            finished.id,
            source(finished.id, 'finished', metric === 'ehp' ? 'ehb' : 'ehp'),
          );
          assert.equal((await previewRequest(finished.id)).statusCode, 422);
          assert.deepEqual(await saved(finished.id), before);
          assert.deepEqual(await audit(), history);
          await assertIsolated();
        },
      );

      await t.test(
        'authentication, CSRF, page access, stale revisions and audit rollback protect computed imports',
        async () => {
          const value = { ...finished, title: 'Audited correction' };
          sources.set(value.id, value);
          const payload = {
            competitionUrl: 'https://wiseoldman.net/competitions/' + value.id,
          };
          assert.equal(
            (
              await app.inject({
                method: 'POST',
                url: '/api/v1/admin/competitions/preview',
                payload,
              })
            ).statusCode,
            401,
          );
          assert.equal(
            (
              await previewRequest(value.id, {
                ...moderator,
                'x-csrf-token': 'wrong',
              })
            ).statusCode,
            403,
          );
          const p = await preview(value);
          const permissions = await access.settings();
          await access.update(
            permissions.moderatorPages.filter((page) => page !== 'schedules'),
            permissions.revision,
            ownerAccount.id,
          );
          assert.equal((await previewRequest(value.id)).statusCode, 403);
          assert.equal((await applyRequest(p)).statusCode, 403);
          await access.update(
            permissions.moderatorPages,
            (await access.settings()).revision,
            ownerAccount.id,
          );
          const stale = { ...p, expectedRevision: 'xp-1' };
          assert.equal((await applyRequest(stale)).statusCode, 409);
          const before = await saved(value.id),
            history = await audit();
          await pool.query(
            "CREATE FUNCTION fail_computed_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$; CREATE TRIGGER fail_computed_audit BEFORE INSERT ON competition_import_history FOR EACH ROW EXECUTE FUNCTION fail_computed_audit()",
          );
          const retryKey = randomUUID();
          assert.equal((await applyRequest(p, retryKey)).statusCode, 503);
          assert.deepEqual(await saved(value.id), before);
          assert.deepEqual(await audit(), history);
          await pool.query(
            'DROP TRIGGER fail_computed_audit ON competition_import_history',
          );
          assert.equal((await apply(p, retryKey)).outcome, 'applied');
          await assertIsolated();
        },
      );
    },
  );
}
