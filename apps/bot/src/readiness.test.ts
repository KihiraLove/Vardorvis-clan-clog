import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cachedReadiness } from './readiness.js';

test('real API readiness probes share an in-flight request and cache bounded results', async () => {
  let time = 1000;
  let calls = 0;
  let ok = true;
  const ready = cachedReadiness(async () => {
    calls++;
    return ok;
  }, 5000, () => time);
  assert.deepEqual(await Promise.all([ready(), ready()]), [true, true]);
  assert.equal(calls, 1);
  ok = false;
  time += 4999;
  assert.equal(await ready(), true);
  assert.equal(calls, 1);
  time += 1;
  assert.equal(await ready(), false);
  assert.equal(calls, 2);
});

test('API readiness probe fails closed on connection errors', async () => {
  let time = 0;
  const ready = cachedReadiness(async () => {
    if (time === 0) throw Error('connection refused');
    return true;
  }, 5000, () => time);
  assert.equal(await ready(), false);
  time = 5000;
  assert.equal(await ready(), true);
});
