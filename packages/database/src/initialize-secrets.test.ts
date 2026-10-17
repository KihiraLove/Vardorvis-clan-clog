import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSecrets } from './initialize-secrets.js';
import { databaseUrl } from './secrets.js';
import { rotateSecret } from './rotate-secret.js';

test('initialization preserves independent secrets and refuses drift, loss and implicit adoption of existing data', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'clog-install-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'secrets'),
    db = join(directory, 'db');
  mkdirSync(db);
  initializeSecrets(root, db, {});
  const value = (kind: string) =>
    readFileSync(join(root, kind, 'value'), 'utf8');
  const before = ['postgres', 'app', 'session'].map(value);
  assert.equal(new Set(before).size, 3);
  assert.ok(before.every((v) => /^[a-f0-9]{64}\n$/u.test(v)));
  writeFileSync(join(db, 'PG_VERSION'), '17');
  initializeSecrets(root, db, {});
  assert.deepEqual(['postgres', 'app', 'session'].map(value), before);
  assert.throws(
    () => initializeSecrets(root, db, { APP_DB_PASSWORD: 'b'.repeat(64) }),
    /differs from the installed/u,
  );
  unlinkSync(join(root, 'app', 'value'));
  assert.throws(() => initializeSecrets(root, db, {}), /is missing/u);
  assert.throws(
    () => initializeSecrets(join(directory, 'new'), db, {}),
    /Existing database needs explicit/u,
  );
  const adopted = join(directory, 'adopted');
  const env = {
    POSTGRES_PASSWORD: 'a'.repeat(64),
    APP_DB_PASSWORD: 'b'.repeat(64),
    SESSION_SECRET: 'c'.repeat(64),
  };
  initializeSecrets(adopted, db, env, true);
  assert.equal(
    readFileSync(join(adopted, 'postgres', 'value'), 'utf8').trim(),
    env.POSTGRES_PASSWORD,
  );
});

test('database configuration reads secret files, encodes passwords and rejects malformed public settings', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'clog-db-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'password');
  writeFileSync(file, 'p@ss:word\n');
  const url = new URL(
    databaseUrl({ APP_DB_PASSWORD_FILE: file, DB_HOST: 'db' }, 'runtime'),
  );
  assert.equal(url.username, 'clog_runtime');
  assert.equal(decodeURIComponent(url.password), 'p@ss:word');
  assert.equal(url.hostname, 'db');
  assert.equal(databaseUrl({}, 'runtime', false), undefined);
  assert.throws(
    () => databaseUrl({ POSTGRES_PASSWORD: 'value', DB_PORT: '0' }),
    /DB_PORT/u,
  );
  assert.throws(() => databaseUrl({ DATABASE_URL: 'secret-not-a-url' }), {
    message: 'DATABASE_URL must be a PostgreSQL connection URL',
  });
});

test('pending session rotation blocks startup and resumes with the same staged key', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'clog-rotation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'secrets'),
    db = join(directory, 'db');
  mkdirSync(db);
  initializeSecrets(root, db, {});
  const postgres = readFileSync(join(root, 'postgres', 'value'), 'utf8');
  const previous = readFileSync(join(root, 'session', 'value'), 'utf8').trim();
  writeFileSync(
    join(root, 'postgres', 'rotation.json'),
    JSON.stringify({ kind: 'session', previous, next: 'e'.repeat(64) }),
  );
  assert.throws(
    () => initializeSecrets(root, db, {}),
    /rotation is incomplete/u,
  );
  await assert.rejects(rotateSecret(root, 'session', false, {}), /pending/u);
  await rotateSecret(root, 'session', true, {});
  initializeSecrets(root, db, {});
  assert.equal(
    readFileSync(join(root, 'session', 'value'), 'utf8').trim(),
    'e'.repeat(64),
  );
  assert.equal(readFileSync(join(root, 'postgres', 'value'), 'utf8'), postgres);
});
