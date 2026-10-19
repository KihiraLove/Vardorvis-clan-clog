/** Upgrade the released schema, retain accounts/credits/sessions, then exercise real authorization. */
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import {
  defaultModeratorPages,
  staffPages,
  type StaffPage,
} from '@clog/domain';
import { migrate } from '@clog/database/dist/migrate.js';
import { PgDiscordSettingsStore } from '@clog/database/dist/discord-settings.js';
import { createApp } from './app.js';
import { PgStore } from './store.js';
import { PgAccessControlStore } from './access-control.js';
import { PgCatalogStore } from './catalog-store.js';
import { PgReviewStore } from './review-store.js';
import { PgSchedulingStore } from './scheduling-store.js';
import { PgRuneLiteSettingsStore } from './runelite-settings.js';
import { PgClanKeyStore } from './clan-api-key.js';
import { PgBrandingStore } from './branding-store.js';
import { BrandingStorage } from './branding-storage.js';
import { IconStorage } from './icon-storage.js';
import { ProofStorage } from './proof-storage.js';
import { PgProofStore } from './proof-store.js';
import { setupAdministrator } from './setup-admin.js';

test(
  'live baseline upgrades preserve accounts, sessions and credits; moderator pages enforce reads, writes and owner boundaries',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    const owner = new pg.Pool({ connectionString: url.href });
    const schema = 'access_' + randomUUID().replaceAll('-', '');
    await owner.query('CREATE SCHEMA ' + schema);
    url.searchParams.set('options', '-c search_path=' + schema);
    const pool = new pg.Pool({ connectionString: url.href });
    const directory = await mkdtemp(join(tmpdir(), 'clog-access-'));
    const resources: { app?: ReturnType<typeof createApp> } = {};
    t.after(async () => {
      await resources.app?.close();
      await pool.end();
      await owner.query('DROP SCHEMA ' + schema + ' CASCADE');
      await owner.end();
      await rm(directory, { recursive: true, force: true });
    });
    const baseline = await readFile(
      new URL(
        '../../../packages/database/migrations/001_baseline.sql',
        import.meta.url,
      ),
      'utf8',
    );
    await pool.query(
      'CREATE TABLE schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    await pool.query(baseline);
    const checksum = createHash('sha256').update(baseline).digest('hex');
    assert.equal(
      checksum,
      'e8c05aeed9e62b84a8a3286b4580a61f670c40be11a7b11eba9402663df3e6ba',
      'The released baseline is immutable.',
    );
    await pool.query(
      'INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',
      ['001_baseline.sql', checksum],
    );
    const password = 'live-test-password-123456';
    await setupAdministrator(pool, password);
    await pool.query('UPDATE staff_accounts SET must_change_password=false');
    const backend = new PgStore(pool);
    const admin = (await backend.accountByUsername('admin'))!;
    const moderator = await backend.createModerator(
      'reviewer',
      admin.passwordHash,
      admin.id,
    );
    await pool.query(
      'UPDATE staff_accounts SET must_change_password=false WHERE id=$1',
      [moderator.id],
    );
    await pool.query(
      "INSERT INTO items(id,name) VALUES(900001,'Retained live credit')",
    );
    const credit = randomUUID();
    await pool.query(
      "INSERT INTO submissions(id,discord_interaction_id,discord_user_id,discord_guild_id,raw_item_text,item_id,collector_name,collected_on,date_source,proof_url,status,reviewed_by,reviewed_at) VALUES($1,'live-credit','1','2','Retained live credit',900001,'Collector',CURRENT_DATE,'admin','https://imgur.com/live-credit','approved',$2,now())",
      [credit, admin.id],
    );
    const auth = {
      origin: 'https://clog.example.com',
      secret: 'c'.repeat(64),
      secure: true,
    };
    const token = 'z'.repeat(43);
    await backend.createSession(
      createHmac('sha256', auth.secret)
        .update('session:' + token)
        .digest('hex'),
      { id: moderator.id, displayName: 'reviewer', accountVersion: 1 },
      new Date(Date.now() + 3600000),
    );
    const before = (
      await pool.query('SELECT * FROM staff_accounts ORDER BY id')
    ).rows;
    await migrate(url.href);
    await migrate(url.href);
    assert.deepEqual(
      (await pool.query('SELECT * FROM staff_accounts ORDER BY id')).rows,
      before,
    );
    assert.equal(
      (await pool.query('SELECT status FROM submissions WHERE id=$1', [credit]))
        .rows[0].status,
      'approved',
    );
    assert.deepEqual(
      (await pool.query('SELECT item_id FROM collection_credits')).rows,
      [{ item_id: 900001 }],
    );
    assert.deepEqual(
      (
        await pool.query(
          'SELECT name,checksum FROM schema_migrations ORDER BY name',
        )
      ).rows.map((row) => row.name),
      [
        '001_baseline.sql',
        '002_staff_page_access.sql',
        '003_wom_multi_metric.sql',
        '004_permanently_open_pages.sql',
        '005_unmatched_runelite.sql',
      ],
    );
    assert.equal(
      (
        await pool.query(
          "SELECT checksum FROM schema_migrations WHERE name='001_baseline.sql'",
        )
      ).rows[0].checksum,
      checksum,
    );
    const access = new PgAccessControlStore(pool);
    assert.deepEqual(
      (await access.settings()).moderatorPages,
      defaultModeratorPages,
    );
    const logos = new BrandingStorage(join(directory, 'logos'));
    const icons = new IconStorage(join(directory, 'icons'));
    const proofs = new ProofStorage(join(directory, 'proofs'));
    await logos.initialize();
    await icons.initialize();
    await proofs.initialize();
    const clanKeys = new PgClanKeyStore(pool, Buffer.alloc(32, 1));
    await clanKeys.ensureDefault();
    const discord = new PgDiscordSettingsStore(pool, Buffer.alloc(32, 2));
    await discord.ensureDefault();
    const app = createApp(
      () => backend.ready(),
      () => backend.settings(),
      {
        store: backend,
        auth,
        accessControl: access,
        logger: false,
        catalog: new PgCatalogStore(pool),
        icons,
        review: new PgReviewStore(pool, backend),
        scheduling: new PgSchedulingStore(pool),
        runeLiteSettings: new PgRuneLiteSettingsStore(pool),
        branding: new PgBrandingStore(pool),
        logos,
        proofs,
        proofStore: new PgProofStore(pool),
        clanKeys,
        discordSettings: discord,
      },
    );
    resources.app = app;
    await app.ready();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: auth.origin },
      payload: { username: 'admin', password },
    });
    assert.equal(login.statusCode, 200, login.body);
    const adminHeaders = {
      origin: auth.origin,
      cookie: String(login.headers['set-cookie']).split(';')[0]!,
      'x-csrf-token': login.json().csrfToken,
    };
    const moderatorCookie = { cookie: '__Host-clog-session=' + token };
    const restored = await app.inject({
      url: '/api/v1/auth/session',
      headers: moderatorCookie,
    });
    assert.equal(restored.json().authenticated, true);
    assert.deepEqual(restored.json().allowedPages, defaultModeratorPages);
    const modHeaders = {
      ...moderatorCookie,
      origin: auth.origin,
      'x-csrf-token': restored.json().csrfToken,
    };
    const route = '/api/v1/admin/access-control';
    assert.equal((await app.inject({ url: route })).statusCode, 401);
    assert.equal(
      (await app.inject({ url: route, headers: modHeaders })).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: route,
          headers: modHeaders,
          payload: { expectedRevision: 'access-control-1', moderatorPages: [] },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: route,
          headers: { cookie: adminHeaders.cookie },
          payload: {},
        })
      ).statusCode,
      403,
    );
    for (const moderatorPages of [
      ['access-control'],
      ['accounts'],
      ['submissions', 'submissions'],
    ])
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: route,
            headers: adminHeaders,
            payload: { expectedRevision: 'access-control-1', moderatorPages },
          })
        ).statusCode,
        400,
      );
    let version = 'access-control-1';
    const save = async (moderatorPages: StaffPage[]) => {
      const response = await app!.inject({
        method: 'PUT',
        url: route,
        headers: adminHeaders,
        payload: { expectedRevision: version, moderatorPages },
      });
      assert.equal(response.statusCode, 200, response.body);
      version = response.json().revision;
    };
    const targets: Record<StaffPage, string> = {
      submissions: '/api/v1/admin/submissions',
      catalog: '/api/v1/admin/catalog',
      schedules: '/api/v1/admin/schedules',
      runelite: '/api/v1/admin/runelite-settings',
      settings: '/api/v1/admin/branding',
      hardcore: '/api/v1/admin/branding/hardcore',
      discord: '/api/v1/admin/discord-settings',
    };
    for (const selected of staffPages) {
      await save([selected.id]);
      assert.deepEqual(
        (
          await app.inject({ url: '/api/v1/auth/session', headers: modHeaders })
        ).json().allowedPages,
        [selected.id],
      );
      for (const target of staffPages) {
        const response: { statusCode: number; body: string } = await app.inject(
          { url: targets[target.id], headers: modHeaders },
        );
        const sharedCatalog =
          target.id === 'catalog' &&
          ['submissions', 'schedules'].includes(selected.id);
        assert.equal(
          response.statusCode,
          target.id === selected.id || sharedCatalog ? 200 : 403,
          selected.id + ' -> ' + targets[target.id] + ': ' + response.body,
        );
      }
      // Shared read access must not grant the catalog editor's mutation endpoints.
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/admin/catalog/items',
            headers: modHeaders,
            payload: {},
          })
        ).statusCode,
        selected.id === 'catalog' ? 400 : 403,
      );
    }
    await save(staffPages.map((page) => page.id));
    assert.equal(
      (
        await app.inject({
          method: 'HEAD',
          url: '/api/v1/admin/catalog',
          headers: modHeaders,
        })
      ).statusCode,
      200,
    );
    const rules = (
      await app.inject({
        url: '/api/v1/admin/runelite-settings',
        headers: modHeaders,
      })
    ).json();
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/v1/admin/runelite-settings',
          headers: modHeaders,
          payload: {
            ...rules,
            expectedRevision: rules.revision,
            revision: undefined,
          },
        })
      ).statusCode,
      200,
    );
    for (const path of [
      '/api/v1/admin/settings',
      '/api/v1/admin/clan-api-key',
      '/api/v1/admin/discord-settings',
      '/api/v1/admin/schedules/settings',
      '/api/v1/admin/submission-filters',
      '/api/v1/admin/branding/logo',
      '/api/v1/admin/branding/hardcore/logo',
    ])
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: path,
            headers: modHeaders,
            payload: {},
          })
        ).statusCode,
        403,
        path,
      );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/discord-settings/register',
          headers: modHeaders,
          payload: {},
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ url: '/api/v1/admin/accounts', headers: modHeaders }))
        .statusCode,
      403,
    );
    const beforeConflict = await access.settings();
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: route,
          headers: adminHeaders,
          payload: { expectedRevision: 'access-control-1', moderatorPages: [] },
        })
      ).statusCode,
      409,
    );
    assert.deepEqual(await access.settings(), beforeConflict);
    await save([]);
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/v1/admin/schedules/permanent-pages',
          headers: modHeaders,
          payload: { expectedRevision: 'schedules-1', pageIds: [] },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'HEAD',
          url: '/api/v1/admin/catalog',
          headers: modHeaders,
        })
      ).statusCode,
      403,
    );
    for (const path of Object.values(targets))
      assert.equal(
        (await app.inject({ url: path, headers: modHeaders })).statusCode,
        403,
        path,
      );
    assert.equal(
      (
        await app.inject({
          url: '/api/v1/admin/submission-images/' + randomUUID() + '.png',
          headers: modHeaders,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ url: route, headers: adminHeaders })).statusCode,
      200,
    );
    assert.deepEqual(
      (
        await app.inject({ url: '/api/v1/auth/session', headers: modHeaders })
      ).json().allowedPages,
      [],
    );
    const audit = (
      await pool.query(
        'SELECT actor_id,old_pages,new_pages,version FROM staff_page_access_audit ORDER BY version',
      )
    ).rows;
    assert.equal(audit.length, staffPages.length + 2);
    assert.ok(audit.every((row) => row.actor_id === admin.id));
    assert.deepEqual(audit[0].old_pages, defaultModeratorPages);
    assert.deepEqual(audit.at(-1).new_pages, []);
  },
);
