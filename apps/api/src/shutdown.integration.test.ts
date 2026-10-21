import { botRequest, screenshotRecord } from './tests/screenshot.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/** Real signals during locked query and deferred COMMIT against the production entry point. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import pg from 'pg';
import { PgStore } from './store.js';
import { claimHash } from './intake.js';
async function port() {
  return new Promise<number>((resolve, reject) => {
    const socket = createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      if (!address || typeof address === 'string')
        return reject(Error('No address'));
      socket.close(() => resolve(address.port));
    });
  });
}
for (const phase of ['query', 'commit'] as const)
  test(
    'SIGTERM during ' +
      phase +
      ' drains the durable receipt before closing the production API pool',
    { skip: !process.env.TEST_DATABASE_URL, timeout: 30000 },
    async () => {
      const database = 'shutdown_' + randomUUID().replaceAll('-', ''),
        appName = 'clog_shutdown_' + database;
      const root = new pg.Pool({
        connectionString: process.env.TEST_DATABASE_URL!,
      });
      // Isolate the deliberate query/COMMIT stalls from other fixtures'
      // database-wide advisory locks and fixed Discord interaction IDs.
      await root.query('CREATE DATABASE ' + database);
      const url = new URL(process.env.TEST_DATABASE_URL!);
      url.pathname = '/' + database;
      url.searchParams.delete('options');
      url.searchParams.set('application_name', appName);
      const directory = await mkdtemp(join(tmpdir(), 'clog-shutdown-proof-'));
      const pool = new pg.Pool({ connectionString: url.toString() });
      const listen = await port(),
        base = 'http://127.0.0.1:' + listen,
        token = 'a'.repeat(64),
        guild = '234567890123456789';
      const input = {
        interactionId:
          phase === 'query' ? '345678901234567891' : '345678901234567892',
        guildId: guild,
        actorDiscordId: '123456789012345678',
        rawItemText: 'Item',
        itemId: 42,
        collectorName: 'Fixture',
        hardcore: false,
      };
      let child: ReturnType<typeof spawn> | undefined,
        logs = '',
        blocker: pg.PoolClient | undefined;
      const until = async (check: () => Promise<boolean>) => {
        for (let n = 0; n < 100; n++) {
          if (await check()) return;
          await delay(30);
        }
        throw Error('State timeout: ' + logs);
      };
      try {
        const dir = new URL(
          '../../../packages/database/migrations/',
          import.meta.url,
        );
        for (const file of (await readdir(dir))
          .filter((s) => s.endsWith('.sql'))
          .sort())
          await pool.query(await readFile(new URL(file, dir), 'utf8'));
        await pool.query(
          "INSERT INTO items(id,name,icon_path)VALUES(42,'Item','/items/42.png')",
        );
        child = spawn(
          process.execPath,
          [new URL('./server.js', import.meta.url).pathname],
          {
            env: {
              ...process.env,
              DATABASE_URL: url.toString(),
              HOST: '127.0.0.1',
              PORT: String(listen),
              AUTH_ENABLED: 'false',
              BOT_ENABLED: 'false',
              BOT_API_TOKEN: token,
              DISCORD_GUILD_ID: guild,
              ICON_STORAGE_PATH: '',
              PROOF_STORAGE_PATH: directory,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        child.stdout!.on('data', (s) => {
          logs += s;
        });
        child.stderr!.on('data', (s) => {
          logs += s;
        });
        const exited = new Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
        }>((resolve) =>
          child!.once('exit', (code, signal) => resolve({ code, signal })),
        );
        await until(async () => {
          try {
            // The upload needs a fresh connection, not an idle health socket
            // that can expire while a busy runner prepares the request.
            return (
              await fetch(base + '/healthz', {
                headers: { connection: 'close' },
              })
            ).ok;
          } catch {
            return false;
          }
        });
        blocker = await pool.connect();
        if (phase === 'query') {
          await blocker.query('BEGIN');
          await blocker.query(
            'LOCK TABLE submissions IN ACCESS EXCLUSIVE MODE',
          );
        } else {
          await pool.query(
            'CREATE FUNCTION hold_commit()RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(891234); RETURN NEW;END;$$; CREATE CONSTRAINT TRIGGER hold_receipt AFTER INSERT ON submissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hold_commit()',
          );
          await blocker.query('SELECT pg_advisory_lock(891234)');
        }
        const upload = await botRequest(input, {
          authorization: 'Bearer ' + token,
        });
        const response = fetch(base + '/api/v1/bot/submissions', {
          method: 'POST',
          headers: upload.headers,
          body: new Uint8Array(upload.payload),
        });
        await until(
          async () =>
            !!(
              await root.query(
                "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE $2",
                [appName, phase === 'commit' ? 'COMMIT%' : '%submissions%'],
              )
            ).rowCount,
        );
        child.kill('SIGTERM');
        child.kill('SIGTERM');
        await delay(100);
        assert.equal(child.exitCode, null);
        if (phase === 'query') await blocker.query('COMMIT');
        else await blocker.query('SELECT pg_advisory_unlock(891234)');
        const result = await response,
          receipt = (await result.json()) as { submissionId: string };
        assert.equal(result.status, 201);
        assert.ok(receipt.submissionId);
        assert.deepEqual(await exited, { code: 0, signal: null }, logs);
        assert.equal(
          (await pool.query('SELECT count(*)::int AS n FROM submissions'))
            .rows[0].n,
          1,
        );
        const replay = await new PgStore(pool).submitClaim(
          { ...input, image: screenshotRecord() },
          claimHash({ ...input, image: screenshotRecord() }),
        );
        assert.equal(replay.receipt.submissionId, receipt.submissionId);
        assert.match(logs, /DRAIN_COMPLETE/u);
        assert.doesNotMatch(logs, /DRAIN_EXPIRED|postgresql:|imgur/u);
      } finally {
        if (blocker) {
          await blocker
            .query(
              phase === 'query'
                ? 'ROLLBACK'
                : 'SELECT pg_advisory_unlock_all()',
            )
            .catch(() => {});
          blocker.release();
        }
        if (child && child.exitCode === null) {
          child.kill('SIGKILL');
          await new Promise<void>((resolve) =>
            child!.once('exit', () => resolve()),
          );
        }
        await pool.end();
        await root.query('DROP DATABASE ' + database);
        await root.end();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
