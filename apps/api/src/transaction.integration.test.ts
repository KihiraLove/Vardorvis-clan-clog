/** Real PostgreSQL boundaries, credit races, lock order and uncertain COMMIT cleanup. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import pg from 'pg';
import { transaction } from './transaction.js';
import { PgReviewStore } from './review-store.js';
import { PgStore } from './store.js';
import { PgCompetitionStore } from './competition-store.js';
import { fetchCompetition } from './competition-wom.js';

test(
  'common transaction plumbing preserves store invariants on PostgreSQL',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const connectionString = process.env.TEST_DATABASE_URL!;
    const root = new pg.Pool({ connectionString });
    const schema = 'transactions_' + randomUUID().replaceAll('-', '');
    await root.query('CREATE SCHEMA ' + schema);
    const pool = new pg.Pool({
      connectionString,
      options: '-c search_path=' + schema,
      max: 12,
      statement_timeout: 5000,
    });
    const reviews = new PgReviewStore(pool, new PgStore(pool));
    const fields = (itemId: number, approve = true) => ({
      itemId,
      collectorName: 'Collector',
      collectedOn: '2026-01-01',
      hardcore: false,
      approve,
      reason: 'verified',
    });
    try {
      const migrations = new URL(
        '../../../packages/database/migrations/',
        import.meta.url,
      );
      for (const name of (await readdir(migrations))
        .filter((n) => n.endsWith('.sql'))
        .sort())
        await pool.query(await readFile(new URL(name, migrations), 'utf8'));
      await pool.query(
        "INSERT INTO items(id,name) SELECT n,'Item ' || n FROM generate_series(900001,900010) n",
      );

      await t.test(
        'write, snapshot and preview retain their actual isolation and read-only modes',
        async () => {
          for (const [mode, isolation, readOnly] of [
            ['write', 'read committed', 'off'],
            ['snapshot', 'repeatable read', 'on'],
            ['preview', 'repeatable read', 'off'],
          ] as const) {
            const value = await transaction(
              pool,
              mode,
              async (client) =>
                (
                  await client.query(
                    "SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS readonly",
                  )
                ).rows[0],
            );
            assert.deepEqual(value, { isolation, readonly: readOnly });
          }
          await assert.rejects(
            transaction(pool, 'snapshot', (client) =>
              client.query("UPDATE items SET name='forbidden' WHERE id=900001"),
            ),
            { code: '25006' },
          );
          assert.equal(
            (await pool.query('SELECT name FROM items WHERE id=900001')).rows[0]
              .name,
            'Item 900001',
          );
        },
      );

      await t.test(
        'domain and SQL failures roll back without replacing their errors or leaking a transaction',
        async () => {
          const original = new Error('original operation failure');
          await assert.rejects(
            transaction(pool, 'write', async (client) => {
              await client.query(
                "UPDATE items SET name='rolled back' WHERE id=900001",
              );
              throw original;
            }),
            (error) => error === original,
          );
          await assert.rejects(
            transaction(pool, 'write', async (client) => {
              await client.query(
                "UPDATE items SET name='rolled back again' WHERE id=900001",
              );
              await client.query('SELECT 1/0');
            }),
            { code: '22012' },
          );
          assert.equal(
            (await pool.query('SELECT name FROM items WHERE id=900001')).rows[0]
              .name,
            'Item 900001',
          );
        },
      );

      await t.test(
        'manual receipt replay and competing filtered Regular credits remain atomic',
        async () => {
          const filters = await reviews.submissionFilters();
          await reviews.saveSubmissionFilters(true, filters.revision, 'actor');
          const key = randomUUID();
          const replays = await Promise.all([
            reviews.createManual(fields(900002), 'actor', 'Staff', key),
            reviews.createManual(fields(900002), 'actor', 'Staff', key),
          ]);
          assert.deepEqual(replays[0], replays[1]);
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int AS n FROM manual_submission_requests WHERE request_key=$1',
                [key],
              )
            ).rows[0].n,
            1,
          );
          const race = await Promise.allSettled([
            reviews.createManual(
              fields(900003),
              'actor',
              'Staff',
              randomUUID(),
            ),
            reviews.createManual(
              fields(900003),
              'actor',
              'Staff',
              randomUUID(),
            ),
          ]);
          assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
          assert.equal(
            race.filter(
              (r) => r.status === 'rejected' && r.reason.status === 409,
            ).length,
            1,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM submissions WHERE item_id=900003 AND status='approved'",
              )
            ).rows[0].n,
            1,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int AS n FROM audit_events a JOIN submissions s ON s.id=a.submission_id WHERE s.item_id=900003',
              )
            ).rows[0].n,
            1,
          );
          const enabledFilters = await reviews.submissionFilters();
          await reviews.saveSubmissionFilters(
            false,
            enabledFilters.revision,
            'actor',
          );
        },
      );

      await t.test(
        'manual intake bypasses scheduling while competition apply waits before acquiring later locks',
        async () => {
          const competitors = new PgCompetitionStore(pool),
            now = await competitors.clock();
          const snapshot = await fetchCompetition(
            'https://wiseoldman.net/competitions/80001',
            now,
            async () =>
              Response.json({
                id: 80001,
                title: 'Skill',
                startsAt: new Date(now - 100000).toISOString(),
                endsAt: new Date(now - 10000).toISOString(),
                updatedAt: new Date(now).toISOString(),
                metrics: [{ metric: 'attack' }],
                participantCount: 0,
                participations: [],
              }),
          );
          const preview = await competitors.preview(snapshot, 'actor');
          const blocker = await pool.connect();
          const queries: { pid: number; sql: string }[] = [];
          const observed = new Proxy(pool, {
            get(target, property) {
              if (property !== 'connect') return Reflect.get(target, property);
              return async () => {
                const client = await pool.connect();
                const pid = (
                  await client.query('SELECT pg_backend_pid() AS pid')
                ).rows[0].pid;
                return new Proxy(client, {
                  get(target, property) {
                    if (property === 'query')
                      return (...args: unknown[]) => {
                        if (typeof args[0] === 'string')
                          queries.push({ pid, sql: args[0] });
                        return Reflect.apply(client.query, client, args);
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
          let jobs: Promise<unknown>[] = [];
          try {
            await blocker.query('BEGIN');
            await blocker.query(
              'SELECT singleton FROM collection_scheduling WHERE singleton FOR UPDATE',
            );
            jobs = [
              new PgReviewStore(pool, new PgStore(pool)).createManual(
                fields(900004),
                'actor',
                'Staff',
                randomUUID(),
              ),
              new PgCompetitionStore(observed).apply(
                preview.previewToken,
                preview.expectedRevision,
                preview.scheduleRevision,
                randomUUID(),
                'actor',
                'Staff',
                'admin',
                false,
              ),
            ];
            await jobs[0];
            assert.equal(
              (
                await pool.query(
                  "SELECT count(*)::int AS n FROM submissions WHERE item_id=900004 AND status='approved'",
                )
              ).rows[0].n,
              1,
            );
            // Observe real PostgreSQL waiters rather than assuming a timer means contention.
            const deadline = Date.now() + 3000;
            let waiting = false;
            while (Date.now() < deadline) {
              const pids = [
                ...new Set(
                  queries
                    .filter((q) => q.sql.includes('collection_scheduling'))
                    .map((q) => q.pid),
                ),
              ];
              if (
                pids.length === 1 &&
                (
                  await pool.query(
                    'SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=ANY($1::int[]) AND cardinality(pg_blocking_pids(pid))>0',
                    [pids],
                  )
                ).rows[0].n === 1
              ) {
                waiting = true;
                break;
              }
              await delay(10);
            }
            assert.equal(
              waiting,
              true,
              'competition apply must wait on the scheduling gate',
            );
            assert.ok(
              !queries.some((q) =>
                /xp_state|FROM items|pg_advisory_xact_lock/u.test(q.sql),
              ),
              'no later domain lock may precede scheduling',
            );
            await blocker.query('COMMIT');
            await Promise.all(jobs);
          } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
            await Promise.allSettled(jobs);
          }
        },
      );

      await t.test(
        'lost commit acknowledgement plus failed rollback preserves uncertainty and replays exactly once',
        async () => {
          const original = new Error('commit acknowledgement lost');
          let committed = false,
            discarded = false,
            commits = 0;
          const injected = new Proxy(pool, {
            get(target, property) {
              if (property !== 'connect') return Reflect.get(target, property);
              return async () => {
                const client = await pool.connect();
                return new Proxy(client, {
                  get(target, property) {
                    if (property === 'release')
                      return (discard?: boolean) => {
                        discarded = discard === true;
                        client.release(discard);
                      };
                    if (property === 'query')
                      return async (...args: unknown[]) => {
                        if (args[0] === 'ROLLBACK' && committed)
                          throw new Error('secondary rollback failure');
                        const result = await Reflect.apply(
                          client.query,
                          client,
                          args,
                        );
                        if (args[0] === 'COMMIT') {
                          commits++;
                          committed = true;
                          throw original;
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
          const key = randomUUID();
          await assert.rejects(
            new PgReviewStore(injected, new PgStore(pool)).createManual(
              fields(900005),
              'actor',
              'Staff',
              key,
            ),
            (error) => error === original,
          );
          assert.equal(discarded, true);
          assert.equal(commits, 1, 'the helper must not retry a write');
          const replay = await reviews.createManual(
            fields(900005),
            'actor',
            'Staff',
            key,
          );
          assert.equal(replay.status, 'approved');
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int AS n FROM submissions WHERE item_id=900005',
              )
            ).rows[0].n,
            1,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int AS n FROM audit_events WHERE submission_id=$1',
                [replay.id],
              )
            ).rows[0].n,
            1,
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
