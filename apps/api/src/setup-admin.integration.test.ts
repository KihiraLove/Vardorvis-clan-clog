import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { migrate } from '@clog/database/dist/migrate.js';
import { setupAdministrator } from './setup-admin.js';
import { verifyPassword } from './passwords.js';
import { PgStore } from './store.js';
import { createApp } from './app.js';
import { readConfig } from './config.js';

test(
  'explicit administrator setup serializes competing commands and never resets renamed administrators',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    const schema = 'local_admin_' + randomUUID().replaceAll('-', '');
    const owner = new pg.Pool({ connectionString: url.toString() });
    await owner.query('CREATE SCHEMA ' + schema);
    url.searchParams.set('options', '-c search_path=' + schema);
    const pool = new pg.Pool({ connectionString: url.toString() });
    t.after(async () => {
      await pool.end();
      await owner.query('DROP SCHEMA ' + schema + ' CASCADE');
      await owner.end();
    });
    await migrate(url.toString());
    const candidates = ['a'.repeat(64), 'b'.repeat(64)];
    const results = await Promise.allSettled(
      candidates.map((password) => setupAdministrator(pool, password)),
    );
    assert.equal(
      results.filter((value) => value.status === 'fulfilled').length,
      1,
    );
    const store = new PgStore(pool);
    const account = (await store.accountByUsername('admin'))!;
    const winner =
      candidates[results.findIndex((value) => value.status === 'fulfilled')]!;
    assert.equal(await verifyPassword(winner, account.passwordHash), true);
    assert.equal(account.mustChangePassword, true);
    const app = createApp(undefined, undefined, {
      store,
      logger: false,
      ...readConfig({
        AUTH_ENABLED: 'true',
        PUBLIC_ORIGIN: 'https://clog.example.com',
        SESSION_SECRET: 'c'.repeat(64),
      }),
    });
    await app.ready();
    t.after(() => app.close());
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'https://clog.example.com' },
      payload: { username: 'admin', password: winner },
    });
    assert.equal(login.statusCode, 200);
    assert.equal(login.json().mustChangePassword, true);
    await pool.query(
      "UPDATE staff_accounts SET username='renamed-owner' WHERE role='admin'",
    );
    await assert.rejects(
      pool.query("UPDATE staff_accounts SET disabled=true WHERE role='admin'"),
      { code: '23514' },
    );
    await assert.rejects(
      setupAdministrator(pool, 'd'.repeat(64)),
      /already exists/u,
    );
    const saved = (await store.accountByUsername('renamed-owner'))!;
    assert.equal(saved.passwordHash, account.passwordHash);
    assert.equal((await store.accounts()).length, 1);
  },
);
