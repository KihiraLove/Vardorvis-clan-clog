import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from './app.js';
import { checkReadiness, checkBotReadiness } from './readiness.js';
test('readiness includes enabled gateway/intake and recovers without a process restart', async () => {
  let connected = true,
    intake = true;
  const app = createApp(async () => {}, undefined, {
    logger: false,
    checkBotReady: async () => {
      if (!connected || !intake) throw new Error('Unavailable');
    },
  });
  try {
    assert.equal((await app.inject('/readyz')).statusCode, 200);
    connected = false;
    assert.equal((await app.inject('/readyz')).statusCode, 503);
    assert.equal((await app.inject('/healthz')).statusCode, 200);
    connected = true;
    intake = false;
    assert.equal((await app.inject('/readyz')).statusCode, 503);
    intake = true;
    assert.equal((await app.inject('/readyz')).statusCode, 200);
  } finally {
    await app.close();
  }
});
test('disabled bot needs no probe and stalled dependencies have bounded readiness', async () => {
  await checkReadiness(async () => {});
  await assert.rejects(
    checkReadiness(
      async () => {},
      () => new Promise(() => {}),
      10,
    ),
    /timed out/,
  );
  await assert.rejects(
    checkReadiness(() => new Promise(() => {}), undefined, 10),
    /timed out/,
  );
});
test('bot readiness probes the internal readiness endpoint and fails closed', async (t) => {
  let status = 503;
  t.mock.method(
    globalThis,
    'fetch',
    async (url: string, options: RequestInit) => {
      assert.equal(url, 'http://127.0.0.1:3001/readyz');
      assert.ok(options.signal instanceof AbortSignal);
      return new Response('{}', { status });
    },
  );
  await assert.rejects(checkBotReadiness());
  status = 200;
  await checkBotReadiness();
});
