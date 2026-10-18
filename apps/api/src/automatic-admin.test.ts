import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import { migrate } from '@clog/database/dist/migrate.js';
import {
  prepareAdministrator,
  printAdministrator,
  provisionAdministrator,
} from './automatic-admin.js';
import { hashPassword, verifyPassword } from './passwords.js';

test('pending first-login credential survives retries and only explicit first setup creates it', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'clog-first-login-')),
    file = join(directory, 'administrator.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.equal(prepareAdministrator(file, false, {}), undefined);
  const password = prepareAdministrator(file, true, {})!;
  assert.match(password, /^[a-f0-9]{64}$/u);
  assert.equal(
    prepareAdministrator(file, true, {
      ADMIN_BOOTSTRAP_PASSWORD: 'a'.repeat(64),
    }),
    password,
  );
  assert.equal(prepareAdministrator(file, false, {}), password);
  const lines: string[] = [];
  printAdministrator(password, (line) => lines.push(line));
  assert.match(lines.join('\n'), /FIRST LOGIN[\s\S]*Username: admin/u);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).password, password);
  writeFileSync(file, '{"password":"invalid"}');
  assert.throws(() => prepareAdministrator(file, false, {}));
});

test(
  'automatic provisioning recovers pending setup and never resets a renamed permanent administrator',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'clog-admin-db-')),
      file = join(directory, 'administrator.json');
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const url = new URL(process.env.TEST_DATABASE_URL!),
      schema = 'auto_admin_' + randomUUID().replaceAll('-', '');
    const owner = new pg.Pool({ connectionString: url.toString() });
    await owner.query('CREATE SCHEMA ' + schema);
    url.searchParams.set('options', '-c search_path=' + schema);
    const pool = new pg.Pool({ connectionString: url.toString() });
    try {
      await migrate(url.toString());
      const password = prepareAdministrator(file, true, {})!;
      assert.equal(await provisionAdministrator(pool, file), password);
      assert.equal(await provisionAdministrator(pool, file), password);
      const original = (await pool.query('SELECT * FROM staff_accounts'))
        .rows[0];
      assert.equal(
        await verifyPassword(password, original.password_hash),
        true,
      );
      writeFileSync(file, JSON.stringify({ password: 'a'.repeat(64) }));
      await assert.rejects(
        provisionAdministrator(pool, file),
        /does not match/u,
      );
      assert.equal(
        (await pool.query('SELECT count(*)::int AS n FROM staff_accounts'))
          .rows[0].n,
        1,
      );
      const permanent = await hashPassword('permanent administrator password');
      await pool.query(
        "UPDATE staff_accounts SET username='owner',password_hash=$1,must_change_password=false",
        [permanent],
      );
      // Even damaged leftover pending state must not prevent an already configured login.
      writeFileSync(file, 'invalid stale pending state');
      assert.equal(await provisionAdministrator(pool, file), undefined);
      assert.equal(existsSync(file), false);
      assert.equal(
        (
          await pool.query(
            "SELECT password_hash FROM staff_accounts WHERE username='owner'",
          )
        ).rows[0].password_hash,
        permanent,
      );
    } finally {
      await pool.end();
      await owner.query('DROP SCHEMA ' + schema + ' CASCADE');
      await owner.end();
    }
  },
);
