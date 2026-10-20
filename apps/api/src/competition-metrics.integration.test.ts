/** Registration, real import/apply, durable replays and a populated 1.0.0 upgrade. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import { migrate } from '@clog/database/dist/migrate.js';
import { provisionRuntimeRole } from '@clog/database/dist/runtime-role.js';
import { PgCompetitionMetricStore } from './competition-metric-store.js';
import {
  competitionUnit,
  WorkBudget,
  type CustomCompetitionMetric,
  type CompetitionMetricResolution,
} from '@clog/domain';
import { PgCompetitionStore } from './competition-store.js';
import { PgXpStore } from './xp-store.js';
import { competitionRoutes } from './competition-routes.js';
import { fetchCompetition } from './competition-wom.js';
import { UnknownCompetitionMetrics } from './wom-competition-data.js';
import { PreviewWork } from './preview-work.js';

test(
  'runtime credentials can register metrics and recover receipts without rewriting definitions or audit evidence',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const ownerUrl = new URL(process.env.TEST_DATABASE_URL!);
    ownerUrl.search = '';
    const root = new pg.Client({ connectionString: ownerUrl.href });
    await root.connect();
    const database = 'custom_metric_role_' + randomUUID().replaceAll('-', '');
    await root.query('CREATE DATABASE ' + database);
    ownerUrl.pathname = '/' + database;
    let runtime: pg.Pool | undefined;
    try {
      await migrate(ownerUrl.href);
      const password = 'f'.repeat(64);
      await provisionRuntimeRole(ownerUrl.href, password);
      const runtimeUrl = new URL(ownerUrl);
      runtimeUrl.username = 'clog_runtime';
      runtimeUrl.password = password;
      runtime = new pg.Pool({ connectionString: runtimeUrl.href });
      const registry = new PgCompetitionMetricStore(runtime);
      const p = await registry.challenge(
        {
          id: 1,
          title: 'Runtime metric',
          sourceUrl: 'https://wiseoldman.net/competitions/1',
          metrics: [{ metric: 'runtime_metric', weight: '1' }],
          unknownMetrics: ['runtime_metric'],
          startsAt: '2098-01-01T00:00:00Z',
          endsAt: '2099-01-01T00:00:00Z',
        },
        'owner',
      );
      const definition: CustomCompetitionMetric = {
        metric: 'runtime_metric',
        name: 'Runtime metric',
        type: 'COMPUTED',
        pageIds: [],
      };
      const key = randomUUID();
      const receipt = await registry.save(
        p.resolutionToken,
        p.revision,
        [definition],
        key,
        'owner',
      );
      assert.deepEqual(
        await registry.save(
          p.resolutionToken,
          p.revision,
          [definition],
          key,
          'owner',
        ),
        receipt,
      );
      assert.deepEqual((await registry.list()).definitions, [definition]);
      await assert.rejects(
        runtime.query(
          'UPDATE custom_competition_metrics SET definition=definition',
        ),
        { code: '42501' },
      );
      await assert.rejects(
        runtime.query('DELETE FROM competition_metric_audit'),
        { code: '42501' },
      );
      await assert.rejects(
        runtime.query(
          'UPDATE competition_metric_resolutions SET discovery=discovery',
        ),
        { code: '42501' },
      );
    } finally {
      await runtime?.end();
      await root.query('DROP DATABASE ' + database);
      await root.end();
    }
  },
);

test(
  'staff can explicitly resolve unknown metrics and preserve their meaning across imports and upgrades',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = 'custom_metrics_' + randomUUID().replaceAll('-', '');
    const url = new URL(process.env.TEST_DATABASE_URL!);
    const root = new pg.Pool({ connectionString: url.href });
    await root.query('CREATE SCHEMA ' + schema);
    url.searchParams.set('options', '-c search_path=' + schema);
    const pool = new pg.Pool({ connectionString: url.href });
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      const failure = error as {
        status?: number;
        statusCode?: number;
        message: string;
      };
      return reply
        .code(failure.status ?? failure.statusCode ?? 500)
        .send({ error: failure.message });
    });
    t.after(async () => {
      await app.close();
      await pool.end();
      await root.query('DROP SCHEMA ' + schema + ' CASCADE');
      await root.end();
    });
    const baseline = await readFile(
      new URL(
        '../../../packages/database/migrations/001_baseline.sql',
        import.meta.url,
      ),
      'utf8',
    );
    await pool.query(baseline);
    await pool.query(
      'CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
    );
    await pool.query(
      'INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',
      ['001_baseline.sql', createHash('sha256').update(baseline).digest('hex')],
    );
    await pool.query(`INSERT INTO pages(id,name,category,sort_order) VALUES('raid','New raid','raids',0);
    INSERT INTO items(id,name) VALUES(1,'Existing item');
    INSERT INTO submissions(id,source,raw_item_text,item_id,collector_name,collected_on,date_source,proof_url,status,reviewed_by,reviewed_at)
    VALUES('00000000-0000-4000-8000-000000000001','manual','Existing item',1,'Original collector','2026-10-18','admin','','approved','owner',now());
    INSERT INTO wom_competitions(competition_id,kind,title,source_url,metrics,skills,starts_at,ends_at,source_hash)
    VALUES(99,'ACTIVITY','Existing competition','https://wiseoldman.net/competitions/99','["vardorvis"]','[]',now()-interval '2 days',now()-interval '1 day','old');`);
    const before = (
      await pool.query('SELECT to_jsonb(s) AS row FROM submissions s')
    ).rows;
    await migrate(url.href);
    await migrate(url.href);
    assert.deepEqual(
      (await pool.query('SELECT to_jsonb(s) AS row FROM submissions s')).rows,
      before,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT title FROM wom_competitions WHERE competition_id=99',
        )
      ).rows[0].title,
      'Existing competition',
    );
    assert.deepEqual(
      (
        await pool.query('SELECT name FROM schema_migrations ORDER BY name')
      ).rows.map((r) => r.name),
      [
        '001_baseline.sql',
        '002_custom_competition_metrics.sql',
        '003_catalog_updates.sql',
      ],
    );
    const store = new PgCompetitionStore(pool);
    const now = await store.clock(),
      day = 86400000;
    let metrics = ['new_raid'];
    let finished = false;
    let gained = '25';
    const request: typeof fetch = async (address) => {
      const id = Number(new URL(String(address)).pathname.split('/').at(-1));
      return Response.json({
        id,
        title: 'New competition',
        metrics: metrics.map((metric) => ({
          metric,
          weight: 1,
          definition: { type: 'COMPUTED' },
        })),
        startsAt: new Date(now - day).toISOString(),
        endsAt: new Date(now + (finished ? -1000 : day)).toISOString(),
        updatedAt: new Date(now).toISOString(),
        participantCount: 1,
        participations: [
          {
            playerId: 1,
            player: { displayName: 'Winner' },
            deltas: metrics.map((metric) => ({ metric, values: { gained } })),
          },
        ],
      });
    };
    competitionRoutes(
      app,
      store,
      async (r, write) => {
        if (!r.headers['x-test-actor'])
          throw Object.assign(new Error('Sign in'), { statusCode: 401 });
        if (write && r.headers['x-test-csrf'] !== 'valid')
          throw Object.assign(new Error('Denied'), { statusCode: 403 });
        return {
          id: String(r.headers['x-test-actor']),
          displayName: 'Owner',
          role: 'admin',
        };
      },
      (address, clock, _fetch, signal, registry) =>
        fetchCompetition(address, clock, request, signal, registry),
      new PreviewWork(
        new WorkBudget({ concurrent: 2, perMinute: 100 }, [
          { concurrent: 1, perMinute: 100 },
        ]),
      ),
    );
    const headers = { 'x-test-actor': 'owner', 'x-test-csrf': 'valid' };
    const preview = (id = 123) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/admin/competitions/preview',
        headers,
        payload: {
          competitionUrl: 'https://wiseoldman.net/competitions/' + id,
        },
      });
    const prompt = async (id = 123) => {
      const response = await preview(id);
      assert.equal(response.statusCode, 422, response.body);
      assert.equal(response.json().code, 'UNKNOWN_WOM_METRICS');
      return response.json().resolution as CompetitionMetricResolution;
    };
    const definition = (metric = metrics[0]!): CustomCompetitionMetric => ({
      metric,
      name: 'Custom ' + metric,
      type: 'BOSS',
      pageIds: ['raid'],
    });
    const save = (
      p: CompetitionMetricResolution,
      definitions = [definition()],
      key = randomUUID(),
      actor = 'owner',
    ) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/admin/competitions/metrics',
        headers: { ...headers, 'x-test-actor': actor, 'idempotency-key': key },
        payload: {
          resolutionToken: p.resolutionToken,
          expectedRevision: p.revision,
          definitions,
        },
      });
    const apply = async (
      p: {
        previewToken: string;
        expectedRevision: string;
        scheduleRevision: string;
      },
      key = randomUUID(),
    ) =>
      store.apply(
        p.previewToken,
        p.expectedRevision,
        p.scheduleRevision,
        key,
        'owner',
        'Owner',
        'admin',
        true,
      );

    await t.test(
      'prompt is read-only, authorization is enforced, save/resume is durable and new previews reuse definitions',
      async () => {
        const p = await prompt();
        assert.deepEqual(p.unknownMetrics, ['new_raid']);
        assert.deepEqual(p.pages, [{ id: 'raid', name: 'New raid' }]);
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::int AS n FROM custom_competition_metrics',
            )
          ).rows[0].n,
          0,
        );
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::int AS n FROM collection_log_schedules',
            )
          ).rows[0].n,
          0,
        );
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: '/api/v1/admin/competitions/metrics',
              payload: {},
            })
          ).statusCode,
          401,
        );
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: '/api/v1/admin/competitions/metrics',
              headers: { 'x-test-actor': 'owner' },
              payload: {},
            })
          ).statusCode,
          403,
        );
        assert.equal(
          (await save(p, [definition()], randomUUID(), 'other')).statusCode,
          409,
        );
        assert.equal(
          (await save({ ...p, resolutionToken: 'B'.repeat(43) })).statusCode,
          409,
        );
        assert.equal(
          (await save(p, [definition('unrelated')])).statusCode,
          422,
        );
        const key = randomUUID();
        const saved = await save(p, [definition()], key);
        assert.equal(saved.statusCode, 200, saved.body);
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::int AS n FROM collection_log_schedules',
            )
          ).rows[0].n,
          0,
        );
        const ready = await preview();
        assert.equal(ready.statusCode, 200, ready.body);
        assert.equal(ready.json().competition.kind, 'ACTIVITY');
        assert.equal(
          ready.json().competition.metricDefinitions[0].definition.type,
          'BOSS',
        );
        assert.deepEqual(ready.json().pageIds, ['raid']);
        const importKey = randomUUID();
        const imported = await apply(ready.json(), importKey);
        assert.ok(imported.scheduleId);
        const restarted = new PgCompetitionStore(pool);
        assert.equal(
          (await restarted.metricRegistry.list()).definitions[0]?.type,
          'BOSS',
        );
        const fresh = await fetchCompetition(
          'https://wiseoldman.net/competitions/123',
          now,
          request,
          undefined,
          () => restarted.metricRegistry.list(),
        );
        assert.equal(competitionUnit(fresh.competition), 'Kills');
        await pool.query(
          "UPDATE competition_metric_resolutions SET expires_at=now()-interval '1 minute'",
        );
        assert.deepEqual(
          (await save(p, [definition()], key)).json(),
          saved.json(),
        );
        assert.equal((await save(p, [definition()])).statusCode, 409);
        assert.equal(
          (await save(p, [{ ...definition(), type: 'ACTIVITY' }], key))
            .statusCode,
          409,
        );
        assert.deepEqual(await apply(ready.json(), importKey), imported);
      },
    );

    await t.test(
      'batch saves roll back invalid or mixed definitions and concurrent equivalent saves reuse one definition',
      async () => {
        metrics = ['batch_a', 'batch_b'];
        const p = await prompt(124);
        const mixed = [
          definition('batch_a'),
          {
            ...definition('batch_b'),
            type: 'SKILL' as const,
            skill: 'attack' as const,
            pageIds: [],
          },
        ];
        assert.equal((await save(p, mixed)).statusCode, 422);
        assert.equal((await store.metricRegistry.list()).definitions.length, 1);
        assert.equal(
          (
            await save(p, [
              definition('batch_a'),
              { ...definition('batch_b'), pageIds: ['missing'] },
            ])
          ).statusCode,
          422,
        );
        assert.equal((await store.metricRegistry.list()).definitions.length, 1);
        const defs = metrics.map((m) => definition(m));
        const concurrent = await Promise.all([save(p, defs), save(p, defs)]);
        assert.ok(concurrent.every((r) => r.statusCode === 200));
        assert.equal((await store.metricRegistry.list()).definitions.length, 3);
        assert.equal(
          (
            await save(
              p,
              defs.map((d) => ({ ...d, name: 'Conflicting' })),
            )
          ).statusCode,
          409,
        );
        assert.equal(
          (await save(p, [definition('vardorvis')])).statusCode,
          422,
        );
      },
    );

    await t.test(
      'finished custom types retain exact amounts and frozen semantics; registry changes invalidate previews, not receipts',
      async () => {
        metrics = ['new_raid'];
        finished = true;
        const ready = await preview(125);
        assert.equal(ready.statusCode, 200, ready.body);
        assert.equal(ready.json().standings[0].gained, '25');
        const key = randomUUID();
        const receipt = await apply(ready.json(), key);
        const stored = (await store.activities()).competitions.find(
          (c) => c.id === 125,
        )!;
        assert.equal(competitionUnit(stored), 'Kills');
        gained = '1.5';
        assert.equal((await preview(125)).statusCode, 422);
        metrics = ['new_hours'];
        const p = await prompt(126);
        assert.equal(
          (await save(p, [{ ...definition(), type: 'COMPUTED', pageIds: [] }]))
            .statusCode,
          200,
        );
        const hours = await preview(126);
        assert.equal(hours.statusCode, 200, hours.body);
        assert.deepEqual(hours.json().pageIds, []);
        assert.equal(hours.json().standings[0].gained, '1.5');
        assert.equal(competitionUnit(hours.json().competition), 'Hours');
        await apply(hours.json());
        assert.deepEqual(await apply(ready.json(), key), receipt);
        await assert.rejects(apply(ready.json()), { status: 409 });
        assert.equal(
          (await pool.query('SELECT count(*)::int AS n FROM xp_events')).rows[0]
            .n,
          0,
        );
        metrics = ['new_attack'];
        gained = '9007199254740993';
        const skill = await prompt(127);
        assert.equal(
          (
            await save(skill, [
              { ...definition(), type: 'SKILL', skill: 'attack', pageIds: [] },
            ])
          ).statusCode,
          200,
        );
        const xp = await preview(127);
        assert.equal(xp.statusCode, 200, xp.body);
        assert.equal(xp.json().competition.kind, 'SKILL');
        assert.equal(
          xp.json().changes.find((c: { skill: string }) => c.skill === 'attack')
            .change,
          gained,
        );
        await apply(xp.json());
        const tracker = await new PgXpStore(pool).tracker();
        assert.equal(tracker.totals.attack, gained);
        assert.equal(
          tracker.events[0]?.competition?.metricDefinitions?.[0]?.definition
            ?.skill,
          'attack',
        );
        const changed = {
          ...stored,
          metricDefinitions: stored.metricDefinitions!.map((d) => ({
            ...d,
            definition: {
              ...d.definition!,
              type: 'COMPUTED' as const,
              pageIds: [],
            },
          })),
        };
        await assert.rejects(
          store.preview(
            {
              competition: changed,
              skills: [],
              lifecycle: 'finished',
              results: { participants: [] },
            },
            'owner',
          ),
          { status: 409 },
        );
      },
    );

    await t.test(
      'a failed audit atomically rolls back definitions and revision',
      async () => {
        metrics = ['audit_rollback'];
        finished = false;
        gained = '25';
        const p = await prompt(128);
        const before = await store.metricRegistry.list();
        await pool.query(
          "CREATE FUNCTION fail_metric_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$; CREATE TRIGGER fail_metric_audit BEFORE INSERT ON competition_metric_audit FOR EACH ROW EXECUTE FUNCTION fail_metric_audit()",
        );
        assert.equal((await save(p)).statusCode, 500);
        assert.deepEqual(await store.metricRegistry.list(), before);
        await pool.query(
          'DROP TRIGGER fail_metric_audit ON competition_metric_audit',
        );
        assert.equal((await save(p)).statusCode, 200);
      },
    );
    await t.test(
      'new built-in definitions take precedence over old custom registry rows during registration',
      async () => {
        // Simulate a definition saved before a later release added this built-in.
        await pool.query(
          'INSERT INTO custom_competition_metrics(metric,definition,actor_id) VALUES($1,$2,$3)',
          [
            'vardorvis',
            JSON.stringify({ ...definition('vardorvis'), type: 'ACTIVITY' }),
            'owner',
          ],
        );
        metrics = ['vardorvis', 'future_boss'];
        const p = await prompt(131);
        assert.deepEqual(p.unknownMetrics, ['future_boss']);
        const saved = await save(p, [definition('future_boss')]);
        assert.equal(saved.statusCode, 200, saved.body);
        const ready = await preview(131);
        assert.equal(ready.statusCode, 200, ready.body);
        assert.equal(
          ready.json().competition.metricDefinitions[0].definition,
          undefined,
        );
      },
    );
    metrics = ['bad/key'];
    await assert.rejects(
      fetchCompetition('https://wiseoldman.net/competitions/129', now, request),
      (e: unknown) => !(e instanceof UnknownCompetitionMetrics),
    );
    metrics = ['attack', 'vardorvis', 'another_unknown'];
    await assert.rejects(
      fetchCompetition('https://wiseoldman.net/competitions/130', now, request),
      (e: unknown) =>
        e instanceof Error &&
        /Mixed/.test(e.message) &&
        !(e instanceof UnknownCompetitionMetrics),
    );
  },
);
