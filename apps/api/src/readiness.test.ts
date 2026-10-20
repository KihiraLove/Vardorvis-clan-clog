import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from './app.js';
import { checkReadiness, readBotConnectionState } from './readiness.js';
import type { DiscordConnectionState } from '@clog/domain';
test('website readiness survives Discord outages while dedicated intake health fails and recovers independently', async () => {
  let connected = true,
    intake = true,
    database = true;
  const app = createApp(
    async () => {
      if (!database) throw Error('Database unavailable');
    },
    undefined,
    {
      logger: false,
      readBotConnectionState: async () =>
        !connected ? 'disconnected' : intake ? 'connected' : 'unavailable',
    },
  );
  try {
    assert.equal((await app.inject('/readyz')).statusCode, 200);
    assert.equal((await app.inject('/api/v1/discord/status')).statusCode, 200);
    connected = false;
    assert.equal((await app.inject('/readyz')).statusCode, 200);
    assert.equal((await app.inject('/api/v1/discord/status')).statusCode, 503);
    assert.equal((await app.inject('/healthz')).statusCode, 200);
    connected = true;
    intake = false;
    assert.equal((await app.inject('/readyz')).statusCode, 200);
    assert.equal((await app.inject('/api/v1/discord/status')).statusCode, 503);
    intake = true;
    assert.equal((await app.inject('/readyz')).statusCode, 200);
    assert.equal((await app.inject('/api/v1/discord/status')).statusCode, 200);
    database = false;
    assert.equal((await app.inject('/readyz')).statusCode, 503);
    assert.equal((await app.inject('/healthz')).statusCode, 200);
    database = true;
    assert.equal((await app.inject('/readyz')).statusCode, 200);
  } finally {
    await app.close();
  }
});
test('disabled bot needs no probe and stalled dependencies have bounded readiness', async () => {
  const app = createApp(async () => {}, undefined, { logger: false });
  try {
    assert.deepEqual((await app.inject('/api/v1/discord/status')).json(), {
      enabled: false,
      ready: false,
      state: 'disabled',
    });
  } finally {
    await app.close();
  }
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
test('Discord status reports real connection phases without changing website readiness or exposing diagnostics', async () => {
  let state: Exclude<DiscordConnectionState, 'disabled'> = 'connecting';
  let enabled = true,
    fail = false,
    probes = 0;
  const app = createApp(async () => {}, undefined, {
    logger: false,
    botConfiguration: async () =>
      enabled
        ? { token: 'private-token', guildId: '123456789012345678' }
        : undefined,
    readBotConnectionState: async () => {
      probes++;
      if (fail) throw Error('private diagnostics');
      return state;
    },
  });
  try {
    for (const next of [
      'connecting',
      'connected',
      'disconnected',
      'unavailable',
      'connected',
    ] as const) {
      state = next;
      const response = await app.inject('/api/v1/discord/status');
      assert.equal(response.statusCode, next === 'connected' ? 200 : 503);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.deepEqual(response.json(), {
        enabled: true,
        ready: next === 'connected',
        state: next,
      });
      assert.equal((await app.inject('/readyz')).statusCode, 200);
    }
    fail = true;
    assert.deepEqual((await app.inject('/api/v1/discord/status')).json(), {
      enabled: true,
      ready: false,
      state: 'unavailable',
    });
    const before = probes;
    enabled = false;
    assert.deepEqual((await app.inject('/api/v1/discord/status')).json(), {
      enabled: false,
      ready: false,
      state: 'disabled',
    });
    assert.equal(probes, before);
  } finally {
    await app.close();
  }
});

test('the internal status probe validates readiness, separates gateway/intake outages and bounds transport', async (t) => {
  let body: unknown = {},
    status = 503,
    failure = false;
  t.mock.method(
    globalThis,
    'fetch',
    async (url: string, options: RequestInit) => {
      assert.equal(url, 'http://127.0.0.1:3001/readyz');
      assert.equal(options.redirect, 'error');
      assert.equal(options.cache, 'no-store');
      assert.ok(options.signal instanceof AbortSignal);
      if (failure) throw Error('offline');
      return Response.json(body, { status });
    },
  );
  for (const connectionState of [
    'connecting',
    'disconnected',
    'connected',
  ] as const) {
    const ready = connectionState === 'connected';
    status = ready ? 200 : 503;
    body = {
      status: ready ? 'ready' : 'not-ready',
      discordConfigured: true,
      discordConnected: ready,
      apiConnected: ready,
      connectionState,
      token: 'must not be returned',
    };
    assert.equal(await readBotConnectionState(), connectionState);
  }
  for (const invalid of [
    null,
    [],
    {},
    {
      status: 'ready',
      discordConfigured: true,
      discordConnected: false,
      apiConnected: true,
      connectionState: 'connected',
    },
    {
      status: 'not-ready',
      discordConfigured: true,
      discordConnected: true,
      apiConnected: false,
      connectionState: 'connected',
    },
    {
      status: 'not-ready',
      discordConfigured: false,
      discordConnected: false,
      apiConnected: false,
      connectionState: 'disabled',
    },
  ]) {
    body = invalid;
    status = 503;
    if (invalid === null || Array.isArray(invalid))
      await assert.rejects(readBotConnectionState());
    else assert.equal(await readBotConnectionState(), 'unavailable');
  }
  body = {};
  status = 401;
  await assert.rejects(readBotConnectionState());
  failure = true;
  await assert.rejects(readBotConnectionState());
});
