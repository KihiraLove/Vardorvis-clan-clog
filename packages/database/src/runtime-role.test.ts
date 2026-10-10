import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtimeRole, validateRuntimePassword } from './runtime-role.js';

test('runtime database role uses a separate strict secret', () => {
  assert.equal(runtimeRole, 'clog_runtime');
  assert.equal(validateRuntimePassword('a'.repeat(64)), 'a'.repeat(64));
  for (const invalid of [
    undefined,
    '',
    'test',
    'z'.repeat(64),
    'a'.repeat(63),
    "a'.repeat(33)",
  ])
    assert.throws(() => validateRuntimePassword(invalid), /APP_DB_PASSWORD/);
});
