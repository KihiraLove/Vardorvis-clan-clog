import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashPassword, verifyPassword } from './passwords.js';

test('passwords use independent salts, reject wrong credentials and malformed verifiers', async () => {
  const password = 'test-password-only';
  const [first, second] = await Promise.all([
    hashPassword(password),
    hashPassword(password),
  ]);
  assert.notEqual(first, second);
  assert.equal(first.includes(password), false);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword(password, second), true);
  assert.equal(await verifyPassword('wrong', first), false);
  assert.equal(await verifyPassword(password, 'plaintext'), false);
  assert.equal(
    await verifyPassword(password, first.replace('$32768$', '$1$')),
    false,
  );
  const unicode = '秘密🌲 very long ' + 'x'.repeat(220);
  assert.equal(
    await verifyPassword(unicode, await hashPassword(unicode)),
    true,
  );
});
