import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  generateClanKey,
  loadClanKeyRoot,
  validClanKey,
  PgClanKeyStore,
  requireClanKey,
  suppliedClanKey,
} from './clan-api-key.js';

test('generated clan keys are 32-character hex values; custom keys accept any 8 or more Unicode characters', () => {
  const keys = Array.from({ length: 100 }, generateClanKey);
  assert.equal(new Set(keys).size, 100);
  assert.ok(
    keys.every((key) => /^[a-f0-9]{32}$/u.test(key) && validClanKey(key)),
  );
  for (const key of [
    '12345678',
    'a'.repeat(500),
    'eight!?!',
    ' spaces ',
    'line\nbreak',
    '😀'.repeat(8),
    '\u0000'.repeat(8),
  ])
    assert.equal(validClanKey(key), true);
  for (const key of [
    '',
    ' ',
    '\u0000',
    'a'.repeat(7),
    '😀'.repeat(7),
    '\ud800'.repeat(8),
    null,
    42,
  ])
    assert.equal(validClanKey(key), false);
});

test(
  'concurrent startup creates one key and preserves valid custom keys without resetting credentials',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const connectionString = process.env.TEST_DATABASE_URL!;
    const root = new pg.Pool({ connectionString });
    const schema = 'key_setup_' + randomUUID().replaceAll('-', '');
    await root.query('CREATE SCHEMA ' + schema);
    const pool = new pg.Pool({
      connectionString,
      options: '-c search_path=' + schema,
    });
    try {
      const directory = new URL(
        '../../../packages/database/migrations/',
        import.meta.url,
      );
      for (const name of (await readdir(directory))
        .filter((name) => name.endsWith('.sql'))
        .sort())
        await pool.query(await readFile(new URL(name, directory), 'utf8'));
      const secret = Buffer.alloc(32, 7);
      const store = new PgClanKeyStore(pool, secret);
      await Promise.all(Array.from({ length: 8 }, () => store.ensureDefault()));
      const saved = await store.settings();
      assert.equal(saved.enabled, true);
      assert.equal(saved.revision, 'clan-key-1');
      assert.match(saved.key, /^[a-f0-9]{32}$/u);
      assert.equal(
        (await pool.query('SELECT count(*)::int AS n FROM clan_api_key_audit'))
          .rows[0].n,
        0,
      );
      await new PgClanKeyStore(pool, secret).ensureDefault();
      assert.deepEqual(await store.settings(), saved);
      await assert.rejects(
        new PgClanKeyStore(pool, Buffer.alloc(32, 9)).ensureDefault(),
        { status: 503 },
      );
      assert.deepEqual(await store.settings(), saved);
      const enabled = await store.update(
        { expectedRevision: saved.revision, enabled: true },
        'owner',
      );
      assert.equal(enabled.key, saved.key);
      await requireClanKey(pool, saved.key);
      await assert.rejects(requireClanKey(pool, 'invalid-key'), {
        status: 401,
      });
      for (const invalid of ['a'.repeat(7), '😀'.repeat(7), '\ud800'.repeat(8)])
        await assert.rejects(
          store.update(
            { expectedRevision: enabled.revision, key: invalid },
            'owner',
          ),
          { status: 422 },
        );
      let current = enabled;
      for (const custom of [
        'custom:! key /',
        'eight!!!',
        ' 符号\n😀 key \u0000 ',
        'a'.repeat(500),
      ]) {
        current = await store.update(
          { expectedRevision: current.revision, key: custom },
          'owner',
        );
        await Promise.all(
          Array.from({ length: 8 }, () =>
            new PgClanKeyStore(pool, secret).ensureDefault(),
          ),
        );
        assert.deepEqual(await store.settings(), current);
        await requireClanKey(pool, custom);
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM clan_api_key_audit WHERE actor_id LIKE 'system:%'",
            )
          ).rows[0].n,
          0,
        );
      }
    } finally {
      await pool.end();
      await root.query('DROP SCHEMA ' + schema + ' CASCADE');
      await root.end();
    }
  },
);

test('encoded key headers preserve arbitrary UTF-8 and reject ambiguous or malformed credentials', () => {
  for (const key of [
    'eight!!!',
    '  spaces  ',
    '符号 😀\n\u0000 key',
    '\uFEFFbom key!!',
  ])
    assert.equal(
      suppliedClanKey({
        'x-clan-api-key-base64': Buffer.from(key).toString('base64url'),
      }),
      key,
    );
  assert.equal(suppliedClanKey({ 'x-clan-api-key': 'plain-key' }), 'plain-key');
  for (const headers of [
    { 'x-clan-api-key-base64': '%%%wrong' },
    { 'x-clan-api-key-base64': Buffer.from([255]).toString('base64url') },
    { 'x-clan-api-key-base64': 'ZWlnaHQhISE=' },
    { 'x-clan-api-key': 'plain-key', 'x-clan-api-key-base64': 'ZWlnaHQhISE' },
    { 'x-clan-api-key-base64': ['one', 'two'] },
  ])
    assert.equal(suppliedClanKey(headers), undefined);
});
test('the encryption root is durable, atomically created under concurrent starts and rejects corruption', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clog-clan-key-'));
  try {
    const roots = await Promise.all(
      Array.from({ length: 16 }, () => loadClanKeyRoot(directory)),
    );
    assert.equal(roots[0]!.length, 32);
    for (const root of roots) assert.deepEqual(root, roots[0]);
    assert.deepEqual(await loadClanKeyRoot(directory), roots[0]);
    assert.deepEqual(await readdir(directory), ['.clan-api-key.secret']);
    assert.deepEqual(
      await readFile(join(directory, '.clan-api-key.secret')),
      roots[0],
    );
    await writeFile(join(directory, '.clan-api-key.secret'), Buffer.alloc(0));
    await assert.rejects(loadClanKeyRoot(directory), /invalid/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
