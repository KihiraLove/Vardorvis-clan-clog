/** Query-volume evidence against real PostgreSQL, without a Discord gateway. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import pg from 'pg';
import { WorkBudget, WorkloadError } from '@clog/domain';
import { PgStore } from './store.js';
test(
  'Discord admission bounds real catalog SELECT volume and records before/after latency',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const connectionString = process.env.TEST_DATABASE_URL!,
      schema = 'workload_' + randomUUID().replaceAll('-', '');
    const root = new pg.Pool({ connectionString });
    await root.query('CREATE SCHEMA ' + schema);
    const pool = new pg.Pool({
      connectionString,
      options: '-c search_path=' + schema,
      max: 2,
      statement_timeout: 5000,
    });
    try {
      const directory = new URL(
        '../../../packages/database/migrations/',
        import.meta.url,
      );
      for (const file of (await readdir(directory))
        .filter((name) => name.endsWith('.sql'))
        .sort())
        await pool.query(await readFile(new URL(file, directory), 'utf8'));
      await pool.query(
        "INSERT INTO items(id,name,icon_path) SELECT n,'Catalog item ' || n,'/items/' || n || '.png' FROM generate_series(1,1717) n",
      );
      await pool.query(
        "INSERT INTO item_aliases(item_id,alias) SELECT n,'Alias ' || n FROM generate_series(1,1717) n",
      );
      let selects = 0,
        rows = 0;
      const counted = {
        connect: async () => {
          const client = await pool.connect();
          return {
            release: () => client.release(),
            query: async (sql: string, values?: unknown[]) => {
              const result = await client.query(sql, values);
              if (sql.startsWith('SELECT')) {
                selects++;
                rows += result.rows.length;
              }
              return result;
            },
          };
        },
      } as unknown as pg.Pool;
      const store = new PgStore(counted);
      for (const bounded of [false, true]) {
        selects = 0;
        rows = 0;
        const budget = new WorkBudget({ concurrent: 16, perMinute: 600 }, [
          { concurrent: 8, perMinute: 300 },
          { concurrent: 2, perMinute: 30 },
        ]);
        let accepted = 0,
          denied = 0;
        const latency: number[] = [],
          cpu = process.cpuUsage();
        for (let n = 0; n < 500; n++) {
          let release: (() => void) | undefined;
          const start = performance.now();
          try {
            if (bounded)
              release = budget.acquire(['guild', 'guild:user-' + (n % 10)]);
            assert.ok((await store.botItems('Catalog item 1', 25)).length > 0);
            accepted++;
            latency.push(performance.now() - start);
          } catch (error) {
            if (!(error instanceof WorkloadError)) throw error;
            denied++;
          } finally {
            release?.();
          }
        }
        assert.equal(accepted, bounded ? 300 : 500);
        assert.equal(denied, bounded ? 200 : 0);
        // Revision probe on every read; one cold bounded catalog packet, then reuse.
        assert.equal(selects, accepted + (bounded ? 0 : 1));
        assert.equal(rows, selects);
        latency.sort((a, b) => a - b);
        const used = process.cpuUsage(cpu);
        t.diagnostic(
          JSON.stringify({
            mode: bounded ? 'bounded' : 'before',
            items: 1717,
            aliases: 1717,
            offered: 500,
            accepted,
            denied,
            selects,
            rows,
            p50Ms: latency[Math.floor(latency.length * 0.5)],
            p95Ms: latency[Math.floor(latency.length * 0.95)],
            cpuMs: (used.user + used.system) / 1000,
            peakRssMiB: process.resourceUsage().maxRSS / 1024,
          }),
        );
      }
    } finally {
      await pool.end();
      await root.query('DROP SCHEMA ' + schema + ' CASCADE');
      await root.end();
    }
  },
);
