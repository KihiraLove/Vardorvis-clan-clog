/** Real PostgreSQL contract checks, mandatory in CI via TEST_DATABASE_URL. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { PgStore } from './store.js';
import { createApp } from './app.js';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
test(
  'PostgreSQL public projections, atomic settings/audit and durable auth state',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const connectionString = process.env.TEST_DATABASE_URL!;
    const schema = 'backend_test_' + randomUUID().replaceAll('-', '');
    const root = new pg.Pool({ connectionString });
    await root.query('CREATE SCHEMA ' + schema);
    const pool = new pg.Pool({
      connectionString,
      options: '-c search_path=' + schema,
      statement_timeout: 5000,
    });
    const store = new PgStore(pool);
    const app = createApp(
      () => store.ready(),
      () => store.settings(),
      { store, logger: false },
    );
    try {
      await pool.query(
        await readFile(
          new URL(
            '../../../packages/database/migrations/001_baseline.sql',
            import.meta.url,
          ),
          'utf8',
        ),
      );
      await pool.query(
        await readFile(
          new URL(
            '../../../packages/database/migrations/003_staff_accounts.sql',
            import.meta.url,
          ),
          'utf8',
        ),
      );
      await store.ready();
      assert.equal((await app.inject('/api/v1/catalog')).statusCode, 503);
      assert.deepEqual(await store.settings(), {
        revision: 'settings-1',
        hardcoreEnabled: false,
      });
      await pool.query(
        "INSERT INTO items(id,name,icon_path) VALUES(42,'Shared item','/items/42.png'),(43,'Manual item','/items/43.png')",
      );
      await pool.query(
        "INSERT INTO pages(id,name,category,sort_order) VALUES('a','A','bosses',0),('b','B','bosses',1)",
      );
      await pool.query(
        "INSERT INTO page_items(page_id,item_id,slot) VALUES('a',42,0),('a',43,1),('b',42,0)",
      );
      const first = await app.inject('/api/v1/catalog');
      assert.equal(first.statusCode, 200);
      assert.deepEqual(first.json().pages[0].itemIds, [42, 43]);
      // Item 43 has no game-ID aliases; manual identities still appear publicly.
      assert.equal(first.json().items.length, 2);
      await pool.query("UPDATE page_items SET slot=slot+10 WHERE page_id='a'");
      await pool.query(
        "UPDATE page_items SET slot=CASE WHEN item_id=42 THEN 1 ELSE 0 END WHERE page_id='a'",
      );
      const reordered = await app.inject({
        url: '/api/v1/catalog',
        headers: { 'if-none-match': first.headers.etag! },
      });
      assert.equal(reordered.statusCode, 200);
      assert.deepEqual(reordered.json().pages[0].itemIds, [43, 42]);
      async function claim(id: string, mode: boolean, status: string) {
        await pool.query(
          "INSERT INTO submissions(id,discord_interaction_id,discord_user_id,discord_guild_id,raw_item_text,item_id,collector_name,collected_on,date_source,proof_url,hardcore,status,reviewed_by,reviewed_at) VALUES($1,$4,'private-user','private-guild','raw-private',42,'Collector','2026-10-01','admin','https://imgur.com/private-evidence',$2,$3,'private-reviewer',now())",
          [id, mode, status, id],
        );
      }
      const normal = randomUUID(),
        hc = randomUUID();
      await claim(normal, false, 'approved');
      await claim(hc, true, 'approved');
      await claim(randomUUID(), false, 'pending');
      const credits = await app.inject('/api/v1/collections');
      assert.equal(credits.json().credits.length, 2);
      assert.ok(!credits.body.includes('private'));
      assert.equal(credits.json().credits[0].collectedOn, '2026-10-01');
      await assert.rejects(claim(randomUUID(), false, 'approved'), {
        code: '23505',
      });
      await pool.query(
        "UPDATE submissions SET status='revoked',review_reason='Correction' WHERE id=$1",
        [normal],
      );
      const revised = await app.inject({
        url: '/api/v1/collections',
        headers: { 'if-none-match': credits.headers.etag! },
      });
      assert.equal(revised.statusCode, 200);
      assert.equal(revised.json().credits[0].hardcore, true);
      assert.equal(revised.json().credits.length, 1);
      const results = await Promise.all([
        store.saveSettings(true, 'settings-1', 'admin-one'),
        store.saveSettings(false, 'settings-1', 'admin-two'),
      ]);
      assert.equal(results.filter(Boolean).length, 1);
      assert.equal(
        (await pool.query('SELECT * FROM site_settings_audit')).rows.length,
        1,
      );
      // A failure in the audit insert must roll back the setting, too.
      await pool.query(
        "ALTER TABLE site_settings_audit ADD CONSTRAINT reject_bad_actor CHECK(actor_discord_id<>'blocked')",
      );
      const saved = await store.settings();
      await assert.rejects(
        store.saveSettings(!saved.hardcoreEnabled, saved.revision, 'blocked'),
      );
      assert.deepEqual(await store.settings(), saved);
      const restarted = new PgStore(pool);
      assert.deepEqual(await restarted.settings(), saved);
      const state = hash('state');
      await store.createState(state, new Date(Date.now() + 60000));
      assert.deepEqual(
        (
          await Promise.all([
            store.consumeState(state),
            store.consumeState(state),
          ])
        ).sort(),
        [false, true],
      );
      await store.createState(hash('expired'), new Date(0));
      assert.equal(await store.consumeState(hash('expired')), false);
      await store.createSession(
        hash('session'),
        { id: '123456789012345678', displayName: 'Admin' },
        new Date(Date.now() + 60000),
      );
      assert.equal(
        (await restarted.session(hash('session')))?.displayName,
        'Admin',
      );
      await store.deleteSession(hash('session'));
      assert.equal(await restarted.session(hash('session')), null);
      await store.createSession(
        hash('expired-session'),
        { id: '123456789012345678', displayName: 'Admin' },
        new Date(0),
      );
      assert.equal(await restarted.session(hash('expired-session')), null);
      const limited = await Promise.all(
        Array.from({ length: 21 }, () => store.allowLogin(hash('ip'))),
      );
      assert.equal(limited.filter(Boolean).length, 20);
    } finally {
      await app.close();
      await pool.end();
      await root.query('DROP SCHEMA ' + schema + ' CASCADE');
      await root.end();
    }
  },
);
