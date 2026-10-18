import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSecret } from './server-secrets.js';

test('secret inputs accept explicit values or bounded regular files without changing the environment', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'clog-secret-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'key');
  writeFileSync(file, 'a'.repeat(64) + '\r\n');
  const env = { SESSION_SECRET_FILE: file };
  assert.equal(readSecret('SESSION_SECRET', env), 'a'.repeat(64));
  assert.deepEqual(env, { SESSION_SECRET_FILE: file });
  assert.equal(
    readSecret('SESSION_SECRET', { SESSION_SECRET: 'value' }),
    'value',
  );
  assert.equal(readSecret('SESSION_SECRET', {}), undefined);
  assert.throws(
    () =>
      readSecret('SESSION_SECRET', {
        ...env,
        SESSION_SECRET: 'never-print-this',
      }),
    /Set only SESSION_SECRET or SESSION_SECRET_FILE/u,
  );
  for (const contents of ['', 'one\ntwo', 'x'.repeat(65537), 'a\0b']) {
    writeFileSync(file, contents);
    assert.throws(() => readSecret('SESSION_SECRET', env), {
      message: 'Cannot read a valid SESSION_SECRET_FILE',
    });
  }
  assert.throws(
    () => readSecret('SESSION_SECRET', { SESSION_SECRET_FILE: 'relative' }),
    /must be absolute/u,
  );
  mkdirSync(join(directory, 'directory'));
  assert.throws(() =>
    readSecret('SESSION_SECRET', {
      SESSION_SECRET_FILE: join(directory, 'directory'),
    }),
  );
  if (process.platform !== 'win32') {
    symlinkSync(file, join(directory, 'link'));
    assert.throws(() =>
      readSecret('SESSION_SECRET', {
        SESSION_SECRET_FILE: join(directory, 'link'),
      }),
    );
  }
});
