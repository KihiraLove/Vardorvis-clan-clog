/** First-admin provisioning against an isolated schema; never uses clan data. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { PgStore } from './store.js';

test(
  'administrator bootstrap fails closed, chooses one concurrent initializer and cannot reset an existing account',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const connectionString = process.env.TEST_DATABASE_URL!;
    const schema = 'bootstrap_test_' + randomUUID().replaceAll('-', '');
    const root = new pg.Pool({ connectionString });
    await root.query('CREATE SCHEMA ' + schema);
    const pool = new pg.Pool({
      connectionString,
      options: '-c search_path=' + schema,
      max: 8,
    });
    const store = new PgStore(pool);
    const env = {
      NODE_ENV: 'production',
      AUTH_ENABLED: 'true',
      PUBLIC_ORIGIN: 'https://clog.example.com',
      SESSION_SECRET: 'a'.repeat(64),
    };
    const makeApp = (password?: string) =>
      createApp(undefined, undefined, {
        store: new PgStore(pool),
        logger: false,
        ...readConfig({
          ...env,
          ...(password === undefined
            ? {}
            : { ADMIN_BOOTSTRAP_PASSWORD: password }),
        }),
      });
    const apps: ReturnType<typeof makeApp>[] = [];
    const trackApp = (password?: string) => {
      const app = makeApp(password);
      apps.push(app);
      return app;
    };
    try {
      const migrations = new URL(
        '../../../packages/database/migrations/',
        import.meta.url,
      );
      for (const file of (await readdir(migrations))
        .filter((file) => file.endsWith('.sql'))
        .sort())
        await pool.query(await readFile(new URL(file, migrations), 'utf8'));

      await t.test(
        'missing credential prevents authenticated startup and leaves no account',
        async () => {
          await assert.rejects(async () => {
            await trackApp().ready();
          }, /No administrator exists.*ADMIN_BOOTSTRAP_PASSWORD/u);
          assert.deepEqual(await store.accounts(), []);
        },
      );
      await t.test(
        'invalid credentials fail validation without disclosing their value',
        () => {
          const invalid = 'do-not-log-this-bootstrap-password';
          assert.throws(
            () => readConfig({ ...env, ADMIN_BOOTSTRAP_PASSWORD: invalid }),
            (error: unknown) =>
              error instanceof Error &&
              error.message.includes('ADMIN_BOOTSTRAP_PASSWORD') &&
              !error.message.includes(invalid),
          );
        },
      );
      await t.test(
        'insert failure and username collision do not produce a usable administrator',
        async () => {
          const password = randomBytes(32).toString('hex');
          const id = randomUUID();
          await pool.query(
            "INSERT INTO staff_accounts(id,username,role,password_hash) VALUES($1,'admin','moderator',$2)",
            [id, await hashPassword(password)],
          );
          await assert.rejects(async () => {
            await trackApp(password).ready();
          }, /provisioning did not create an account/u);
          assert.equal(
            (await store.accounts()).some(
              (account) => account.role === 'admin',
            ),
            false,
          );
          await pool.query('DELETE FROM staff_accounts WHERE id=$1', [id]);
          await pool.query(
            "CREATE FUNCTION fail_bootstrap() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Fixture bootstrap failure'; END $$",
          );
          await pool.query(
            'CREATE TRIGGER fail_bootstrap BEFORE INSERT ON staff_accounts FOR EACH ROW EXECUTE FUNCTION fail_bootstrap()',
          );
          await assert.rejects(async () => {
            await trackApp(password).ready();
          }, /Fixture bootstrap failure/u);
          assert.deepEqual(await store.accounts(), []);
          await pool.query('DROP TRIGGER fail_bootstrap ON staff_accounts');
          await assert.rejects(async () => {
            await trackApp().ready();
          }, /No administrator exists/u);
        },
      );

      const candidates = Array.from({ length: 8 }, () =>
        randomBytes(32).toString('hex'),
      );
      const initializers = candidates.map((password) => trackApp(password));
      let bootstrapPassword: string;
      await t.test(
        'different simultaneous credentials create exactly one administrator',
        async () => {
          await Promise.all(initializers.map((app) => app.ready()));
          assert.equal((await store.accounts()).length, 1);
          const account = (await store.accountByUsername('ADMIN'))!;
          assert.equal(account.mustChangePassword, true);
          // Initializers above still race. Inspect their winner within the hash budget.
          const valid: boolean[] = [];
          for (const password of candidates)
            valid.push(await verifyPassword(password, account.passwordHash));
          assert.equal(valid.filter(Boolean).length, 1);
          bootstrapPassword = candidates[valid.indexOf(true)]!;
          assert.equal(
            await verifyPassword('admin', account.passwordHash),
            false,
          );
        },
      );
      const app = initializers[0]!;
      const login = (target: typeof app, username: string, password: string) =>
        target.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: { origin: env.PUBLIC_ORIGIN },
          payload: { username, password },
        });
      const permanentPassword = 'operator-chosen-permanent-password';
      await t.test(
        'explicit first login requires setup and revokes the bootstrap session',
        async () => {
          assert.equal((await login(app, 'admin', 'admin')).statusCode, 401);
          const signedIn = await login(app, 'admin', bootstrapPassword);
          assert.equal(signedIn.statusCode, 200, signedIn.body);
          assert.equal(signedIn.json().mustChangePassword, true);
          assert.equal(signedIn.body.includes(bootstrapPassword), false);
          const headers = {
            origin: env.PUBLIC_ORIGIN,
            cookie: String(signedIn.headers['set-cookie']).split(';')[0]!,
            'x-csrf-token': signedIn.json().csrfToken as string,
          };
          assert.equal(
            (await app.inject({ url: '/api/v1/admin/accounts', headers }))
              .statusCode,
            403,
          );
          const setup = await app.inject({
            method: 'PATCH',
            url: '/api/v1/auth/account',
            headers,
            payload: {
              currentPassword: bootstrapPassword,
              newPassword: permanentPassword,
              username: 'owner',
            },
          });
          assert.equal(setup.statusCode, 200, setup.body);
          assert.equal(setup.json().mustChangePassword, false);
          assert.equal(
            (await app.inject({ url: '/api/v1/auth/session', headers })).json()
              .authenticated,
            false,
          );
          const audit = await pool.query('SELECT * FROM staff_account_audit');
          assert.equal(
            JSON.stringify(audit.rows).includes(bootstrapPassword),
            false,
          );
        },
      );
      await t.test(
        'restart without a credential and restart with a new credential preserve completed setup',
        async () => {
          const existing = (await store.accountByUsername('owner'))!;
          const beforeSessions = (
            await pool.query('SELECT * FROM admin_sessions ORDER BY token_hash')
          ).rows;
          const withoutSecret = trackApp();
          const replacement = randomBytes(32).toString('hex');
          const withSecret = trackApp(replacement);
          await Promise.all([withoutSecret.ready(), withSecret.ready()]);
          assert.deepEqual(await store.accountById(existing.id), existing);
          assert.equal(await store.accountByUsername('admin'), null);
          assert.deepEqual(
            (
              await pool.query(
                'SELECT * FROM admin_sessions ORDER BY token_hash',
              )
            ).rows,
            beforeSessions,
          );
          assert.equal(
            (await login(withSecret, 'owner', bootstrapPassword)).statusCode,
            401,
          );
          assert.equal(
            (await login(withSecret, 'owner', replacement)).statusCode,
            401,
          );
          assert.equal(
            (await login(withoutSecret, 'owner', permanentPassword)).statusCode,
            200,
          );
          assert.equal((await store.accounts()).length, 1);
        },
      );
      await t.test(
        'the active-administrator constraint survives bootstrap and rejects disabling the owner',
        async () => {
          const existing = (await store.accountByUsername('owner'))!;
          await assert.rejects(
            pool.query(
              "UPDATE staff_accounts SET disabled=true WHERE role='admin'",
            ),
            { code: '23514' },
          );
          const restarted = trackApp(randomBytes(32).toString('hex'));
          await restarted.ready();
          assert.deepEqual(await store.accountById(existing.id), existing);
          assert.equal(
            (await login(restarted, 'owner', permanentPassword)).statusCode,
            200,
          );
        },
      );
    } finally {
      await Promise.all(apps.map((app) => app.close()));
      await pool.end();
      await root.query('DROP SCHEMA ' + schema + ' CASCADE');
      await root.end();
    }
  },
);
