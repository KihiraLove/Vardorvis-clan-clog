/** End-to-end PostgreSQL socket failures against the production API entry point. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import pg from 'pg';

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      if (!address || typeof address === 'string')
        return reject(new Error('Unexpected listener address'));
      socket.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

test(
  'the running API survives idle and active PostgreSQL backend termination, restores readiness and shuts down cleanly',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 45000 },
  async (t) => {
    const schema = 'pool_lifecycle_' + randomUUID().replaceAll('-', '');
    const application = 'clog_pool_test_' + randomUUID().replaceAll('-', '');
    const root = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL!,
      max: 3,
    });
    const schemaPool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL!,
      options: '-c search_path=' + schema,
    });
    let child: ReturnType<typeof spawn> | undefined;
    let logs = '';
    const port = await availablePort();
    const base = `http://127.0.0.1:${port}`;
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', '-c search_path=' + schema);
    url.searchParams.set('application_name', application);

    const status = async (path: string) => {
      const result = await fetch(base + path, {
        signal: AbortSignal.timeout(6500),
      });
      await result.body?.cancel();
      return result.status;
    };
    const waitUntil = async (fn: () => Promise<boolean> | boolean) => {
      for (let n = 0; n < 75; n++) {
        if (child && child.exitCode !== null)
          throw new Error(
            'API unexpectedly exited with code ' + child.exitCode,
          );
        if (await fn()) return;
        await delay(80);
      }
      throw new Error('Timed out waiting for PostgreSQL/API state');
    };
    const pidFor = async (state: string, blocking = false) => {
      const result = await root.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity WHERE application_name=$1
           AND state=$2
           AND ($3::boolean=false OR (wait_event_type='Lock' AND query LIKE '%site_settings%'))
           ORDER BY backend_start DESC LIMIT 1`,
        [application, state, blocking],
      );
      return result.rows[0]?.pid;
    };
    let blocker: pg.PoolClient | undefined;
    try {
      await root.query('CREATE SCHEMA ' + schema);
      const migrations = new URL(
        '../../../packages/database/migrations/',
        import.meta.url,
      );
      for (const file of (await readdir(migrations))
        .filter((name) => name.endsWith('.sql'))
        .sort())
        await schemaPool.query(
          await readFile(new URL(file, migrations), 'utf8'),
        );

      child = spawn(
        process.execPath,
        [new URL('./server.js', import.meta.url).pathname],
        {
          env: {
            ...process.env,
            DATABASE_URL: url.toString(),
            HOST: '127.0.0.1',
            PORT: String(port),
            AUTH_ENABLED: 'false',
            BOT_ENABLED: 'false',
            BOT_API_TOKEN: '',
            DISCORD_GUILD_ID: '',
            ICON_STORAGE_PATH: '',
            PROOF_STORAGE_PATH: '',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      child.stdout?.on('data', (chunk: Buffer) => {
        logs += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        logs += chunk.toString();
      });
      await t.test('initial health and readiness succeed', async () => {
        await waitUntil(async () => {
          try {
            return (await status('/readyz')) === 200;
          } catch {
            return false;
          }
        });
        assert.equal(await status('/healthz'), 200);
      });

      await t.test(
        'idle backend disconnect is sanitized and does not crash the process',
        async () => {
          let idle: number | undefined;
          await waitUntil(async () => {
            idle = await pidFor('idle');
            return idle !== undefined;
          });
          const terminated = await root.query<{ stopped: boolean }>(
            'SELECT pg_terminate_backend($1) AS stopped',
            [idle],
          );
          assert.equal(terminated.rows[0]?.stopped, true);
          await waitUntil(() => logs.includes('PostgreSQL idle pool failure:'));
          assert.doesNotMatch(logs, /postgresql:/iu);
          assert.ok(child && child.exitCode === null);
          assert.equal(await status('/healthz'), 200);
          assert.equal(await status('/readyz'), 200);
        },
      );

      await t.test(
        'active read abort returns 503; readiness recovers on another connection',
        async () => {
          blocker = await root.connect();
          await blocker.query('BEGIN');
          await blocker.query(
            'LOCK TABLE ' + schema + '.site_settings IN ACCESS EXCLUSIVE MODE',
          );
          const pending = status('/readyz');
          let active: number | undefined;
          await waitUntil(async () => {
            active = await pidFor('active', true);
            return active !== undefined;
          });
          assert.equal(
            (
              await root.query<{ stopped: boolean }>(
                'SELECT pg_terminate_backend($1) AS stopped',
                [active],
              )
            ).rows[0]?.stopped,
            true,
          );
          assert.equal(await pending, 503);
          await blocker.query('ROLLBACK');
          blocker.release();
          blocker = undefined;
          assert.equal(await status('/healthz'), 200);
          await waitUntil(async () => (await status('/readyz')) === 200);
        },
      );

      await t.test(
        'normal shutdown after recovered database failures is clean',
        async () => {
          assert.ok(child && child.exitCode === null);
          const current = child;
          const finished = new Promise<{
            code: number | null;
            signal: string | null;
          }>((resolve) =>
            current.once('exit', (code, signal) => resolve({ code, signal })),
          );
          current.kill('SIGTERM');
          const result = await Promise.race([
            finished,
            delay(8000).then(() => {
              throw new Error('API failed to shut down');
            }),
          ]);
          assert.deepEqual(result, { code: 0, signal: null });
        },
      );
    } finally {
      if (blocker) {
        await blocker.query('ROLLBACK').catch(() => {});
        blocker.release();
      }
      if (child && child.exitCode === null) {
        child.kill('SIGKILL');
        await new Promise<void>((resolve) =>
          child!.once('exit', () => resolve()),
        );
      }
      await schemaPool.end();
      await root.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
      await root.end();
    }
  },
);
