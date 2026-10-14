import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { PgStore } from './store.js';
import { PgXpStore } from './xp-store.js';
import { PgCompetitionStore } from './competition-store.js';
import { createApp } from './app.js';
async function fixture(run: (pool: pg.Pool) => Promise<void>) {
  const connectionString = process.env.TEST_DATABASE_URL!,
    schema = 'projection_' + randomUUID().replaceAll('-', '');
  const root = new pg.Pool({ connectionString });
  await root.query('CREATE SCHEMA ' + schema);
  const pool = new pg.Pool({
    connectionString,
    options: '-c search_path=' + schema,
    max: 8,
    statement_timeout: 10000,
  });
  try {
    const directory = new URL(
      '../../../packages/database/migrations/',
      import.meta.url,
    );
    for (const file of (await readdir(directory))
      .filter((file) => file.endsWith('.sql'))
      .sort())
      await pool.query(await readFile(new URL(file, directory), 'utf8'));
    await pool.query(
      "INSERT INTO items(id,name,icon_path) VALUES(42,'Item one','/items/42.png'),(43,'Item two','/items/43.png')",
    );
    await pool.query(
      "INSERT INTO pages(id,name,category,sort_order) VALUES('p1','One','bosses',0),('p2','Two','bosses',1)",
    );
    await pool.query(
      "INSERT INTO page_items(page_id,item_id,slot) VALUES('p1',42,0),('p1',43,1)",
    );
    await pool.query(
      "INSERT INTO item_aliases(item_id,alias) VALUES(42,'Old alias')",
    );
    await run(pool);
  } finally {
    await pool.end();
    await root.query('DROP SCHEMA ' + schema + ' CASCADE');
    await root.end();
  }
}
test(
  'public/matching caches observe committed revisions across store instances, hide uncommitted changes and survive rollback',
  { skip: !process.env.TEST_DATABASE_URL },
  async () =>
    fixture(async (pool) => {
      const a = new PgStore(pool),
        b = new PgStore(pool),
        before = await a.publicSnapshot('catalog');
      assert.equal(
        (await b.publicSnapshot('catalog')).revision,
        before.revision,
      );
      assert.equal((await a.botItems('Old alias', 1))[0]!.id, 42);
      assert.equal((await b.botItems('Old alias', 1))[0]!.id, 42);
      const writer = await pool.connect();
      try {
        await writer.query('BEGIN');
        await writer.query(
          "UPDATE items SET name='New committed name' WHERE id=42",
        );
        await writer.query(
          "UPDATE item_aliases SET alias='New alias' WHERE item_id=42",
        );
        assert.equal(
          (await a.publicSnapshot('catalog')).revision,
          before.revision,
        );
        await writer.query('ROLLBACK');
        assert.equal(
          (await b.publicSnapshot('catalog')).revision,
          before.revision,
        );
        await writer.query('BEGIN');
        await writer.query(
          "UPDATE items SET name='New committed name' WHERE id=42",
        );
        await writer.query(
          "UPDATE item_aliases SET alias='New alias' WHERE item_id=42",
        );
        await writer.query('COMMIT');
        for (const store of [a, b]) {
          const next = await store.publicSnapshot('catalog');
          assert.notEqual(next.revision, before.revision);
          assert.equal(
            JSON.parse(next.body).items.find(
              (item: { id: number }) => item.id === 42,
            ).name,
            'New committed name',
          );
          assert.equal((await store.botItems('New alias', 1))[0]!.id, 42);
          assert.ok(Object.isFrozen((await store.catalog()).items));
        }
        const credit = randomUUID();
        await pool.query(
          "INSERT INTO submissions(id,source,raw_item_text,item_id,collector_name,collected_on,date_source,proof_url,status,reviewed_at,reviewed_by) VALUES($1,'manual','Item',42,'Collector','2026-01-01','admin','https://imgur.com/a/fixture','approved',now(),'fixture')",
          [credit],
        );
        const publicBefore = await a.publicSnapshot('collections');
        assert.equal(JSON.parse(publicBefore.body).credits.length, 1);
        await b.publicSnapshot('collections');
        await pool.query('UPDATE items SET active=false WHERE id=42');
        for (const store of [a, b]) {
          const next = await store.publicSnapshot('collections');
          assert.notEqual(next.revision, publicBefore.revision);
          assert.equal(JSON.parse(next.body).credits.length, 0);
        }
      } finally {
        await writer.query('ROLLBACK');
        writer.release();
      }
    }),
);
test(
  'cached HTTP snapshots invalidate on owner source changes without altering import revisions and carry a fresh clock on activity 304s',
  { skip: !process.env.TEST_DATABASE_URL },
  async () =>
    fixture(async (pool) => {
      await pool.query(
        "INSERT INTO wom_competitions(competition_id,kind,title,source_url,metrics,skills,starts_at,ends_at) VALUES(1,'SKILL','XP','https://wiseoldman.net/competitions/1','[\"attack\"]','[\"attack\"]','2026-01-01','2026-01-08'),(2,'ACTIVITY','Activity','https://wiseoldman.net/competitions/2','[\"vardorvis\"]','[]','2026-01-01','2026-01-08')",
      );
      const source = {
        participants: [
          {
            playerId: 1,
            displayName: 'Player',
            gains: { attack: '9007199254740993' },
          },
        ],
      };
      await pool.query(
        "INSERT INTO xp_events(competition_id,title,source_url,skills,gains,source_hash,source_snapshot) VALUES(1,'XP','https://wiseoldman.net/competitions/1','[\"attack\"]','{\"attack\":\"9007199254740993\"}',repeat('a',64),$1)",
        [JSON.stringify(source)],
      );
      const store = new PgStore(pool),
        xp = new PgXpStore(pool),
        competitions = new PgCompetitionStore(pool),
        app = createApp(undefined, undefined, {
          logger: false,
          store,
          xp,
          competitions,
        });
      try {
        const first = await app.inject('/api/v1/xp/tracker');
        assert.equal(first.statusCode, 200);
        assert.equal(first.json().totals.attack, '9007199254740993');
        assert.equal(
          (
            await app.inject({
              url: '/api/v1/xp/tracker',
              headers: { 'if-none-match': String(first.headers.etag) },
            })
          ).statusCode,
          304,
        );
        await pool.query(
          'UPDATE xp_state SET history_version=history_version+1',
        );
        assert.equal(
          (
            await app.inject({
              url: '/api/v1/xp/tracker',
              headers: { 'if-none-match': String(first.headers.etag) },
            })
          ).statusCode,
          304,
        );
        await pool.query(
          'UPDATE xp_events SET gains=\'{"attack":"9007199254740994"}\' WHERE competition_id=1',
        );
        const next = await app.inject({
          url: '/api/v1/xp/tracker',
          headers: { 'if-none-match': String(first.headers.etag) },
        });
        assert.equal(next.statusCode, 200);
        assert.equal(next.json().totals.attack, '9007199254740994');
        assert.equal(next.json().revision, first.json().revision);
        const activities = await app.inject('/api/v1/competitions/activities');
        const unchanged = await app.inject({
          url: '/api/v1/competitions/activities',
          headers: { 'if-none-match': String(activities.headers.etag) },
        });
        assert.equal(unchanged.statusCode, 304);
        assert.ok(
          Date.parse(String(unchanged.headers['x-server-now'])) >=
            Date.parse(activities.json().serverNow),
        );
        await pool.query(
          "UPDATE wom_competitions SET title='Corrected activity' WHERE competition_id=2",
        );
        const changed = await app.inject({
          url: '/api/v1/competitions/activities',
          headers: { 'if-none-match': String(activities.headers.etag) },
        });
        assert.equal(changed.statusCode, 200);
        assert.equal(
          changed.json().competitions[0].title,
          'Corrected activity',
        );
      } finally {
        await app.close();
      }
    }),
);
test(
  'membership statements advance each affected page once, invalidate projections and retain stale-edit protection',
  { skip: !process.env.TEST_DATABASE_URL },
  async () =>
    fixture(async (pool) => {
      const version = async () =>
        Object.fromEntries(
          (await pool.query('SELECT id,version::int FROM pages')).rows.map(
            (row) => [row.id, row.version],
          ),
        );
      const store = new PgStore(pool),
        before = await store.publicSnapshot('catalog'),
        versions = await version();
      const revision = (
        await pool.query('SELECT version::int FROM catalog_state')
      ).rows[0].version;
      await pool.query("UPDATE page_items SET page_id='p2'");
      const after = await version();
      assert.equal(after.p1, versions.p1 + 1);
      assert.equal(after.p2, versions.p2 + 1);
      assert.equal(
        (await pool.query('SELECT version::int FROM catalog_state')).rows[0]
          .version,
        revision + 1,
      );
      const next = await store.publicSnapshot('catalog');
      assert.notEqual(next.revision, before.revision);
      assert.deepEqual(
        JSON.parse(next.body).pages.find(
          (page: { id: string }) => page.id === 'p2',
        ).itemIds,
        [42, 43],
      );
      await pool.query('TRUNCATE page_items');
      const last = await version();
      assert.equal(last.p1, after.p1 + 1);
      assert.equal(last.p2, after.p2 + 1);
      assert.ok(
        JSON.parse((await store.publicSnapshot('catalog')).body).pages.every(
          (page: { itemIds: number[] }) => page.itemIds.length === 0,
        ),
      );
    }),
);

test(
  'a source commit between revision and projection reads cannot mix snapshots or poison the next revision',
  { skip: !process.env.TEST_DATABASE_URL },
  async () =>
    fixture(async (pool) => {
      const initial = await new PgStore(pool).publicSnapshot('catalog');
      let changed = false;
      const facade = {
        connect: async () => {
          const client = await pool.connect();
          return {
            release: () => client.release(),
            query: async (sql: string, values?: unknown[]) => {
              if (!changed && sql.startsWith('SELECT id, name, icon_path')) {
                changed = true;
                await pool.query(
                  "UPDATE items SET name='Concurrent commit' WHERE id=42",
                );
              }
              return client.query(sql, values);
            },
          };
        },
      } as unknown as pg.Pool;
      const store = new PgStore(facade);
      const pinned = await store.publicSnapshot('catalog');
      assert.equal(changed, true);
      assert.equal(pinned.revision, initial.revision);
      assert.equal(JSON.parse(pinned.body).items[0].name, 'Item one');
      const current = await store.publicSnapshot('catalog');
      assert.notEqual(current.revision, pinned.revision);
      assert.equal(JSON.parse(current.body).items[0].name, 'Concurrent commit');
    }),
);
