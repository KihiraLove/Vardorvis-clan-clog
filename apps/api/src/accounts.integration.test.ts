/** Disposable PostgreSQL checks for credential transactions, uniqueness and session races. */
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { createApp } from './app.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { PgStore } from './store.js';

test(
  'PostgreSQL accounts seed once, enforce concurrent uniqueness and update credentials/audits/sessions atomically',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const connectionString = process.env.TEST_DATABASE_URL!;
    const schema = 'account_test_' + randomUUID().replaceAll('-', '');
    const root = new pg.Pool({ connectionString });
    await root.query('CREATE SCHEMA ' + schema);
    const pool = new pg.Pool({
      connectionString,
      options: '-c search_path=' + schema,
      max: 8,
    });
    const store = new PgStore(pool);
    const auth = {
      origin: 'https://clog.example.com',
      secret: 'a'.repeat(64),
      secure: true,
    };
    const app = createApp(undefined, undefined, { store, auth, logger: false });
    try {
      const migrations = new URL(
        '../../../packages/database/migrations/',
        import.meta.url,
      );
      for (const file of (await readdir(migrations))
        .filter((file) => /^\d+_.+\.sql$/u.test(file))
        .sort())
        await pool.query(await readFile(new URL(file, migrations), 'utf8'));
      const bootstrapPassword = 'b'.repeat(64);
      const originalHash = await hashPassword(bootstrapPassword);
      await Promise.all(
        Array.from({ length: 8 }, () => store.ensureDefaultAdmin(originalHash)),
      );
      assert.equal((await store.accounts()).length, 1);
      const initial = (await store.accountByUsername('ADMIN'))!;
      assert.equal(initial.mustChangePassword, true);
      assert.equal(
        await verifyPassword(bootstrapPassword, initial.passwordHash),
        true,
      );
      // First-login setup through real HTTP routes rotates the cookie and unlocks tools.
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { origin: auth.origin },
        payload: { username: 'admin', password: bootstrapPassword },
      });
      assert.equal(login.statusCode, 200, login.body);
      const headers = {
        cookie: String(login.headers['set-cookie']).split(';')[0]!,
        origin: auth.origin,
        'x-csrf-token': login.json().csrfToken as string,
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
          newPassword: 'new-owner-password',
          username: 'owner',
        },
      });
      assert.equal(setup.statusCode, 200, setup.body);
      assert.equal(
        (await app.inject({ url: '/api/v1/auth/session', headers })).json()
          .authenticated,
        false,
      );
      const owner = (await store.accountByUsername('owner'))!;
      await store.ensureDefaultAdmin(await hashPassword('c'.repeat(64)));
      assert.equal(await store.accountByUsername('admin'), null);
      assert.equal(
        (await store.accountById(owner.id))!.passwordHash,
        owner.passwordHash,
      );
      const moderatorHash = await hashPassword('moderator-password');
      const creations = await Promise.allSettled([
        store.createModerator('reviewer', moderatorHash, owner.id),
        store.createModerator('REVIEWER', moderatorHash, owner.id),
      ]);
      assert.equal(
        creations.filter((result) => result.status === 'fulfilled').length,
        1,
      );
      assert.equal(
        creations.filter(
          (result) =>
            result.status === 'rejected' && result.reason.status === 409,
        ).length,
        1,
      );
      const mod = (await store.accountByUsername('reviewer'))!;
      assert.equal(mod.role, 'moderator');
      assert.equal(mod.mustChangePassword, true);
      const identity = {
        id: mod.id,
        displayName: mod.username,
        accountVersion: mod.credentialVersion,
      };
      await store.createSession(
        '1'.repeat(64),
        identity,
        new Date(Date.now() + 60000),
      );
      const changes = await Promise.allSettled([
        store.updateAccount(
          mod.id,
          mod.credentialVersion,
          'reviewer-one',
          moderatorHash,
        ),
        store.updateAccount(
          mod.id,
          mod.credentialVersion,
          'reviewer-two',
          moderatorHash,
        ),
      ]);
      assert.equal(
        changes.filter((result) => result.status === 'fulfilled').length,
        1,
      );
      assert.equal(
        changes.filter(
          (result) =>
            result.status === 'rejected' && result.reason.status === 409,
        ).length,
        1,
      );
      assert.equal(await store.session('1'.repeat(64)), null);
      const saved = (await store.accountById(mod.id))!;
      assert.equal(saved.credentialVersion, 2);
      assert.equal(saved.mustChangePassword, false);
      assert.equal(saved.role, 'moderator');
      await store.createSession(
        '2'.repeat(64),
        {
          id: saved.id,
          displayName: saved.username,
          accountVersion: saved.credentialVersion,
        },
        new Date(Date.now() + 60000),
      );
      await assert.rejects(
        store.updateAccount(
          saved.id,
          saved.credentialVersion,
          'OWNER',
          originalHash,
        ),
        { status: 409 },
      );
      assert.deepEqual(await store.accountById(saved.id), saved);
      assert.ok(await store.session('2'.repeat(64)));
      // A failing append-only audit must roll back both the credential and session deletion.
      await pool.query(
        `CREATE FUNCTION fail_account_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Fixture audit failure'; END $$`,
      );
      await pool.query(
        'CREATE TRIGGER fail_account_audit BEFORE INSERT ON staff_account_audit FOR EACH ROW EXECUTE FUNCTION fail_account_audit()',
      );
      await assert.rejects(
        store.updateAccount(
          saved.id,
          saved.credentialVersion,
          'rolled-back',
          originalHash,
        ),
      );
      await assert.rejects(
        store.createModerator('rolled-back', originalHash, owner.id),
      );
      assert.deepEqual(await store.accountById(saved.id), saved);
      assert.ok(await store.session('2'.repeat(64)));
      assert.equal(await store.accountByUsername('rolled-back'), null);
      await pool.query(
        'DROP TRIGGER fail_account_audit ON staff_account_audit',
      );
      // A login that finishes after a password update cannot reauthorize an old verifier.
      const token = 'x'.repeat(43);
      const tokenHash = createHmac('sha256', auth.secret)
        .update('session:' + token)
        .digest('hex');
      await store.createSession(
        tokenHash,
        identity,
        new Date(Date.now() + 60000),
      );
      assert.equal(
        (
          await app.inject({
            url: '/api/v1/auth/session',
            headers: { cookie: '__Host-clog-session=' + token },
          })
        ).json().authenticated,
        false,
      );
      const audit = await pool.query(
        'SELECT actor_id, account_id, action, username FROM staff_account_audit ORDER BY id',
      );
      assert.equal(audit.rows.length, 3);
      assert.equal(audit.rows[1].actor_id, owner.id);
      assert.equal(audit.rows[2].actor_id, mod.id);
      assert.equal(
        JSON.stringify(await store.accounts()).includes('passwordHash'),
        false,
      );
      // The single-admin invariant is also a database constraint.
      await assert.rejects(
        pool.query(
          "INSERT INTO staff_accounts(id,username,role,password_hash) VALUES($1,'extra-owner','admin',$2)",
          [randomUUID(), originalHash],
        ),
        { code: '23505' },
      );
    } finally {
      await app.close();
      await pool.end();
      await root.query('DROP SCHEMA ' + schema + ' CASCADE');
      await root.end();
    }
  },
);
