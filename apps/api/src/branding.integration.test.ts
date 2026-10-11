/** Real storage, restricted HTTP writes, database concurrency and immutable publication. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import sharp from 'sharp';
import { createApp } from './app.js';
import { PgStore } from './store.js';
import { PgBrandingStore, defaultBranding } from './branding-store.js';
import { BrandingStorage, MAX_LOGO_BYTES } from './branding-storage.js';
import { hashPassword } from './passwords.js';
test(
  'admin-only logo changes validate uploads, publish an animated logo and first-frame icon, audit and reject stale writes',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const root = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL!,
    });
    const schema = 'branding_test_' + randomUUID().replaceAll('-', '');
    await root.query('CREATE SCHEMA ' + schema);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL!,
      options: '-c search_path=' + schema,
    });
    const directory = await mkdtemp(join(tmpdir(), 'clog-branding-'));
    const backend = new PgStore(pool),
      branding = new PgBrandingStore(pool),
      logos = new BrandingStorage(directory);
    const auth = {
      origin: 'https://clog.example.com',
      secret: 'a'.repeat(64),
      secure: true,
    };
    const app = createApp(undefined, undefined, {
      store: backend,
      branding,
      logos,
      auth,
      logger: false,
    });
    try {
      const migrations = new URL(
        '../../../packages/database/migrations/',
        import.meta.url,
      );
      for (const file of (await readdir(migrations))
        .filter((file) => file.endsWith('.sql'))
        .sort())
        await pool.query(await readFile(new URL(file, migrations), 'utf8'));
      await logos.initialize();
      await app.ready();
      assert.deepEqual(
        (await app.inject('/api/v1/branding')).json(),
        defaultBranding,
      );
      const login = async (username: string, password: string) => {
        const result = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: { origin: auth.origin },
          payload: { username, password },
        });
        assert.equal(result.statusCode, 200, result.body);
        return {
          origin: auth.origin,
          cookie: String(result.headers['set-cookie']).split(';')[0]!,
          'x-csrf-token': result.json().csrfToken as string,
        };
      };
      const setup = await login('admin', 'admin');
      const admin = (await backend.accountByUsername('admin'))!;
      const svg = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="20"><rect width="10" height="20" fill="red"/></svg>',
      );
      const multipart = (bytes = svg, field = 'logo', extra = false) => {
        const file = Buffer.concat([
          Buffer.from(
            `--logo-boundary\r\nContent-Disposition: form-data; name="${field}"; filename="../../logo.svg"\r\nContent-Type: application/octet-stream\r\n\r\n`,
          ),
          bytes,
          Buffer.from('\r\n'),
        ]);
        return Buffer.concat([
          file,
          ...(extra ? [file] : []),
          Buffer.from('--logo-boundary--\r\n'),
        ]);
      };
      const upload = (
        headers: Record<string, string>,
        revision = 'branding-1',
        bytes = svg,
        field = 'logo',
        extra = false,
      ) =>
        app.inject({
          method: 'PUT',
          url: '/api/v1/admin/branding/logo',
          payload: multipart(bytes, field, extra),
          headers: {
            ...headers,
            'if-match': revision,
            'content-type': 'multipart/form-data; boundary=logo-boundary',
          },
        });
      assert.equal((await upload({})).statusCode, 401);
      assert.equal((await upload(setup)).statusCode, 403);
      await backend.updateAccount(
        admin.id,
        admin.credentialVersion,
        'owner',
        await hashPassword('owner-password'),
      );
      const owner = await login('owner', 'owner-password');
      const mod = await backend.createModerator(
        'reviewer',
        await hashPassword('mod-password'),
        admin.id,
      );
      const account = (await backend.accountById(mod.id))!;
      await backend.updateAccount(
        account.id,
        account.credentialVersion,
        account.username,
        await hashPassword('new-mod-password'),
      );
      const moderator = await login('reviewer', 'new-mod-password');
      assert.equal((await upload(moderator)).statusCode, 403);
      assert.equal(
        (
          await app.inject({
            url: '/api/v1/admin/branding',
            headers: moderator,
          })
        ).statusCode,
        403,
      );
      for (const headers of [
        { ...owner, origin: 'https://wrong.example.com' },
        { ...owner, 'x-csrf-token': 'invalid' },
      ])
        assert.equal((await upload(headers)).statusCode, 403);
      assert.equal((await upload(owner, 'bad')).statusCode, 400);
      assert.equal(
        (await upload(owner, 'branding-1', Buffer.from('bad image')))
          .statusCode,
        400,
      );
      assert.equal(
        (await upload(owner, 'branding-1', svg, 'unexpected')).statusCode,
        400,
      );
      assert.equal(
        (await upload(owner, 'branding-1', svg, 'logo', true)).statusCode,
        413,
      );
      assert.equal(
        (await upload(owner, 'branding-1', Buffer.alloc(MAX_LOGO_BYTES + 1)))
          .statusCode,
        413,
      );
      assert.deepEqual(await readdir(directory), []);
      const animation = await sharp(
        Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]),
        { raw: { width: 1, height: 2, pageHeight: 1, channels: 4 } },
      )
        .gif({ delay: [120, 230], loop: 3 })
        .toBuffer();
      const results = await Promise.all([
        upload(owner, 'branding-1', animation),
        upload(owner, 'branding-1', animation),
      ]);
      assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
      const saved = results.find((r) => r.statusCode === 200)!.json();
      assert.deepEqual((await app.inject('/api/v1/branding')).json(), saved);
      assert.equal((await readdir(directory)).length, 2);
      const logo = await app.inject(saved.logoPath),
        icon = await app.inject(saved.faviconPath);
      assert.equal(logo.statusCode, 200);
      assert.equal(logo.headers['content-type'], 'image/webp');
      assert.equal(icon.headers['content-type'], 'image/png');
      {
        const metadata = await sharp(logo.rawPayload, {
          animated: true,
        }).metadata();
        assert.equal(metadata.pages, 2);
        assert.deepEqual(metadata.delay, [120, 230]);
        assert.equal(metadata.loop, 3);
      }
      const cache = await app.inject({
        url: saved.logoPath,
        headers: { 'if-none-match': logo.headers.etag as string },
      });
      assert.equal(cache.statusCode, 304);
      assert.match(logo.headers['cache-control'] as string, /immutable/u);
      assert.equal(
        (await app.inject('/api/v1/branding/not-a-uuid.webp')).statusCode,
        404,
      );
      assert.equal(
        (await app.inject('/api/v1/branding/' + randomUUID() + '.webp'))
          .statusCode,
        404,
      );
      const audit = (await pool.query('SELECT * FROM clan_branding_audit'))
        .rows;
      assert.equal(audit.length, 1);
      assert.equal(audit[0].actor_id, admin.id);
      assert.equal(audit[0].old_logo_asset_id, null);
      const restoredStorage = new BrandingStorage(directory),
        restoredStore = new PgBrandingStore(pool);
      assert.deepEqual(await restoredStore.settings(), saved);
      const record = (await restoredStore.asset(audit[0].new_logo_asset_id))!;
      assert.deepEqual(
        await restoredStorage.read(record.logo),
        logo.rawPayload,
      );
      assert.deepEqual(
        await restoredStorage.favicons.read(record.favicon),
        icon.rawPayload,
      );
      const reset = (
        headers: Record<string, string>,
        expectedRevision: string,
      ) =>
        app.inject({
          method: 'DELETE',
          url: '/api/v1/admin/branding/logo',
          headers,
          payload: { expectedRevision },
        });
      assert.equal((await reset(moderator, saved.revision)).statusCode, 403);
      assert.equal((await reset(owner, 'branding-1')).statusCode, 409);
      const result = await reset(owner, saved.revision);
      assert.equal(result.statusCode, 200, result.body);
      assert.deepEqual(result.json(), {
        ...defaultBranding,
        revision: 'branding-3',
      });
      // Cached clients and audit history may still refer to the old immutable assets.
      assert.deepEqual(
        (await app.inject(saved.logoPath)).rawPayload,
        logo.rawPayload,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::integer AS n FROM clan_branding_audit',
          )
        ).rows[0].n,
        2,
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
