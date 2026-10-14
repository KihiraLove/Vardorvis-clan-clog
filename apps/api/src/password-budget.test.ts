import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkloadError } from '@clog/domain';
import { PasswordHasher } from './passwords.js';
const tick = () => new Promise((resolve) => setImmediate(resolve));
test('hashing bounds active/queued jobs, rejects many callers, preserves FIFO and recovers', async () => {
  const waiting: ((value: Buffer) => void)[] = [];
  const seen: string[] = [];
  const hasher = new PasswordHasher(
    { concurrent: 2, queued: 4, waitMs: 1000 },
    async (password) => {
      seen.push(password);
      return new Promise<Buffer>((resolve) => waiting.push(resolve));
    },
  );
  const jobs = Array.from({ length: 6 }, (_, i) => hasher.hash(String(i)));
  assert.deepEqual(hasher.snapshot(), { active: 2, queued: 4, stopped: false });
  const rejected = await Promise.allSettled(
    Array.from({ length: 100 }, () => hasher.hash('not retained')),
  );
  assert.ok(
    rejected.every(
      (r) => r.status === 'rejected' && r.reason instanceof WorkloadError,
    ),
  );
  for (let i = 0; i < 6; i++) {
    waiting.shift()!(Buffer.alloc(64));
    await tick();
  }
  assert.equal((await Promise.all(jobs)).length, 6);
  assert.deepEqual(seen, ['0', '1', '2', '3', '4', '5']);
  assert.deepEqual(hasher.snapshot(), { active: 0, queued: 0, stopped: false });
  await hasher.close();
});
test('hash queue expiry and repeated shutdown reject queued/new work while active derives finish', async () => {
  let finish!: (value: Buffer) => void;
  const hasher = new PasswordHasher(
    { concurrent: 1, queued: 1, waitMs: 20 },
    async () =>
      new Promise<Buffer>((resolve) => {
        finish = resolve;
      }),
  );
  const active = hasher.hash('active');
  await assert.rejects(hasher.hash('expired'), WorkloadError);
  assert.equal(hasher.snapshot().queued, 0);
  const queued = assert.rejects(hasher.hash('queued'), WorkloadError);
  const closing = hasher.close(),
    again = hasher.close();
  await queued;
  await assert.rejects(hasher.hash('new'), WorkloadError);
  finish(Buffer.alloc(64));
  await active;
  await closing;
  await again;
  assert.deepEqual(hasher.snapshot(), { active: 0, queued: 0, stopped: true });
});
