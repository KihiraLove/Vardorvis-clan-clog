import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateClanKey,
  loadClanKeyRoot,
  validClanKey,
} from './clan-api-key.js';

test('default clan keys are random and custom keys support printable text with bounded header-safe values', () => {
  const keys = Array.from({ length: 100 }, generateClanKey);
  assert.equal(new Set(keys).size, 100);
  assert.ok(
    keys.every((key) => /^[A-Za-z0-9_-]{43}$/u.test(key) && validClanKey(key)),
  );
  for (const key of ['a', 'a shared clan key', 'x'.repeat(256)])
    assert.equal(validClanKey(key), true);
  for (const key of [
    '',
    ' ',
    ' leading',
    'trailing ',
    'line\nbreak',
    '\u0000',
    'x'.repeat(257),
    null,
    42,
  ])
    assert.equal(validClanKey(key), false);
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
