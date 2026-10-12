/** Upgrade existing presentation and verify independently audited hardcore settings. */
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
import { PgBrandingStore, defaultBranding } from './branding-store.js';
import { BrandingStorage } from './branding-storage.js';
import { hashPassword } from './passwords.js';

test(
  'upgrade copies existing appearance, removes the caption and keeps hardcore writes independent while disabled',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const root = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL!,
    });
    const schema = 'hc_appearance_' + randomUUID().replaceAll('-', '');
    await root.query('CREATE SCHEMA ' + schema);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL!,
      options: '-c search_path=' + schema,
    });
    const directory = await mkdtemp(join(tmpdir(), 'clog-hc-branding-'));
    const backend = new PgStore(pool),
      branding = new PgBrandingStore(pool),
      logos = new BrandingStorage(directory);
    const auth = {
      origin: 'https://clog.example.com',
      secret: 'a'.repeat(64),
      secure: true,
    };
    const app = createApp(undefined, () => backend.settings(), {
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
        .filter((f) => f.endsWith('.sql') && f < '010_')
        .sort())
        await pool.query(await readFile(new URL(file, migrations), 'utf8'));
      await logos.initialize();
      const svg = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>',
      );
      const original = await logos.saveLogo(svg),
        l = original.logo,
        f = original.favicon;
      await pool.query(
        'INSERT INTO clan_logo_assets(id,sha256,byte_size,width,height,favicon_id,favicon_sha256,favicon_byte_size,favicon_width,favicon_height) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          l.id,
          l.sha256,
          l.byteSize,
          l.width,
          l.height,
          f.id,
          f.sha256,
          f.byteSize,
          f.width,
          f.height,
        ],
      );
      await pool.query('UPDATE clan_branding SET version=2,logo_asset_id=$1', [
        l.id,
      ]);
      await pool.query(
        'INSERT INTO clan_branding_audit(actor_id,old_logo_asset_id,new_logo_asset_id,version) VALUES($1,NULL,$2,2)',
        ['historical-owner', l.id],
      );
      const regularCopy = {
        ...defaultSiteCopy,
        collectionTitle: 'Existing collection',
      };
      await pool.query('UPDATE site_settings SET clan_name=$1,public_copy=$2', [
        'Regular clan',
        JSON.stringify({ ...regularCopy, xpTotalCaption: 'Old caption' }),
      ]);
      await pool.query(
        'INSERT INTO site_settings_audit(actor_discord_id,old_enabled,new_enabled,version,old_public_copy,new_public_copy) VALUES($1,false,false,99,$2,$2)',
        [
          'historical-owner',
          JSON.stringify({
            ...regularCopy,
            xpTotalCaption: 'Historical caption',
          }),
        ],
      );
      await pool.query(
        await readFile(
          new URL('010_hardcore_appearance.sql', migrations),
          'utf8',
        ),
      );
      const initial = await backend.settings();
      assert.deepEqual(initial.copy, regularCopy);
      assert.deepEqual(initial.hardcore, {
        clanName: 'Regular clan',
        copy: regularCopy,
      });
      assert.equal(initial.hardcoreEnabled, false);
      assert.equal(
        (
          await pool.query(
            'SELECT new_public_copy FROM site_settings_audit WHERE version=99',
          )
        ).rows[0].new_public_copy.xpTotalCaption,
        'Historical caption',
      );
      assert.equal(
        (await pool.query('SELECT public_copy FROM site_settings')).rows[0]
          .public_copy.xpTotalCaption,
        undefined,
      );
      assert.equal(
        (await branding.settings(true)).logoPath,
        (await branding.settings()).logoPath,
      );
      await backend.ensureDefaultAdmin(await hashPassword('admin'));
      const admin = (await backend.accountByUsername('admin'))!;
      await backend.updateAccount(
        admin.id,
        admin.credentialVersion,
        'owner',
        await hashPassword('owner-password'),
      );
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { origin: auth.origin },
        payload: { username: 'owner', password: 'owner-password' },
      });
      assert.equal(login.statusCode, 200, login.body);
      const headers = {
        origin: auth.origin,
        cookie: String(login.headers['set-cookie']).split(';')[0]!,
        'x-csrf-token': login.json().csrfToken as string,
      };
      const hardcore = {
        clanName: 'Hardcore clan',
        copy: {
          ...defaultSiteCopy,
          collectionTitle: 'Hardcore drops',
          xpTitle: 'Hardcore training',
        },
      };
      const fields = {
        hardcoreEnabled: false,
        expectedRevision: initial.revision,
        hardcore,
      };
      const save = (payload: Record<string, unknown>, supplied = headers) =>
        app.inject({
          method: 'PUT',
          url: '/api/v1/admin/settings',
          headers: supplied,
          payload,
        });
      assert.equal(
        (
          await save({
            ...fields,
            hardcore: {
              ...hardcore,
              copy: { ...hardcore.copy, xpTotalCaption: 'retired' },
            },
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await save({
            ...fields,
            hardcore: { ...hardcore, clanName: 'bad\nname' },
          })
        ).statusCode,
        400,
      );
      const saved = await save(fields);
      assert.equal(saved.statusCode, 200, saved.body);
      assert.equal(saved.json().clanName, 'Regular clan');
      assert.deepEqual(saved.json().copy, regularCopy);
      assert.deepEqual(saved.json().hardcore, hardcore);
      assert.equal((await save(fields)).statusCode, 409);
      const regularSave = await save({
        hardcoreEnabled: false,
        expectedRevision: saved.json().revision,
        clanName: 'Renamed regular clan',
      });
      assert.equal(regularSave.statusCode, 200, regularSave.body);
      assert.deepEqual((await new PgStore(pool).settings()).hardcore, hardcore);
      assert.deepEqual(
        (await app.inject('/api/v1/settings')).json().hardcore,
        hardcore,
      );
      const audit = (
        await pool.query(
          'SELECT * FROM site_settings_audit WHERE actor_discord_id=$1 ORDER BY version LIMIT 1',
          [admin.id],
        )
      ).rows[0];
      assert.equal(audit.old_hardcore_name, 'Regular clan');
      assert.equal(audit.new_hardcore_name, 'Hardcore clan');
      assert.deepEqual(audit.old_public_copy, audit.new_public_copy);
      const moderator = await backend.createModerator(
        'reviewer',
        await hashPassword('mod-password'),
        admin.id,
      );
      const mod = (await backend.accountById(moderator.id))!;
      await backend.updateAccount(
        mod.id,
        mod.credentialVersion,
        mod.username,
        await hashPassword('new-mod-password'),
      );
      const modLogin = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { origin: auth.origin },
        payload: { username: 'reviewer', password: 'new-mod-password' },
      });
      const modHeaders = {
        origin: auth.origin,
        cookie: String(modLogin.headers['set-cookie']).split(';')[0]!,
        'x-csrf-token': modLogin.json().csrfToken as string,
      };
      assert.equal(
        (
          await save(
            { ...fields, expectedRevision: regularSave.json().revision },
            modHeaders,
          )
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            url: '/api/v1/admin/branding/hardcore',
            headers: modHeaders,
          })
        ).statusCode,
        403,
      );
      const upload = (
        supplied: Record<string, string>,
        revision = 'branding-1',
      ) =>
        app.inject({
          method: 'PUT',
          url: '/api/v1/admin/branding/hardcore/logo',
          headers: {
            ...supplied,
            'if-match': revision,
            'content-type': 'multipart/form-data; boundary=hc-logo',
          },
          payload: Buffer.concat([
            Buffer.from(
              '--hc-logo\r\nContent-Disposition: form-data; name="logo"; filename="logo.svg"\r\nContent-Type: image/svg+xml\r\n\r\n',
            ),
            svg,
            Buffer.from('\r\n--hc-logo--\r\n'),
          ]),
        });
      assert.equal((await upload({})).statusCode, 401);
      assert.equal((await upload(modHeaders)).statusCode, 403);
      assert.equal(
        (await upload({ ...headers, 'x-csrf-token': 'bad' })).statusCode,
        403,
      );
      const newLogo = await upload(headers);
      assert.equal(newLogo.statusCode, 200, newLogo.body);
      assert.equal(newLogo.json().revision, 'branding-2');
      assert.notEqual(
        newLogo.json().logoPath,
        (await branding.settings()).logoPath,
      );
      assert.equal((await branding.settings()).revision, 'branding-2');
      assert.deepEqual(
        (await app.inject('/api/v1/branding/hardcore')).json(),
        newLogo.json(),
      );
      assert.equal((await upload(headers)).statusCode, 409);
      assert.equal(
        (await app.inject(newLogo.json().faviconPath)).statusCode,
        200,
      );
      assert.deepEqual(
        await new PgBrandingStore(pool).settings(true),
        newLogo.json(),
      );
      const reset = await app.inject({
        method: 'DELETE',
        url: '/api/v1/admin/branding/hardcore/logo',
        headers,
        payload: { expectedRevision: 'branding-2' },
      });
      assert.equal(reset.statusCode, 200, reset.body);
      assert.equal(reset.json().logoPath, defaultBranding.logoPath);
      assert.equal(
        (await branding.settings()).logoPath,
        `/api/v1/branding/${l.id}.webp`,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*) FROM clan_branding_audit WHERE version=2',
          )
        ).rows[0].count,
        '2',
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
