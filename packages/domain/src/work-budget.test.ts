import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkBudget, WorkloadError } from './work-budget.js';
test('work admission checks every dimension atomically and releases exactly once', async () => {
  let now = 0;
  const budget = new WorkBudget(
    { concurrent: 2, perMinute: 3 },
    [
      { concurrent: 2, perMinute: 3 },
      { concurrent: 1, perMinute: 1 },
    ],
    5,
    () => now,
  );
  const first = budget.acquire(['guild', 'a']);
  assert.throws(() => budget.acquire(['guild', 'a']), WorkloadError);
  const second = budget.acquire(['guild', 'b']);
  assert.throws(() => budget.acquire(['other', 'c']), WorkloadError);
  first();
  first();
  second();
  assert.throws(() => budget.acquire(['guild', 'a']), {
    retryAfterSeconds: 60,
  });
  await budget.run(['other', 'c'], async () => undefined);
  assert.equal(budget.snapshot().accepted, 3);
  assert.equal(budget.snapshot().active, 0);
  now = 60000;
  await assert.rejects(
    budget.run(['guild', 'a'], async () => {
      throw new Error('failure');
    }),
  );
  assert.equal(budget.snapshot().active, 0);
  budget.close();
  assert.throws(() => budget.acquire(['guild', 'b']), WorkloadError);
});
test('identity churn stays bounded and expiry reclaims slots while retaining active work', () => {
  let now = 0;
  const budget = new WorkBudget(
    { concurrent: 3, perMinute: 100000 },
    [{ concurrent: 1, perMinute: 10 }],
    2,
    () => now,
  );
  const active = budget.acquire(['active']);
  budget.acquire(['finished'])();
  for (let n = 0; n < 10000; n++)
    assert.throws(() => budget.acquire([String(n)]), WorkloadError);
  assert.deepEqual(budget.snapshot().keys, [2]);
  now = 60001;
  budget.acquire(['new'])();
  assert.deepEqual(budget.snapshot().keys, [2]);
  assert.throws(() => budget.acquire(['active']), WorkloadError);
  active();
  now += 60001;
  budget.acquire(['last'])();
  assert.deepEqual(budget.snapshot().keys, [1]);
});
