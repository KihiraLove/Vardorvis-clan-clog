import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkDrain, OperationalDiagnostics } from '@clog/domain';
import { createApp } from './app.js';
import { ApiError } from './types.js';
test('HTTP close drains a known response and its asynchronous handler before closing resources', async () => {
  const work = new WorkDrain(),
    app = createApp(async () => {}, undefined, { logger: false, work });
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let resourcesClosed = false;
  app.addHook('onClose', async () => {
    await work.stop();
    resourcesClosed = true;
  });
  app.post('/receipt', async (_request, reply) => {
    entered();
    await pending;
    return reply.send({ receipt: 'known' });
  });
  const response = app.inject({ method: 'POST', url: '/receipt' });
  await started;
  const close = app.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resourcesClosed, false);
  assert.equal(work.snapshot().stopping, true);
  release();
  assert.deepEqual((await response).json(), { receipt: 'known' });
  await close;
  assert.equal(resourcesClosed, true);
  assert.equal(work.snapshot().active, 0);
});
test('API errors share safe categories and generated request IDs without logging payloads or untrusted IDs', async () => {
  const records: Record<string, unknown>[] = [],
    diagnostics = new OperationalDiagnostics('api', (r) => records.push(r));
  const app = createApp(async () => {}, undefined, {
    logger: false,
    diagnostics,
  });
  app.get('/db', async () => {
    throw Object.assign(new Error('postgresql://password SQL proof secret'), {
      code: '08006',
      parameters: ['private'],
    });
  });
  app.get('/business', async () => {
    throw new ApiError(409, 'Changed.');
  });
  try {
    const db = await app.inject({
      url: '/db?token=secret',
      headers: { 'x-request-id': 'password-secret', cookie: 'private' },
    });
    assert.equal(db.statusCode, 503);
    assert.equal(db.headers['x-error-category'], 'database');
    assert.match(String(db.headers['x-request-id']), /^[a-f\d-]{36}$/u);
    assert.equal(
      records.find((r) => r.event === 'failure')!.correlation,
      db.headers['x-request-id'],
    );
    assert.equal(
      (await app.inject('/business')).headers['x-error-category'],
      'conflict',
    );
    assert.doesNotMatch(
      JSON.stringify(records),
      /password|secret|postgresql|private|parameters/iu,
    );
  } finally {
    await app.close();
  }
});

test('a disconnected HTTP client cannot make an active handler disappear from shutdown accounting', async () => {
  const work = new WorkDrain(),
    app = createApp(async () => {}, undefined, { logger: false, work });
  let started!: () => void,
    finish!: () => void,
    closed = false;
  const entered = new Promise<void>((resolve) => {
      started = resolve;
    }),
    pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
  app.addHook('onClose', async () => {
    await work.stop();
    closed = true;
  });
  app.get('/pending', async () => {
    started();
    await pending;
    return { receipt: 'committed' };
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const controller = new AbortController(),
    response = fetch('http://127.0.0.1:' + address.port + '/pending', {
      signal: controller.signal,
    }).catch(() => undefined);
  await entered;
  controller.abort();
  await response;
  const closing = app.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  assert.ok(work.snapshot().active > 0);
  finish();
  await closing;
  assert.equal(closed, true);
  assert.equal(work.snapshot().active, 0);
});
