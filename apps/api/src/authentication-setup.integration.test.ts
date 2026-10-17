/** Fresh setup and repeated startup preserve staff credentials and sessions. */
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { migrate } from '@clog/database/dist/migrate.js';
import { PgStore } from './store.js';
import { createApp } from './app.js';
import { hashPassword } from './passwords.js';

test(
  'fresh setup and repeated startup preserve password authentication',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    const root = new pg.Pool({ connectionString: url.toString() });
    const schema = 'auth_setup_' + randomUUID().replaceAll('-', '');
    await root.query('CREATE SCHEMA ' + schema);
    url.searchParams.set('options', '-c search_path=' + schema);
    const pool = new pg.Pool({ connectionString: url.toString() });
    const store = new PgStore(pool),
      password = 'new-password-session-test',
      secret = 'a'.repeat(64),
      token = 'A'.repeat(43);
    const cookie = '__Host-clog-session=' + token;
    try {
      await migrate(url.toString());
      await store.ensureDefaultAdmin(await hashPassword(password));
      await pool.query(
        "UPDATE staff_accounts SET must_change_password=false WHERE role='admin'",
      );
      const owner = (await store.accountByUsername('admin'))!;
      await store.createSession(
        createHmac('sha256', secret)
          .update('session:' + token)
          .digest('hex'),
        {
          id: owner.id,
          displayName: owner.username,
          accountVersion: owner.credentialVersion,
        },
        new Date(Date.now() + 3600000),
      );
      await migrate(url.toString());
      await store.ensureDefaultAdmin(
        await hashPassword('a different bootstrap password'),
      );
      assert.equal(
        (await pool.query('SELECT count(*)::int AS n FROM staff_accounts'))
          .rows[0].n,
        1,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT to_regclass(current_schema() || '.oauth_states') AS retired",
          )
        ).rows[0].retired,
        null,
      );
      await t.test(
        'password login, existing session, CSRF and logout work; retired endpoints are ordinary 404s',
        async () => {
          const app = createApp(undefined, undefined, {
            store,
            auth: { origin: 'https://clog.test', secret, secure: true },
            logger: false,
          });
          try {
            const session = await app.inject({
              url: '/api/v1/auth/session',
              headers: { cookie },
            });
            assert.equal(session.json().authenticated, true);
            const paths = [
              '/api/v1/auth/discord',
              '/api/v1/auth/discord/callback?code=retired&state=unused',
            ];
            for (const path of paths) {
              const response = await app.inject(path);
              assert.equal(response.statusCode, 404);
              assert.equal(response.headers['cache-control'], 'no-store');
              assert.ok(!response.body.includes('retired'));
            }
            assert.equal(
              (
                await app.inject({
                  method: 'POST',
                  url: '/api/v1/auth/logout',
                  headers: { cookie },
                })
              ).statusCode,
              403,
            );
            const login = await app.inject({
              method: 'POST',
              url: '/api/v1/auth/login',
              headers: { origin: 'https://clog.test' },
              payload: { username: 'admin', password },
            });
            assert.equal(login.statusCode, 200, login.body);
            const loggedInCookie = String(login.headers['set-cookie']).split(
              ';',
            )[0]!;
            const loggedIn = await app.inject({
              url: '/api/v1/auth/session',
              headers: { cookie: loggedInCookie },
            });
            assert.equal(loggedIn.json().authenticated, true);
            const logout = await app.inject({
              method: 'POST',
              url: '/api/v1/auth/logout',
              headers: {
                cookie: loggedInCookie,
                origin: 'https://clog.test',
                'x-csrf-token': loggedIn.json().csrfToken,
              },
            });
            assert.equal(logout.statusCode, 204);
            assert.equal(
              (
                await app.inject({
                  url: '/api/v1/auth/session',
                  headers: { cookie: loggedInCookie },
                })
              ).json().authenticated,
              false,
            );
          } finally {
            await app.close();
          }
        },
      );
    } finally {
      await pool.end();
      await root.query('DROP SCHEMA ' + schema + ' CASCADE');
      await root.end();
    }
  },
);
