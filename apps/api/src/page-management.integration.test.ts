/** Page lifecycle against real PostgreSQL, authenticated routes and public projections. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import { createApp } from './app.js';
import { PgCatalogStore, type AdminCatalog } from './catalog-store.js';
import { IconStorage } from './icon-storage.js';
import { hashPassword } from './passwords.js';
import { PgStore } from './store.js';

test(
  'moderators create, order and delete pages atomically without losing shared items or review history',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = 'page_management_' + randomUUID().replaceAll('-', '');
    const root = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await root.query('CREATE SCHEMA ' + schema);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: '-c search_path=' + schema,
      max: 5,
    });
    const directory = await mkdtemp(join(tmpdir(), 'clog-pages-'));
    const store = new PgStore(pool),
      catalog = new PgCatalogStore(pool);
    const origin = 'https://pages.test',
      password = 'page-fixture-password';
    const app = createApp(
      () => store.ready(),
      () => store.settings(),
      {
        store,
        catalog,
        icons: new IconStorage(directory),
        auth: { origin, secret: 'a'.repeat(64), secure: true },
        logger: false,
      },
    );
    try {
      const migrations = new URL(
        '../../../packages/database/migrations/',
        import.meta.url,
      );
      for (const file of (await readdir(migrations))
        .filter((name) => /^\d+_.+\.sql$/u.test(name))
        .sort())
        await pool.query(await readFile(new URL(file, migrations), 'utf8'));
      const actor = '00000000-0000-4000-8000-000000000001';
      const passwordHash = await hashPassword(password);
      await store.ensureDefaultAdmin(passwordHash);
      const moderator = await store.createModerator(
        'reviewer',
        passwordHash,
        actor,
      );
      await pool.query('UPDATE staff_accounts SET must_change_password=false');
      await pool.query(
        "INSERT INTO items(id,name,icon_path) VALUES(1,'Unique','/catalog/items/1.png'),(2,'Shared','/catalog/items/2.png')",
      );
      await pool.query(
        "INSERT INTO pages(id,name,category,sort_order) VALUES('a','A','bosses',0),('b','B','bosses',1),('c','C','other',2)",
      );
      await pool.query(
        "INSERT INTO page_items(page_id,item_id,slot) VALUES('a',1,0),('a',2,1),('b',2,0)",
      );
      for (const hardcore of [false, true])
        await pool.query(
          "INSERT INTO submissions(id,discord_interaction_id,discord_user_id,discord_guild_id,raw_item_text,item_id,collector_name,collected_on,date_source,proof_url,status,reviewed_by,reviewed_at,hardcore) VALUES($1,$2,'1','2','Unique',1,'Collector','2026-10-12','admin','https://imgur.com/fixture','approved',$3,now(),$4)",
          [randomUUID(), randomUUID(), actor, hardcore],
        );
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { origin },
        payload: { username: 'reviewer', password },
      });
      assert.equal(login.statusCode, 200, login.body);
      const headers = {
        origin,
        cookie: String(login.headers['set-cookie']).split(';')[0]!,
        'x-csrf-token': login.json().csrfToken as string,
      };
      const create = (payload: unknown, key = 'page-create-request') =>
        app.inject({
          method: 'POST',
          url: '/api/v1/admin/catalog/pages',
          headers: {
            ...headers,
            'idempotency-key': key,
            'content-type': 'application/json',
          },
          payload: JSON.stringify(payload),
        });
      const current = () => catalog.catalog();
      const first = await current();
      const fields = {
        name: 'New page',
        category: 'bosses',
        itemIds: [2],
        expectedRevision: first.revision,
      };
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/admin/catalog/pages',
            payload: fields,
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/admin/catalog/pages',
            headers: { cookie: headers.cookie },
            payload: fields,
          })
        ).statusCode,
        403,
      );
      for (const invalid of [
        { ...fields, category: 'invalid' },
        { ...fields, name: '\n' },
        { ...fields, itemIds: [2, 2] },
        { ...fields, itemIds: [999] },
      ])
        assert.equal((await create(invalid)).statusCode, 400);
      assert.equal(
        (await app.inject({ url: '/api/v1/admin/clan-api-key', headers }))
          .statusCode,
        503, // Moderators may read it, but this fixture has no key storage.
      );
      const concurrent = await Promise.all([create(fields), create(fields)]);
      assert.ok(
        concurrent.every((result) => result.statusCode === 201),
        concurrent.map((result) => result.body).join('\n'),
      );
      assert.deepEqual(concurrent[0]!.json(), concurrent[1]!.json());
      const receipt = concurrent[0]!.json<{
        page: AdminCatalog['pages'][number];
        catalogRevision: string;
      }>();
      assert.equal(
        (await create({ ...fields, name: 'Changed' })).statusCode,
        409,
      );
      assert.equal(
        (await create(fields, 'stale-page-request')).statusCode,
        409,
      );
      const added = await current();
      assert.equal(
        (
          await create(
            { ...fields, expectedRevision: added.revision },
            'duplicate-page-request',
          )
        ).statusCode,
        400,
      );
      const reorder = (ids: string[], expectedRevision: string) =>
        app.inject({
          method: 'PUT',
          url: '/api/v1/admin/catalog/pages/order',
          headers,
          payload: {
            category: 'bosses',
            orderedPageIds: ids,
            expectedRevision,
          },
        });
      assert.equal((await reorder(['a', 'b'], added.revision)).statusCode, 400);
      assert.equal(
        (await reorder(['a', 'b', 'c'], added.revision)).statusCode,
        400,
      );
      const order = [receipt.page.id, 'b', 'a'];
      const ordered = await reorder(order, added.revision);
      assert.equal(ordered.statusCode, 200, ordered.body);
      assert.deepEqual(
        (await current()).pages
          .filter((page) => page.category === 'bosses')
          .map((page) => page.id),
        order,
      );
      assert.deepEqual(
        (await current()).pages.find((page) => page.id === 'c'),
        first.pages.find((page) => page.id === 'c'),
      );
      assert.equal((await reorder(order, added.revision)).statusCode, 409);
      const remove = async (
        id: string,
        revision?: string,
        version?: string,
      ) => {
        const snapshot = await current();
        return app.inject({
          method: 'DELETE',
          url: '/api/v1/admin/catalog/pages/' + encodeURIComponent(id),
          headers,
          payload: {
            expectedRevision: revision ?? snapshot.revision,
            expectedVersion:
              version ?? snapshot.pages.find((page) => page.id === id)!.version,
          },
        });
      };
      assert.equal((await remove('a', first.revision)).statusCode, 409);
      assert.equal((await remove('a', undefined, 'page-999')).statusCode, 409);
      // An audit failure must roll back retirement, slots and revisions as well.
      await pool.query(
        "CREATE FUNCTION fail_page_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit failed'; END $$",
      );
      await pool.query(
        'CREATE TRIGGER fail_page_audit BEFORE INSERT ON catalog_audit FOR EACH ROW EXECUTE FUNCTION fail_page_audit()',
      );
      const beforeFailure = await current();
      assert.equal((await remove('a')).statusCode, 503);
      assert.deepEqual(await current(), beforeFailure);
      await pool.query('DROP TRIGGER fail_page_audit ON catalog_audit');
      const removed = await remove('a');
      assert.equal(removed.statusCode, 200, removed.body);
      assert.deepEqual(removed.json().retiredItemIds, [1]);
      assert.deepEqual(
        (await current()).items.map((item) => item.id),
        [2],
      );
      const publicCatalog = await store.catalog();
      assert.ok(!publicCatalog.pages.some((page) => page.id === 'a'));
      assert.deepEqual(
        publicCatalog.items.map((item) => item.id),
        [2],
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM submissions WHERE item_id=1',
          )
        ).rows[0].n,
        2,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM collection_credits WHERE item_id=1',
          )
        ).rows[0].n,
        2,
      );
      // A retry returns the original receipt even after subsequent reorders/deletion.
      await remove(receipt.page.id);
      assert.deepEqual((await create(fields)).json(), receipt);
      assert.deepEqual(
        (await current()).items.map((item) => item.id),
        [2],
      );
      await remove('b');
      await remove('c');
      assert.deepEqual((await current()).pages, []);
      assert.deepEqual((await store.catalog()).pages, []);
      assert.deepEqual((await store.catalog()).items, []);
      const empty = await create(
        {
          name: 'Empty page',
          category: 'other',
          itemIds: [],
          expectedRevision: (await current()).revision,
        },
        'empty-page-request',
      );
      assert.equal(empty.statusCode, 201, empty.body);
      assert.deepEqual(empty.json().page.itemIds, []);
      assert.ok(
        (
          await pool.query('SELECT actor_discord_id FROM catalog_audit')
        ).rows.every((row) => row.actor_discord_id === moderator.id),
      );
    } finally {
      await app.close();
      await pool.end();
      await root.query('DROP SCHEMA ' + schema + ' CASCADE');
      await root.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
