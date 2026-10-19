import { botRequest, memoryProofFiles } from './tests/screenshot.js';
/** Real API + PostgreSQL + filesystem acceptance tests. CI always supplies TEST_DATABASE_URL. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { hashPassword } from './passwords.js';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import sharp from 'sharp';
import { createApp } from './app.js';
import { PgStore } from './store.js';
import { PgReviewStore } from './review-store.js';
import {
  PgCatalogStore,
  type AdminCatalog,
  type CreatedItem,
} from './catalog-store.js';
import { IconStorage, MAX_ICON_BYTES } from './icon-storage.js';
import type { AuthConfig } from './config.js';

const actor = '00000000-0000-4000-8000-000000000001';
const password = 'catalog-fixture-password';
const config: AuthConfig = {
  origin: 'https://clog.example.com',
  secret: 'a'.repeat(64),
  secure: true,
};
const form = (bytes: Buffer, mime = 'image/png') => ({
  headers: { 'content-type': 'multipart/form-data; boundary=clog-test' },
  payload: Buffer.concat([
    Buffer.from(
      `--clog-test\r\nContent-Disposition: form-data; name="icon"; filename="../../untrusted.png"\r\nContent-Type: ${mime}\r\n\r\n`,
    ),
    bytes,
    Buffer.from('\r\n--clog-test--\r\n'),
  ]),
});
test(
  'admin catalog creates, reconciles and orders atomically with authenticated actors and durable assets',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const connectionString = process.env.TEST_DATABASE_URL!;
    const schema = 'admin_catalog_' + randomUUID().replaceAll('-', '');
    const root = new pg.Pool({ connectionString });
    await root.query('CREATE SCHEMA ' + schema);
    const pool = new pg.Pool({
      connectionString,
      options: '-c search_path=' + schema,
      max: 5,
    });
    const directory = await mkdtemp(join(tmpdir(), 'clog-admin-catalog-'));
    const icons = new IconStorage(directory),
      store = new PgStore(pool),
      catalog = new PgCatalogStore(pool);
    const app = createApp(
      () => store.ready(),
      () => store.settings(),
      {
        store,
        proofs: memoryProofFiles(),
        catalog,
        review: new PgReviewStore(pool, store),
        icons,
        auth: config,
        bot: { token: 'b'.repeat(64), guildId: '234567890123456789' },
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
      await icons.initialize();
      await store.ensureDefaultAdmin(await hashPassword(password));
      await pool.query('UPDATE staff_accounts SET must_change_password=false');
      await pool.query(
        "INSERT INTO items(id,name,icon_path) VALUES(1000001,'Source one','/catalog/items/1249.webp'),(1000002,'Source two','/catalog/items/3140.webp')",
      );
      await pool.query(
        'INSERT INTO game_item_ids(game_item_id,item_id) VALUES(1249,1000001)',
      );
      await pool.query(
        "INSERT INTO pages(id,name,category,sort_order) VALUES('a','A','bosses',0),('b','B','bosses',1)",
      );
      await pool.query(
        "INSERT INTO page_items(page_id,item_id,slot) VALUES('a',1000001,0),('a',1000002,1),('b',1000002,0)",
      );
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { origin: config.origin },
        payload: { username: 'admin', password },
      });
      assert.equal(login.statusCode, 200, login.body);
      const headers = {
        cookie: String(login.headers['set-cookie']).split(';')[0]!,
        origin: config.origin,
        'x-csrf-token': login.json().csrfToken as string,
      };
      const adminCatalog = async () => {
        const result = await app.inject({
          url: '/api/v1/admin/catalog',
          headers,
        });
        assert.equal(result.statusCode, 200, result.body);
        return result.json<AdminCatalog>();
      };
      const bytes = await sharp({
        create: { width: 36, height: 32, channels: 4, background: '#ff000080' },
      })
        .png()
        .toBuffer();
      const upload = async () => {
        const body = form(bytes);
        const result = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/catalog/icons',
          ...body,
          headers: { ...body.headers, ...headers },
        });
        assert.equal(result.statusCode, 201, result.body);
        return result.json<{ assetId: string; iconPath: string }>();
      };
      assert.equal((await app.inject('/api/v1/admin/catalog')).statusCode, 401);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/admin/catalog/icons',
            ...form(bytes),
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/admin/catalog/items',
            headers: { cookie: headers.cookie },
            payload: {},
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/admin/catalog/items',
            headers: { ...headers, origin: 'https://evil.test' },
            payload: {},
          })
        ).statusCode,
        403,
      );
      for (const input of [
        form(Buffer.from('not an image')),
        form(bytes, 'image/webp'),
        form(Buffer.alloc(MAX_ICON_BYTES + 1)),
      ]) {
        const result = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/catalog/icons',
          ...input,
          headers: { ...input.headers, ...headers },
        });
        assert.ok([400, 413].includes(result.statusCode), result.body);
      }
      const staged = await upload();
      assert.equal((await app.inject(staged.iconPath)).statusCode, 401);
      assert.equal(
        (await app.inject({ url: staged.iconPath, headers })).statusCode,
        200,
      );
      const fields = {
        name: 'Manual trophy',
        gameItemIds: [39999],
        iconAssetId: staged.assetId,
        pageIds: ['a', 'b'],
      };
      const create = (body: unknown, key = 'create-fixture-1') =>
        app.inject({
          method: 'POST',
          url: '/api/v1/admin/catalog/items',
          headers: { ...headers, 'idempotency-key': key },
          payload: body as object,
        });
      for (const invalid of [
        { ...fields, name: '  ' },
        { ...fields, pageIds: [] },
        { ...fields, pageIds: ['a', 'a'] },
        { ...fields, pageIds: ['unknown'] },
        { ...fields, iconAssetId: 'not-an-asset' },
        { ...fields, gameItemIds: [] },
        { ...fields, gameItemIds: [40000, 40000] },
        { ...fields, gameItemIds: [0] },
        { name: 'Missing fields' },
      ])
        assert.equal((await create(invalid)).statusCode, 400);
      const before = await app.inject('/api/v1/catalog');
      const results = await Promise.all([create(fields), create(fields)]);
      for (const result of results)
        assert.equal(result.statusCode, 201, result.body);
      const created = results[0]!.json<CreatedItem>();
      assert.deepEqual(results[1]!.json(), created);
      assert.ok(created.item.id > 1000002);
      assert.equal(created.item.origin, 'manual');
      assert.equal(
        (await pool.query('SELECT count(*)::int AS n FROM catalog_audit'))
          .rows[0].n,
        1,
      );
      assert.equal(
        (await pool.query('SELECT count(*)::int AS n FROM submissions')).rows[0]
          .n,
        0,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM game_item_ids WHERE item_id=$1',
            [created.item.id],
          )
        ).rows[0].n,
        1,
      );
      const first = await adminCatalog();
      assert.deepEqual(first.pages[0]!.itemIds, [
        1000001,
        1000002,
        created.item.id,
      ]);
      assert.deepEqual(first.pages[1]!.itemIds, [1000002, created.item.id]);
      const publicCatalog = await app.inject({
        url: '/api/v1/catalog',
        headers: { 'if-none-match': before.headers.etag! },
      });
      assert.equal(publicCatalog.statusCode, 200);
      assert.notEqual(publicCatalog.headers.etag, before.headers.etag);
      assert.equal(
        (await app.inject('/api/v1/catalog/search?q=Manual')).json().items[0]
          .id,
        created.item.id,
      );
      const botHeaders = { authorization: 'Bearer ' + 'b'.repeat(64) };
      const suggestions = await app.inject({
        url: '/api/v1/bot/items?q=Manual',
        headers: botHeaders,
      });
      assert.equal(suggestions.statusCode, 200, suggestions.body);
      assert.equal(suggestions.json().items[0].id, created.item.id);
      const claim = await app.inject(
        await botRequest(
          {
            interactionId: '345678901234567890',
            guildId: '234567890123456789',
            actorDiscordId: '123456789012345678',
            rawItemText: created.item.name,
            collectorName: 'Fixture collector',
            hardcore: false,
          },
          botHeaders,
        ),
      );
      assert.equal(claim.statusCode, 201, claim.body);
      assert.equal(claim.json().itemId, created.item.id);
      assert.equal(claim.json().resolution, 'resolved');
      assert.equal(claim.json().status, 'pending');
      const image = await app.inject(created.item.iconPath);
      assert.equal(image.statusCode, 200);
      assert.equal(image.headers['content-type'], 'image/webp');
      assert.match(image.headers['cache-control']!, /immutable/u);
      assert.deepEqual(
        await new IconStorage(directory).read(
          (await catalog.asset(staged.assetId))!,
        ),
        image.rawPayload,
      );
      assert.equal(
        (await create({ ...fields, name: 'Other' })).statusCode,
        409,
      );
      assert.equal(
        (await create(fields, 'reuse-claimed-asset')).statusCode,
        409,
      );
      // Credits in both worlds belong to the item and survive page edits and reconciliation.
      for (const hardcore of [false, true])
        await pool.query(
          `INSERT INTO submissions(id,discord_interaction_id,discord_user_id,discord_guild_id,raw_item_text,item_id,collector_name,collected_on,date_source,proof_url,status,reviewed_by,reviewed_at,hardcore) VALUES($1,$2,'1','2','Manual trophy',$3,'Fixture','2026-10-08','admin','https://imgur.com/fixture','approved',$4,now(),$5)`,
          [randomUUID(), randomUUID(), created.item.id, actor, hardcore],
        );
      const reorder = (orderedItemIds: number[], expectedVersion: string) =>
        app.inject({
          method: 'PUT',
          url: '/api/v1/admin/catalog/pages/a/order',
          headers,
          payload: { orderedItemIds, expectedVersion },
        });
      assert.equal(
        (
          await reorder(
            [created.item.id, created.item.id],
            first.pages[0]!.version,
          )
        ).statusCode,
        400,
      );
      const order = [created.item.id, 1000002, 1000001];
      const competing = await Promise.all([
        reorder(order, first.pages[0]!.version),
        reorder(order, first.pages[0]!.version),
      ]);
      assert.deepEqual(
        competing.map((result) => result.statusCode).sort(),
        [200, 409],
      );
      const after = await adminCatalog();
      assert.deepEqual(after.pages[0]!.itemIds, order);
      assert.equal(after.pages[0]!.orderOrigin, 'manual');
      assert.deepEqual(after.pages[1], first.pages[1]);
      const aliases = (gameItemIds: number[], revision: string) =>
        app.inject({
          method: 'POST',
          url: `/api/v1/admin/catalog/items/${created.item.id}/aliases`,
          headers,
          payload: {
            gameItemIds,
            expectedRevision: revision,
            reason: 'Reviewed new source identity',
          },
        });
      assert.equal((await aliases([1249], after.revision)).statusCode, 409);
      assert.equal((await aliases([40000], first.revision)).statusCode, 409);
      const reconciled = await aliases([40000], after.revision);
      assert.equal(reconciled.statusCode, 200, reconciled.body);
      assert.deepEqual(reconciled.json().gameItemIds, [39999, 40000]);
      assert.equal(
        (
          await pool.query(
            'SELECT item_id FROM game_item_ids WHERE game_item_id=40000',
          )
        ).rows[0].item_id,
        created.item.id,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM collection_credits WHERE item_id=$1',
            [created.item.id],
          )
        ).rows[0].n,
        2,
      );
      assert.ok(
        (
          await pool.query('SELECT actor_discord_id FROM catalog_audit')
        ).rows.every((row) => row.actor_discord_id === actor),
      );
      // Same-name items stay distinct; appending membership invalidates an open order editor.
      const next = await upload();
      const duplicate = await create(
        { ...fields, gameItemIds: [40001], iconAssetId: next.assetId },
        'same-name-fixture',
      );
      assert.equal(duplicate.statusCode, 201, duplicate.body);
      assert.notEqual(duplicate.json().item.id, created.item.id);
      assert.equal(
        (await reorder(order, after.pages[0]!.version)).statusCode,
        409,
      );
      const expired = await upload();
      await pool.query(
        "UPDATE catalog_assets SET expires_at=now()-interval '1 second' WHERE id=$1",
        [expired.assetId],
      );
      assert.equal(
        (
          await create(
            { ...fields, gameItemIds: [40002], iconAssetId: expired.assetId },
            'expired-fixture',
          )
        ).statusCode,
        409,
      );
      assert.equal(
        (await app.inject({ url: expired.iconPath, headers })).statusCode,
        404,
      );
      // Missing durable files abort creation rather than committing a broken public icon.
      const missing = await upload();
      await icons.remove(missing.assetId);
      const count = (await pool.query('SELECT count(*)::int AS n FROM items'))
        .rows[0].n;
      assert.equal(
        (
          await create(
            { ...fields, gameItemIds: [40002], iconAssetId: missing.assetId },
            'missing-fixture',
          )
        ).statusCode,
        503,
      );
      assert.equal(
        (await pool.query('SELECT count(*)::int AS n FROM items')).rows[0].n,
        count,
      );
      // Editing keeps canonical identity and credits while replacing RuneLite mappings and icons.
      const edit = async (fields: object, expectedRevision?: string) =>
        app.inject({
          method: 'PATCH',
          url: `/api/v1/admin/catalog/items/${created.item.id}`,
          headers,
          payload: {
            ...fields,
            expectedRevision:
              expectedRevision ?? (await adminCatalog()).revision,
          },
        });
      const editBefore = await adminCatalog();
      assert.equal(
        (await edit({ name: 'Renamed trophy', gameItemIds: [1249] }))
          .statusCode,
        409,
      );
      assert.deepEqual(await adminCatalog(), editBefore);
      const replacement = await upload();
      const edited = await edit({
        name: 'Renamed trophy',
        gameItemIds: [40003, 40004],
        iconAssetId: replacement.assetId,
      });
      assert.equal(edited.statusCode, 200, edited.body);
      const editedItem = (await adminCatalog()).items.find(
        (item) => item.id === created.item.id,
      )!;
      assert.equal(editedItem.name, 'Renamed trophy');
      assert.equal(editedItem.iconPath, replacement.iconPath);
      assert.deepEqual(editedItem.gameItemIds, [40003, 40004]);
      assert.equal((await app.inject(created.item.iconPath)).statusCode, 200);
      assert.equal((await app.inject(replacement.iconPath)).statusCode, 200);
      assert.equal(
        (
          await edit(
            { name: 'Stale', gameItemIds: [40003] },
            editBefore.revision,
          )
        ).statusCode,
        409,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM collection_credits WHERE item_id=$1',
            [created.item.id],
          )
        ).rows[0].n,
        2,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/logout',
            headers,
          })
        ).statusCode,
        204,
      );
      assert.equal(
        (await app.inject({ url: '/api/v1/admin/catalog', headers }))
          .statusCode,
        401,
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
