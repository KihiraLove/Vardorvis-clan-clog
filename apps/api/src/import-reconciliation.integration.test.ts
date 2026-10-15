/** Both public protocols exercise one reconciler against disposable PostgreSQL. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import Fastify from 'fastify';
import { PgCompetitionStore } from './competition-store.js';
import { PgXpStore } from './xp-store.js';
import { fetchCompetition } from './competition-wom.js';
import type { CompetitionSnapshot } from './competition-types.js';
import { xpAdminRoutes } from './xp-routes.js';
import { competitionRoutes } from './competition-routes.js';

test(
  'shared imports retain both protocols and reconstruct activity corrections',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const connectionString = process.env.TEST_DATABASE_URL!;
    const root = new pg.Pool({ connectionString });
    const schema = 'reconciliation_' + randomUUID().replaceAll('-', '');
    await root.query('CREATE SCHEMA ' + schema);
    const pool = new pg.Pool({
      connectionString,
      options: '-c search_path=' + schema,
      max: 12,
      statement_timeout: 5000,
    });
    const competitions = new PgCompetitionStore(pool),
      xp = new PgXpStore(pool);
    const now = await competitions.clock();
    const source = (
      id: number,
      metric: string,
      amount: string,
      name = 'Player',
      playerId = 1,
    ) =>
      fetchCompetition(
        'https://wiseoldman.net/competitions/' + id,
        now,
        async () =>
          Response.json({
            id,
            title: 'Event ' + id,
            metrics: [{ metric }],
            startsAt: new Date(now - 3 * 86400000).toISOString(),
            endsAt: new Date(now - 86400000).toISOString(),
            updatedAt: new Date(now).toISOString(),
            participantCount: 1,
            participations: [
              {
                playerId,
                player: { displayName: name },
                deltas: [{ metric, values: { gained: amount } }],
              },
            ],
          }),
      );
    type Preview = Awaited<ReturnType<typeof competitions.preview>>;
    const apply = (
      p: Preview,
      key = randomUUID(),
      ack = false,
      service = competitions,
      role: 'admin' | 'moderator' = 'admin',
    ) =>
      service.apply(
        p.previewToken,
        p.expectedRevision,
        p.scheduleRevision,
        key,
        'actor',
        'Staff',
        role,
        ack,
      );
    const legacyApply = (
      p: Pick<
        Awaited<ReturnType<typeof xp.preview>>,
        'previewToken' | 'expectedRevision'
      >,
      key = randomUUID(),
      ack = false,
      service = xp,
    ) =>
      service.apply(
        p.previewToken,
        p.expectedRevision,
        key,
        'actor',
        'Staff',
        ack,
      );
    try {
      const migrations = new URL(
        '../../../packages/database/migrations/',
        import.meta.url,
      );
      for (const file of (await readdir(migrations))
        .filter((f) => f.endsWith('.sql'))
        .sort())
        await pool.query(await readFile(new URL(file, migrations), 'utf8'));

      await t.test(
        'legacy and unified HTTP contracts retain their wire shapes over the real shared store',
        async () => {
          const s = await source(7090, 'woodcutting', '9007199254740993');
          const app = Fastify({ logger: false });
          const authorize = async () => ({
            id: 'actor',
            displayName: 'Staff',
            role: 'admin' as const,
          });
          xpAdminRoutes(app, xp, authorize, async () => s.results!.xp!);
          competitionRoutes(app, competitions, authorize, async () => s);
          try {
            const preview = async (path: string) => {
              const result = await app.inject({
                method: 'POST',
                url: path,
                payload: { competitionUrl: s.competition.sourceUrl },
              });
              assert.equal(result.statusCode, 200, result.body);
              return result.json();
            };
            const legacy = await preview('/api/v1/admin/xp/imports/preview');
            const current = await preview('/api/v1/admin/competitions/preview');
            assert.deepEqual(legacy.changes, current.changes);
            assert.deepEqual(legacy.participants, current.participants);
            assert.equal(legacy.expectedRevision, current.expectedRevision);
            assert.deepEqual(
              Object.keys(legacy).sort(),
              [
                'previewToken',
                'expectedRevision',
                'expiresAt',
                'competition',
                'participants',
                'changes',
                'warnings',
              ].sort(),
            );
            assert.deepEqual(current.pageIds, []);
            const oldResult = await app.inject({
              method: 'POST',
              url: '/api/v1/admin/xp/imports',
              headers: { 'idempotency-key': randomUUID() },
              payload: {
                previewToken: legacy.previewToken,
                expectedRevision: legacy.expectedRevision,
              },
            });
            assert.equal(oldResult.statusCode, 200, oldResult.body);
            assert.deepEqual(Object.keys(oldResult.json()).sort(), [
              'outcome',
              'revision',
            ]);
            const fresh = await preview('/api/v1/admin/competitions/preview');
            const newResult = await app.inject({
              method: 'POST',
              url: '/api/v1/admin/competitions/imports',
              headers: { 'idempotency-key': randomUUID() },
              payload: {
                previewToken: fresh.previewToken,
                expectedRevision: fresh.expectedRevision,
                scheduleRevision: fresh.scheduleRevision,
              },
            });
            assert.equal(newResult.statusCode, 200, newResult.body);
            assert.deepEqual(newResult.json(), {
              outcome: 'unchanged',
              revision: oldResult.json().revision,
              scheduleId: null,
            });
            assert.equal(
              (await xp.tracker()).totals.woodcutting,
              '9007199254740993',
            );
          } finally {
            await app.close();
          }
        },
      );

      await t.test(
        'old/new previews and receipts agree for exact, unchanged, incremental and negative XP',
        async () => {
          for (const [amount, legacy] of [
            ['9007199254740993', true],
            ['9007199254740993', false],
            ['9007199254741003', false],
            ['7', true],
          ] as const) {
            const s = await source(7001, 'mining', amount);
            const old = await xp.preview(s.results!.xp!, 'actor'),
              current = await competitions.preview(s, 'actor');
            assert.equal(old.expectedRevision, current.expectedRevision);
            assert.deepEqual(old.changes, current.changes);
            assert.deepEqual(old.participants, current.participants);
            assert.deepEqual(old.competition.skills, s.skills);
            assert.equal(old.competition.id, current.competition.id);
            assert.deepEqual(current.pageIds, []);
            assert.equal(current.scheduleStartsAt, null);
            if (BigInt(old.changes[0]!.change) < 0n) {
              await assert.rejects(legacyApply(old), { status: 422 });
              await assert.rejects(apply(current), { status: 422 });
            }
            const receipt = legacy
              ? await legacyApply(old, randomUUID(), true)
              : await apply(current, randomUUID(), true);
            assert.equal((await xp.tracker()).totals.mining, amount);
            assert.equal(
              receipt.outcome,
              old.changes[0]!.change === '0' ? 'unchanged' : 'applied',
            );
            if (receipt.outcome === 'applied')
              await assert.rejects(legacy ? apply(current) : legacyApply(old), {
                status: 409,
              });
          }
          const roster = await source(7001, 'mining', '7', 'Renamed', 2);
          assert.match(
            (await xp.preview(roster.results!.xp!, 'actor')).warnings.join(' '),
            /roster changed/,
          );
          assert.match(
            (await competitions.preview(roster, 'actor')).warnings.join(' '),
            /roster changed/,
          );
        },
      );

      await t.test(
        'both protocols serialize one identity and reject stale cross-protocol races',
        async () => {
          const s = await source(7002, 'attack', '15');
          const old = await xp.preview(s.results!.xp!, 'actor'),
            current = await competitions.preview(s, 'actor');
          const results = await Promise.allSettled([
            legacyApply(old),
            apply(current),
          ]);
          assert.equal(
            results.filter((r) => r.status === 'fulfilled').length,
            1,
          );
          assert.equal(
            results.filter(
              (r) => r.status === 'rejected' && r.reason.status === 409,
            ).length,
            1,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int AS n FROM xp_events WHERE competition_id=7002',
              )
            ).rows[0].n,
            1,
          );
          assert.equal((await xp.tracker()).totals.attack, '15');
          const p = await competitions.preview(
              await source(7002, 'attack', '20'),
              'actor',
            ),
            key = randomUUID();
          await assert.rejects(
            apply(p, key, false, competitions, 'moderator'),
            { status: 403 },
          );
          const receipts = await Promise.all([apply(p, key), apply(p, key)]);
          assert.deepEqual(receipts[0], receipts[1]);
          await assert.rejects(
            apply(p, key, false, competitions, 'moderator'),
            { status: 403 },
          );
        },
      );

      for (const legacy of [true, false]) {
        await t.test(
          `${legacy ? 'legacy' : 'unified'} receipt survives lost COMMIT response and removed preview`,
          async () => {
            let loseAcknowledgement = true;
            const injected = new Proxy(pool, {
              get(target, property) {
                if (property !== 'connect')
                  return Reflect.get(target, property);
                return async () => {
                  const client = await pool.connect();
                  return new Proxy(client, {
                    get(target, property) {
                      if (property === 'query')
                        return async (...args: unknown[]) => {
                          const result = await Reflect.apply(
                            client.query,
                            client,
                            args,
                          );
                          if (args[0] === 'COMMIT' && loseAcknowledgement) {
                            loseAcknowledgement = false;
                            throw new Error(
                              'Injected lost commit acknowledgement',
                            );
                          }
                          return result;
                        };
                      const value = Reflect.get(target, property);
                      return typeof value === 'function'
                        ? value.bind(target)
                        : value;
                    },
                  });
                };
              },
            });
            const s = await source(legacy ? 7003 : 7004, 'defence', '42');
            const key = randomUUID();
            const p = legacy
              ? await xp.preview(s.results!.xp!, 'actor')
              : await competitions.preview(s, 'actor');
            const run = () =>
              legacy
                ? legacyApply(p, key, false, new PgXpStore(injected))
                : apply(
                    p as Preview,
                    key,
                    false,
                    new PgCompetitionStore(injected),
                  );
            await assert.rejects(run(), /lost commit acknowledgement/);
            const first = (
              await pool.query(
                'SELECT receipt FROM competition_import_history WHERE actor_id=$1 AND request_key=$2',
                ['actor', key],
              )
            ).rows[0].receipt;
            await pool.query(
              legacy
                ? 'DELETE FROM xp_previews'
                : 'DELETE FROM competition_previews',
            );
            // Simulate a historical XP-only receipt that predates the shared audit.
            if (legacy)
              await pool.query(
                'DELETE FROM competition_import_history WHERE request_key=$1',
                [key],
              );
            const replay = await run();
            assert.deepEqual(
              replay,
              legacy
                ? { outcome: first.outcome, revision: first.revision }
                : first,
            );
            await assert.rejects(
              legacy
                ? legacyApply(p, key, true)
                : apply(p as Preview, key, true),
              { status: 409 },
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT count(*)::int AS n FROM xp_import_history WHERE request_key=$1',
                  [key],
                )
              ).rows[0].n,
              1,
            );
          },
        );
      }

      await t.test(
        'complete activity before/after evidence reconstructs successive increases, reductions, roster changes and zero',
        async () => {
          const snapshots: CompetitionSnapshot[] = [];
          for (const [amount, name, playerId] of [
            ['9007199254740993', 'First', 1],
            ['9007199254740999', 'Renamed', 1],
            ['5', 'Replacement', 2],
            ['0', 'Replacement', 2],
          ] as const) {
            const s = await source(7010, 'vardorvis', amount, name, playerId);
            snapshots.push(s);
            const p = await competitions.preview(s, 'actor'),
              key = randomUUID();
            const receipts = await Promise.all([apply(p, key), apply(p, key)]);
            assert.deepEqual(receipts[0], receipts[1]);
            const audit = (
              await pool.query(
                'SELECT old_values,new_values,receipt FROM competition_import_history WHERE request_key=$1',
                [key],
              )
            ).rows[0];
            assert.equal(audit.new_values.resultsEvidenceVersion, 1);
            assert.deepEqual(
              audit.new_values.activityResults,
              s.results!.participants,
            );
            assert.deepEqual(
              audit.old_values?.activityResults ?? null,
              snapshots.at(-2)?.results!.participants ?? null,
            );
            assert.deepEqual(audit.receipt, receipts[0]);
            assert.deepEqual(
              (
                await pool.query(
                  'SELECT activity_results FROM wom_competitions WHERE competition_id=7010',
                )
              ).rows[0].activity_results,
              s.results!.participants,
            );
            await pool.query('DELETE FROM competition_previews');
            assert.deepEqual(await apply(p, key), receipts[0]);
          }
          const audits = (
            await pool.query(
              'SELECT old_values,new_values FROM competition_import_history WHERE competition_id=7010 ORDER BY imported_at,id',
            )
          ).rows;
          assert.deepEqual(
            audits.map((r) => r.new_values.activityResults),
            snapshots.map((s) => s.results!.participants),
          );
          for (let i = 1; i < audits.length; i++)
            assert.deepEqual(
              audits[i].old_values.activityResults,
              audits[i - 1].new_values.activityResults,
            );
          const unchanged = await competitions.preview(
            snapshots.at(-1)!,
            'actor',
          );
          assert.equal((await apply(unchanged)).outcome, 'unchanged');
          const publicData = JSON.stringify(await competitions.activities());
          assert.ok(
            !/First|Renamed|Replacement|activityResults|gained|participants/u.test(
              publicData,
            ),
          );
          assert.equal((await xp.tracker()).totals.mining, '7');
        },
      );

      await t.test(
        'failed evidence insert rolls back results, revision and receipt together',
        async () => {
          const before = (
            await pool.query(
              'SELECT activity_results,source_hash FROM wom_competitions WHERE competition_id=7010',
            )
          ).rows;
          const revision = (await xp.tracker()).revision;
          const p = await competitions.preview(
              await source(7010, 'vardorvis', '21'),
              'actor',
            ),
            key = randomUUID();
          await pool.query(
            "CREATE FUNCTION fail_import_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected audit failure'; END $$; CREATE TRIGGER fail_import_audit BEFORE INSERT ON competition_import_history FOR EACH ROW EXECUTE FUNCTION fail_import_audit()",
          );
          try {
            await assert.rejects(apply(p, key), /injected audit failure/);
          } finally {
            await pool.query(
              'DROP TRIGGER fail_import_audit ON competition_import_history; DROP FUNCTION fail_import_audit()',
            );
          }
          assert.deepEqual(
            (
              await pool.query(
                'SELECT activity_results,source_hash FROM wom_competitions WHERE competition_id=7010',
              )
            ).rows,
            before,
          );
          assert.equal((await xp.tracker()).revision, revision);
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM competition_import_history WHERE request_key=$1',
                [key],
              )
            ).rowCount,
            0,
          );
          assert.equal((await apply(p, key)).outcome, 'applied');
        },
      );

      await t.test(
        'one actor/key cannot write through the other protocol',
        async () => {
          const s = await source(7020, 'magic', '12'),
            key = randomUUID();
          await legacyApply(await xp.preview(s.results!.xp!, 'actor'), key);
          await assert.rejects(
            apply(await competitions.preview(s, 'actor'), key),
            { status: 409 },
          );
          const activityKey = randomUUID();
          await apply(
            await competitions.preview(
              await source(7021, 'vardorvis', '12'),
              'actor',
            ),
            activityKey,
          );
          await assert.rejects(
            legacyApply(await xp.preview(s.results!.xp!, 'actor'), activityKey),
            { status: 409 },
          );
        },
      );
    } finally {
      await pool.end();
      await root.query('DROP SCHEMA ' + schema + ' CASCADE');
      await root.end();
    }
  },
);
