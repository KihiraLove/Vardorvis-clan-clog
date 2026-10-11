/** Fastify injection tests exercise health/readiness without opening a network socket. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from './app.js';

test('liveness and readiness are separate; unavailable database returns 503', async () => {
  const app = createApp();
  try {
    assert.equal((await app.inject('/healthz')).statusCode, 200);
    assert.equal((await app.inject('/readyz')).statusCode, 503);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/submissions',
          payload: {},
        })
      ).statusCode,
      404,
    );
  } finally {
    await app.close();
  }
});
test('configured database check can report ready', async () => {
  const app = createApp(async () => {});
  try {
    assert.equal((await app.inject('/readyz')).statusCode, 200);
  } finally {
    await app.close();
  }
});

test('public settings are disabled by default, expose only visibility, and fail closed on database failure', async () => {
  const app = createApp();
  assert.deepEqual((await app.inject('/api/v1/settings')).json(), {
    revision: 'settings-disabled',
    clanName: 'Vardorvis',
    hardcoreEnabled: false,
  });
  await app.close();
  const failed = createApp(
    async () => {},
    async () => {
      throw new Error('DB unavailable');
    },
  );
  assert.equal((await failed.inject('/api/v1/settings')).statusCode, 503);
  await failed.close();
});
