/** Real disposable PostgreSQL evidence; run before/after with identical fixtures. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { PgStore } from '../apps/api/dist/store.js';
import { PgXpStore } from '../apps/api/dist/xp-store.js';
import { PgCompetitionStore } from '../apps/api/dist/competition-store.js';
import { createApp } from '../apps/api/dist/app.js';
if (
  process.env.PROJECTION_BENCH_DISPOSABLE !== 'true' ||
  !process.env.TEST_DATABASE_URL
)
  throw new Error('Disposable PostgreSQL required');
const schema = 'projection_bench_' + randomUUID().replaceAll('-', '');
const root = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
await root.query('CREATE SCHEMA ' + schema);
const pool = new pg.Pool({
  connectionString: process.env.TEST_DATABASE_URL,
  options: '-c search_path=' + schema,
  max: 4,
  statement_timeout: 30000,
});
let queries = 0,
  selects = 0,
  rows = 0,
  bytes = 0,
  waits = [];
const facade = {
  connect: async () => {
    const start = performance.now(),
      client = await pool.connect();
    waits.push(performance.now() - start);
    return {
      release: () => client.release(),
      query: async (sql, values) => {
        queries++;
        const result = await client.query(sql, values);
        if (/^SELECT/u.test(sql)) {
          selects++;
          rows += result.rows.length;
          bytes += Buffer.byteLength(JSON.stringify(result.rows));
        }
        return result;
      },
    };
  },
};
facade.query = async (sql, values) => {
  const c = await facade.connect();
  try {
    return await c.query(sql, values);
  } finally {
    c.release();
  }
};
let app;
const percentile = (values, fraction) =>
  [...values].sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)
  ] ?? 0;
try {
  const directory = new URL(
    '../packages/database/migrations/',
    import.meta.url,
  );
  for (const file of (await readdir(directory))
    .filter((file) => file.endsWith('.sql'))
    .sort())
    await pool.query(await readFile(new URL(file, directory), 'utf8'));
  await pool.query(
    "INSERT INTO items(id,name,icon_path) SELECT n,'Item '||n,'/catalog/items/'||n||'.webp' FROM generate_series(1,1717) n",
  );
  await pool.query(
    "INSERT INTO item_aliases(item_id,alias) SELECT n,'Alias '||n FROM generate_series(1,1717) n",
  );
  await pool.query(
    "INSERT INTO pages(id,name,category,sort_order) SELECT 'p'||n,'Page '||n,'bosses',n FROM generate_series(0,123) n",
  );
  const before = (await pool.query('SELECT version::text FROM catalog_state'))
      .rows[0].version,
    start = performance.now();
  await pool.query(
    "INSERT INTO page_items(page_id,item_id,slot) SELECT 'p'||(n%124),(n%1717)+1,n/124 FROM generate_series(0,9999) n",
  );
  console.log(
    JSON.stringify({
      phase: process.argv[2] ?? 'current',
      operation: 'membership-insert',
      memberships: 10000,
      milliseconds: performance.now() - start,
      revisionAdvance:
        Number(
          (await pool.query('SELECT version::text FROM catalog_state')).rows[0]
            .version,
        ) - Number(before),
    }),
  );
  const proof = randomUUID();
  await pool.query(
    "INSERT INTO submission_images(id,sha256,byte_size,width,height) VALUES($1,repeat('a',64),1,1,1)",
    [proof],
  );
  await pool.query(
    `INSERT INTO submissions(id,source,raw_item_text,collector_name,collected_on,date_source,proof_url,item_id,status,reviewed_at,reviewed_by,proof_image_id)
    SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'manual','Fixture','Collector','2026-01-01','admin','https://imgur.com/a/fixture',
    CASE WHEN n<=1000 THEN n ELSE NULL END,CASE WHEN n<=1000 THEN 'approved' ELSE 'pending' END,
    CASE WHEN n<=1000 THEN now() ELSE NULL END,CASE WHEN n<=1000 THEN 'fixture' ELSE NULL END,
    CASE WHEN n=100001 THEN $1::uuid ELSE NULL END FROM generate_series(1,100001) n`,
    [proof],
  );
  await pool.query(
    "INSERT INTO audit_events(submission_id,actor_discord_id,action,old_values,new_values) SELECT '00000000-0000-4000-8000-000000000001','fixture','edit','{}','{}' FROM generate_series(1,100001)",
  );
  await pool.query(`INSERT INTO wom_competitions(competition_id,kind,title,source_url,metrics,skills,starts_at,ends_at)
    SELECT n,CASE WHEN n<=1000 THEN 'SKILL' ELSE 'ACTIVITY' END,'Event '||n,'https://wiseoldman.net/competitions/'||n,
    CASE WHEN n<=1000 THEN '["attack"]'::jsonb ELSE '["vardorvis"]'::jsonb END,
    CASE WHEN n<=1000 THEN '["attack"]'::jsonb ELSE '[]'::jsonb END,'2026-01-01','2026-01-08' FROM generate_series(1,2000) n`);
  const snapshot = {
    event: {
      id: 1,
      title: 'Fixture XP',
      sourceUrl: 'https://wiseoldman.net/competitions/1',
      skills: ['attack'],
      gains: { attack: '100' },
    },
    participants: Array.from({ length: 100 }, (_, n) => ({
      playerId: n + 1,
      displayName: 'Player ' + n,
      gains: { attack: '1' },
    })),
    startsAt: '2026-01-01T00:00:00.000Z',
    endsAt: '2026-01-08T00:00:00.000Z',
    sourceUpdatedAt: '2026-01-08T00:00:00.000Z',
    sourceHash: 'a'.repeat(64),
  };
  await pool.query(
    `INSERT INTO xp_events(competition_id,title,source_url,skills,gains,source_hash,source_snapshot)
    SELECT n,'XP '||n,'https://wiseoldman.net/competitions/'||n,'["attack"]','{"attack":"100"}',repeat('a',64),
    jsonb_set($1::jsonb,'{event,id}',to_jsonb(n)) FROM generate_series(1,1000) n`,
    [JSON.stringify(snapshot)],
  );
  await pool.query(`INSERT INTO xp_import_history(id,actor_discord_id,actor_name,request_key,token_hash,expected_revision,competition_id,title,outcome,changes,resulting_revision)
    SELECT gen_random_uuid(),'fixture','Fixture',gen_random_uuid(),repeat('b',64),'xp-1',(n%1000)+1,'History '||n,'unchanged','[]','xp-1' FROM generate_series(1,10001) n`);
  await pool.query('ANALYZE xp_import_history');
  await pool.query('ANALYZE submissions');
  await pool.query('ANALYZE audit_events');
  const explain = async (name, sql, values) => {
    const plan = (
      await pool.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + sql, values)
    ).rows[0]['QUERY PLAN'][0];
    console.log(
      JSON.stringify({
        phase: process.argv[2] ?? 'current',
        operation: name,
        plan,
      }),
    );
  };
  await explain(
    'audit-submission',
    'SELECT id FROM audit_events WHERE submission_id=$1 ORDER BY id DESC LIMIT 21',
    ['00000000-0000-4000-8000-000000000001'],
  );
  await explain(
    'proof-reference',
    'SELECT 1 FROM submissions WHERE proof_image_id=$1 LIMIT 1',
    [proof],
  );
  // Measure a candidate in a rolled-back transaction before choosing a migration.
  await pool.query('BEGIN');
  await pool.query(
    'CREATE INDEX benchmark_proof_candidate ON submissions(proof_image_id) WHERE proof_image_id IS NOT NULL',
  );
  await explain(
    'proof-reference-candidate',
    'SELECT 1 FROM submissions WHERE proof_image_id=$1 LIMIT 1',
    [proof],
  );
  await pool.query('ROLLBACK');
  const store = new PgStore(facade),
    xp = new PgXpStore(facade),
    competitions = new PgCompetitionStore(facade);
  app = createApp(undefined, undefined, {
    logger: false,
    store,
    xp,
    competitions,
  });
  await app.ready();
  const measure = async (name, read, n = 10) => {
    queries = 0;
    selects = 0;
    rows = 0;
    bytes = 0;
    waits = [];
    const timings = [],
      cpu = process.cpuUsage();
    let wireBytes = 0;
    for (let i = 0; i < n; i++) {
      const start = performance.now();
      const value = await read();
      timings.push(performance.now() - start);
      wireBytes += value ?? 0;
    }
    const used = process.cpuUsage(cpu);
    console.log(
      JSON.stringify({
        phase: process.argv[2] ?? 'current',
        operation: name,
        samples: n,
        queries,
        selects,
        rows,
        dbBytes: bytes,
        wireBytes,
        p50Ms: percentile(timings, 0.5),
        p95Ms: percentile(timings, 0.95),
        poolWaitP95Ms: percentile(waits, 0.95),
        cpuMs: (used.user + used.system) / 1000,
        peakRssMiB: process.resourceUsage().maxRSS / 1024,
      }),
    );
  };
  for (const path of [
    'catalog',
    'collections',
    'xp/tracker',
    'competitions/activities',
  ]) {
    const first = await app.inject('/api/v1/' + path);
    assert.equal(first.statusCode, 200, first.body);
    await measure(path + '-warm-200', async () => {
      const r = await app.inject('/api/v1/' + path);
      assert.equal(r.statusCode, 200);
      return Buffer.byteLength(r.body);
    });
    if (first.headers.etag)
      await measure(path + '-304', async () => {
        const r = await app.inject({
          url: '/api/v1/' + path,
          headers: { 'if-none-match': first.headers.etag },
        });
        assert.equal(r.statusCode, 304);
        return Buffer.byteLength(r.body);
      });
  }
  await measure('bot-autocomplete', async () => {
    await store.botItems('Item 1', 25);
  });
  await measure('xp-history-10001', async () => {
    const value = await xp.history();
    assert.equal(value.imports.length, 20);
    assert.ok(value.nextCursor);
    return Buffer.byteLength(JSON.stringify(value));
  });
  await measure(
    'pool-burst',
    async () => {
      await Promise.all(Array.from({ length: 12 }, () => store.catalog()));
    },
    3,
  );
} finally {
  await app?.close();
  await pool.end();
  await root.query('DROP SCHEMA ' + schema + ' CASCADE');
  await root.end();
}
