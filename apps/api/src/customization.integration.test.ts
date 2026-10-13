import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import { defaultSiteCopy } from '@clog/domain';
import { createApp } from './app.js';
import { PgStore } from './store.js';
import { PgCatalogStore } from './catalog-store.js';
import { PgReviewStore } from './review-store.js';
import { IconStorage } from './icon-storage.js';
import { hashPassword } from './passwords.js';

test(
  'public text persists with owner-only audited writes; moderators can delete catalog items; account disable/delete revoke sessions and preserve histories',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const connectionString = process.env.TEST_DATABASE_URL!;
    const root = new pg.Pool({ connectionString });
    const schema = 'custom_test_' + randomUUID().replaceAll('-', '');
    await root.query('CREATE SCHEMA ' + schema);
    const pool = new pg.Pool({
      connectionString,
      options: '-c search_path=' + schema,
      application_name: schema,
    });
    const directory = await mkdtemp(join(tmpdir(), 'clog-custom-'));
    const backend = new PgStore(pool),
      catalog = new PgCatalogStore(pool),
      review = new PgReviewStore(pool, backend),
      icons = new IconStorage(directory);
    const auth = {
      origin: 'https://clog.example.com',
      secret: 'a'.repeat(64),
      secure: true,
      bootstrapPassword: 'b'.repeat(64),
    };
    const app = createApp(
      () => backend.ready(),
      () => backend.settings(),
      { store: backend, catalog, icons, review, auth, logger: false },
    );
    try {
      const migrations = new URL(
        '../../../packages/database/migrations/',
        import.meta.url,
      );
      for (const file of (await readdir(migrations))
        .filter((file) => file.endsWith('.sql'))
        .sort())
        await pool.query(await readFile(new URL(file, migrations), 'utf8'));
      await icons.initialize();
      await app.ready();
      const admin = (await backend.accountByUsername('admin'))!;
      await backend.updateAccount(
        admin.id,
        1,
        'owner',
        await hashPassword('owner-password'),
      );
      const mod = await backend.createModerator(
        'reviewer',
        await hashPassword('mod-password'),
        admin.id,
      );
      await backend.updateAccount(
        mod.id,
        1,
        'reviewer',
        await hashPassword('mod-new-password'),
      );
      let address = 1;
      const login = async (
        username: string,
        password: string,
        status = 200,
      ) => {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          remoteAddress: '192.0.2.' + address++,
          headers: { origin: auth.origin },
          payload: { username, password },
        });
        assert.equal(response.statusCode, status, response.body);
        return {
          origin: auth.origin,
          cookie: String(response.headers['set-cookie']).split(';')[0]!,
          'x-csrf-token': response.json().csrfToken as string,
        };
      };
      const owner = await login('owner', 'owner-password'),
        moderator = await login('reviewer', 'mod-new-password');
      const initial = (await app.inject('/api/v1/settings')).json();
      assert.deepEqual(initial.copy, defaultSiteCopy);
      const copy = {
        collectionTitle: 'Our drops',
        collectionCaption: 'Collected at clan events',
        xpTitle: 'Training together',
      };
      const save = (
        headers: Record<string, string>,
        fields: Record<string, unknown>,
      ) =>
        app.inject({
          method: 'PUT',
          url: '/api/v1/admin/settings',
          headers,
          payload: fields,
        });
      const fields = {
        clanName: 'Example clan',
        hardcoreEnabled: true,
        expectedRevision: initial.revision,
        copy,
      };
      assert.equal((await save(moderator, fields)).statusCode, 403);
      assert.equal(
        (await save({ ...owner, origin: 'https://other.example' }, fields))
          .statusCode,
        403,
      );
      assert.equal(
        (await save(owner, { ...fields, copy: { ...copy, xpTitle: ' ' } }))
          .statusCode,
        400,
      );
      assert.equal(
        (await save(owner, { ...fields, copy: { ...copy, extra: 'field' } }))
          .statusCode,
        400,
      );
      assert.equal(
        (
          await save(owner, {
            ...fields,
            copy: { ...copy, xpTitle: 'line\nbreak' },
          })
        ).statusCode,
        400,
      );
      const saved = await save(owner, fields);
      assert.equal(saved.statusCode, 200, saved.body);
      assert.deepEqual(
        (await app.inject('/api/v1/settings')).json().copy,
        copy,
      );
      assert.equal((await save(owner, fields)).statusCode, 409);
      assert.deepEqual((await new PgStore(pool).settings()).copy, copy);
      const settingsAudit = (
        await pool.query(
          'SELECT * FROM site_settings_audit WHERE actor_discord_id=$1',
          [admin.id],
        )
      ).rows[0];
      assert.equal(settingsAudit.actor_discord_id, admin.id);
      assert.deepEqual(settingsAudit.old_public_copy, defaultSiteCopy);
      assert.deepEqual(settingsAudit.new_public_copy, copy);
      // Legacy clients that only change hardcore/name retain the new labels.
      assert.equal(
        (
          await save(owner, {
            clanName: 'Example clan',
            hardcoreEnabled: false,
            expectedRevision: saved.json().revision,
          })
        ).statusCode,
        200,
      );
      assert.deepEqual((await backend.settings()).copy, copy);
      await pool.query(
        "INSERT INTO items(id,name,icon_path) VALUES(42,'Deleted drop','/items/42.png'),(43,'Kept drop','/items/43.png'); INSERT INTO pages(id,category,name,sort_order) VALUES('custom-a','bosses','A',1),('custom-b','other','B',2); INSERT INTO page_items(page_id,item_id,slot) VALUES('custom-a',42,0),('custom-a',43,1),('custom-b',42,0)",
      );
      const claims = [randomUUID(), randomUUID(), randomUUID()];
      for (let i = 0; i < claims.length; i++)
        await pool.query(
          `INSERT INTO submissions(id,source,raw_item_text,item_id,collector_name,collected_on,date_source,proof_url,hardcore,status,reviewed_by,reviewed_at)
        VALUES($1,'manual','Deleted drop',42,'Collector',CURRENT_DATE,'admin','',$2,$3,$4,$5)`,
          [
            claims[i],
            i === 1,
            i < 2 ? 'approved' : 'pending',
            i < 2 ? admin.id : null,
            i < 2 ? new Date() : null,
          ],
        );
      const before = await catalog.catalog();
      const remove = (
        headers: Record<string, string>,
        expectedRevision = before.revision,
        pageId = 'custom-a',
        expectedVersion = before.pages[0]!.version,
      ) =>
        app.inject({
          method: 'DELETE',
          url: '/api/v1/admin/catalog/pages/' + pageId + '/items/42',
          headers,
          payload: { expectedRevision, expectedVersion },
        });
      assert.equal((await remove({})).statusCode, 401);
      assert.equal(
        (await remove({ ...moderator, 'x-csrf-token': 'bad' })).statusCode,
        403,
      );
      const removedPage = await remove(moderator);
      assert.equal(removedPage.statusCode, 200, removedPage.body);
      assert.equal(removedPage.json().retired, false);
      assert.equal((await remove(moderator)).statusCode, 409);
      const shared = await catalog.catalog();
      assert.deepEqual(
        shared.items.map((item) => item.id),
        [42, 43],
      );
      assert.deepEqual(
        shared.pages.map((page) => page.itemIds),
        [[43], [42]],
      );
      assert.notEqual(shared.pages[0]!.version, before.pages[0]!.version);
      assert.equal(shared.pages[1]!.version, before.pages[1]!.version);
      assert.equal((await backend.collections()).length, 2);
      assert.ok(
        (await backend.botItems('', 25)).some((item) => item.id === 42),
      );
      assert.equal(
        (await remove(moderator, shared.revision, 'custom-b', 'page-999'))
          .statusCode,
        409,
      );
      const deleted = await remove(
        moderator,
        shared.revision,
        'custom-b',
        shared.pages[1]!.version,
      );
      assert.equal(deleted.statusCode, 200, deleted.body);
      assert.equal(deleted.json().retired, true);
      const after = await catalog.catalog();
      assert.deepEqual(
        after.items.map((item) => item.id),
        [43],
      );
      assert.deepEqual(
        after.pages.map((page) => page.itemIds),
        [[43], []],
      );
      assert.deepEqual(
        (await backend.catalog()).items.map((item) => item.id),
        [43],
      );
      assert.deepEqual(await backend.collections(), []);
      assert.deepEqual(
        (await backend.botItems('', 25)).map((item) => item.id),
        [43],
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::integer AS n FROM submissions WHERE item_id=42',
          )
        ).rows[0].n,
        3,
      );
      assert.deepEqual(
        (
          await pool.query('SELECT slot FROM page_items WHERE page_id=$1', [
            'custom-a',
          ])
        ).rows,
        [{ slot: 0 }],
      );
      const audits = (
        await pool.query(
          "SELECT * FROM catalog_audit WHERE action='delete' ORDER BY id",
        )
      ).rows;
      assert.deepEqual(
        audits.map((row) => row.page_id),
        ['custom-a', 'custom-b'],
      );
      assert.equal(audits[0].after_value.active, true);
      assert.equal(audits[1].after_value.active, false);
      const itemAudit = audits[1];
      assert.equal(itemAudit.actor_discord_id, mod.id);
      assert.equal(itemAudit.item_id, 42);
      assert.equal(
        (
          await app.inject({
            method: 'DELETE',
            url: '/api/v1/admin/catalog/items/42',
            headers: moderator,
            payload: { expectedRevision: after.revision },
          })
        ).statusCode,
        404,
      );
      const approval = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/submissions/${claims[2]}/approve`,
        headers: moderator,
        payload: { expectedVersion: 1 },
      });
      assert.equal(approval.statusCode, 422);
      // A deletion committed while approval waits must invalidate that approval.
      const racingClaim = randomUUID();
      await pool.query(
        `INSERT INTO submissions(id,source,raw_item_text,item_id,collector_name,collected_on,date_source,proof_url)
        VALUES($1,'manual','Kept drop',43,'Collector',CURRENT_DATE,'admin','')`,
        [racingClaim],
      );
      const blocker = await pool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM items WHERE id=43 FOR UPDATE');
        const racing = review
          .mutate(
            racingClaim,
            1,
            { action: 'approve', expectedVersion: 1 },
            mod.id,
            'reviewer',
          )
          .then(
            () => undefined,
            (error: unknown) => error as { status: number },
          );
        const deadline = Date.now() + 5000;
        while (
          !(
            await root.query(
              "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query='SELECT 1 FROM items WHERE id=$1 AND active FOR SHARE'",
              [schema],
            )
          ).rowCount
        ) {
          assert.ok(
            Date.now() < deadline,
            'Approval must wait for the item lock',
          );
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await blocker.query('UPDATE items SET active=false WHERE id=43');
        await blocker.query('COMMIT');
        assert.equal((await racing)?.status, 422);
        assert.equal(
          (await review.detail(racingClaim))?.submission.status,
          'pending',
        );
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
      const change = (
        headers: Record<string, string>,
        action: string,
        version: number,
        id = mod.id,
      ) =>
        app.inject({
          method: 'POST',
          url: `/api/v1/admin/accounts/${id}/${action}`,
          headers,
          payload: { expectedVersion: version },
        });
      assert.equal((await change(moderator, 'disable', 2)).statusCode, 403);
      assert.equal(
        (await change(owner, 'disable', 2, admin.id)).statusCode,
        403,
      );
      assert.equal(
        (await change({ ...owner, 'x-csrf-token': 'bad' }, 'disable', 2))
          .statusCode,
        403,
      );
      const disabled = await change(owner, 'disable', 2);
      assert.equal(disabled.statusCode, 200, disabled.body);
      assert.equal(disabled.json().disabled, true);
      const disabledRow = (
        await pool.query(
          'SELECT password_hash,disabled_password_hash FROM staff_accounts WHERE id=$1',
          [mod.id],
        )
      ).rows[0];
      assert.equal(disabledRow.password_hash, '');
      assert.match(disabledRow.disabled_password_hash, /^scrypt\$/u);
      assert.equal(
        (
          await app.inject({ url: '/api/v1/auth/session', headers: moderator })
        ).json().authenticated,
        false,
      );
      await login('reviewer', 'mod-new-password', 401);
      assert.equal((await change(owner, 'enable', 2)).statusCode, 409);
      const enabled = await change(owner, 'enable', disabled.json().version);
      assert.equal(enabled.statusCode, 200);
      assert.equal(enabled.json().disabled, false);
      const renewed = await login('reviewer', 'mod-new-password');
      const removed = await change(owner, 'delete', enabled.json().version);
      assert.equal(removed.statusCode, 200, removed.body);
      assert.equal(
        (
          await app.inject({ url: '/api/v1/auth/session', headers: renewed })
        ).json().authenticated,
        false,
      );
      await login('reviewer', 'mod-new-password', 401);
      assert.equal(
        (await backend.accounts()).some((row) => row.id === mod.id),
        false,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT password_hash,disabled,deleted_at FROM staff_accounts WHERE id=$1',
            [mod.id],
          )
        ).rows[0].password_hash,
        '',
      );
      const replacement = await backend.createModerator(
        'reviewer',
        await hashPassword('replacement-password'),
        admin.id,
      );
      assert.notEqual(replacement.id, mod.id);
      assert.equal(itemAudit.actor_discord_id, mod.id);
      assert.deepEqual(
        (
          await pool.query(
            "SELECT action FROM staff_account_audit WHERE account_id=$1 AND action IN ('disable','enable','delete') ORDER BY id",
            [mod.id],
          )
        ).rows.map((row) => row.action),
        ['disable', 'enable', 'delete'],
      );
      await assert.rejects(
        pool.query('UPDATE staff_accounts SET disabled=true WHERE id=$1', [
          admin.id,
        ]),
        { code: '23514' },
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
