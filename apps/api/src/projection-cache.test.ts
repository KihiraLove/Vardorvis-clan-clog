import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProjectionCache } from './projection-cache.js';
test('projection cache shares one in-flight load, freezes results and retains only the current revision', async () => {
  const cache = new ProjectionCache<{ rows: number[] }>();
  let loads = 0,
    finish!: (value: { rows: number[] }) => void;
  const first = cache.read('one', async () => {
    loads++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const second = cache.read('one', async () => {
    loads++;
    return { rows: [9] };
  });
  finish({ rows: [1] });
  assert.equal(await first, await second);
  assert.equal(loads, 1);
  assert.throws(() => cache.peek('one')!.data.rows.push(2), TypeError);
  for (let n = 0; n < 10000; n++) cache.put(String(n), { rows: [n] });
  assert.equal(cache.peek('one'), undefined);
  assert.equal(cache.peek('9998'), undefined);
  assert.deepEqual(cache.peek('9999')!.data.rows, [9999]);
  await assert.rejects(
    cache.read('failed', async () => {
      throw new Error('failure');
    }),
  );
  assert.equal(cache.peek('failed'), undefined);
  assert.deepEqual(
    (await cache.read('failed', async () => ({ rows: [3] }))).data.rows,
    [3],
  );
});
