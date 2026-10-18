import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '@clog/database/dist/migrate.js';
import { PgDiscordSettingsStore } from '@clog/database/dist/discord-settings.js';
import { createApp } from './app.js';
import { PgStore } from './store.js';
import { setupAdministrator } from './setup-admin.js';

test(
  'Discord settings enforce administrator/CSRF boundaries, encrypt secrets, reconcile revisions and apply intake changes immediately',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    const schema = 'discord_' + randomUUID().replaceAll('-', '');
    const owner = new pg.Pool({ connectionString: url.href });
    await owner.query('CREATE SCHEMA ' + schema);
    url.searchParams.set('options', '-c search_path=' + schema);
    const pool = new pg.Pool({ connectionString: url.href });
    t.after(async () => {
      await pool.end();
      await owner.query('DROP SCHEMA ' + schema + ' CASCADE');
      await owner.end();
    });
    await migrate(url.href);
    const password = 'a'.repeat(64);
    await setupAdministrator(pool, password);
    await pool.query('UPDATE staff_accounts SET must_change_password=false');
    await pool.query(
      "INSERT INTO staff_accounts(id,username,role,password_hash,must_change_password) SELECT $1,'moderator','moderator',password_hash,false FROM staff_accounts WHERE role='admin'",
      [randomUUID()],
    );
    const key = randomBytes(32),
      settings = new PgDiscordSettingsStore(pool, key);
    await Promise.all([settings.ensureDefault(), settings.ensureDefault()]);
    const initial = await settings.settings();
    assert.equal(initial.enabled, false);
    assert.equal(initial.tokenConfigured, false);
    const store = new PgStore(pool),
      registrations: unknown[][] = [];
    const app = createApp(
      () => store.ready(),
      () => store.settings(),
      {
        store,
        auth: {
          origin: 'https://clog.example.com',
          secret: 'c'.repeat(64),
          secure: true,
        },
        discordSettings: settings,
        registerDiscord: async (...args) => {
          registrations.push(args);
        },
        botConfiguration: async () => {
          const saved = await settings.runtime();
          return saved.enabled
            ? { token: saved.apiToken, guildId: saved.guildId }
            : undefined;
        },
        logger: false,
      },
    );
    t.after(() => app.close());
    const route = '/api/v1/admin/discord-settings';
    assert.equal((await app.inject({ url: route })).statusCode, 401);
    const login = async (username: string) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { origin: 'https://clog.example.com' },
        payload: { username, password },
      });
      assert.equal(response.statusCode, 200);
      const cookie = String(response.headers['set-cookie']).split(';')[0]!;
      const session = (
        await app.inject({ url: '/api/v1/auth/session', headers: { cookie } })
      ).json();
      return {
        cookie,
        origin: 'https://clog.example.com',
        'x-csrf-token': session.csrfToken,
      };
    };
    const admin = await login('admin'),
      moderator = await login('moderator');
    for (const method of ['GET', 'PUT', 'POST'] as const) {
      const response = await app.inject({
        method,
        url: route + (method === 'POST' ? '/register' : ''),
        headers: moderator,
        ...(method !== 'GET' ? { payload: {} } : {}),
      });
      assert.equal(response.statusCode, 403);
    }
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: route,
          headers: { cookie: admin.cookie },
          payload: {},
        })
      ).statusCode,
      403,
    );
    const read = await app.inject({ url: route, headers: admin });
    assert.equal(read.headers['cache-control'], 'no-store');
    assert.equal(read.json().token, undefined);
    const fields = {
      enabled: true,
      applicationId: '123456789012345678',
      guildId: '223456789012345678',
      testGuildId: '323456789012345678',
      limits: initial.limits,
    };
    const token = 'private_discord_token_123456789012345678';
    const savedResponse = await app.inject({
      method: 'PUT',
      url: route,
      headers: admin,
      payload: { ...fields, token, expectedRevision: initial.revision },
    });
    assert.equal(savedResponse.statusCode, 200);
    const saved = savedResponse.json();
    assert.equal(saved.tokenConfigured, true);
    assert.doesNotMatch(savedResponse.body, /private_discord|apiToken/);
    const credentials = (
      await pool.query('SELECT credentials FROM discord_settings')
    ).rows[0].credentials;
    assert.ok(!credentials.includes(token));
    const runtime = await settings.runtime();
    assert.ok(!credentials.includes(runtime.apiToken));
    assert.equal(
      (
        await app.inject({
          url: '/api/v1/bot/items?q=',
          headers: { authorization: 'Bearer ' + runtime.apiToken },
        })
      ).statusCode,
      200,
    );
    assert.equal(registrations.length, 0);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: route + '/register',
          headers: admin,
          payload: { target: 'test', expectedRevision: saved.revision },
        })
      ).statusCode,
      200,
    );
    assert.deepEqual(registrations, [
      [fields.applicationId, fields.testGuildId, token],
    ]);
    const writes = await Promise.all(
      [1, 2].map(() =>
        app.inject({
          method: 'PUT',
          url: route,
          headers: admin,
          payload: {
            ...fields,
            enabled: false,
            expectedRevision: saved.revision,
          },
        }),
      ),
    );
    assert.deepEqual(
      writes.map((value) => value.statusCode).sort(),
      [200, 409],
    );
    assert.equal(
      (
        await app.inject({
          url: '/api/v1/bot/items?q=',
          headers: { authorization: 'Bearer ' + runtime.apiToken },
        })
      ).statusCode,
      503,
    );
    const current = await settings.settings();
    assert.equal(current.tokenConfigured, true);
    const replacement = 'different_discord_token_123456789012345678';
    await settings.update(
      { ...fields, token: replacement, expectedRevision: current.revision },
      '00000000-0000-4000-8000-000000000001',
    );
    assert.equal(
      (
        await app.inject({
          url: '/api/v1/bot/items?q=',
          headers: { authorization: 'Bearer ' + runtime.apiToken },
        })
      ).statusCode,
      401,
    );
    const next = await settings.runtime();
    assert.notEqual(next.apiToken, runtime.apiToken);
    await assert.rejects(
      new PgDiscordSettingsStore(pool, randomBytes(32)).ensureDefault(),
      /credential storage is unavailable/,
    );
    const audit = JSON.stringify(
      (await pool.query('SELECT * FROM discord_settings_audit')).rows,
    );
    assert.ok(
      !audit.includes(token) &&
        !audit.includes(replacement) &&
        !audit.includes(runtime.apiToken),
    );
    await settings.update(
      { ...fields, enabled: false, token: '', expectedRevision: next.revision },
      '00000000-0000-4000-8000-000000000001',
    );
    assert.equal((await settings.settings()).tokenConfigured, false);
  },
);
