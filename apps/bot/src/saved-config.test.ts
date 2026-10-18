import assert from 'node:assert/strict';
import test from 'node:test';
import { watchConfiguration } from './saved-config.js';
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 15));

test('changed settings request a drained restart and no reads overlap or revive after shutdown', async () => {
  let resolve!: (value: { revision: string }) => void;
  let reads = 0,
    restarts = 0,
    failures = 0;
  const stop = watchConfiguration(
    'discord-1',
    () => {
      reads++;
      return new Promise((r) => {
        resolve = r;
      });
    },
    async () => {
      restarts++;
    },
    async () => {
      failures++;
    },
    1,
  );
  await tick();
  assert.equal(reads, 1);
  await tick();
  assert.equal(reads, 1);
  resolve({ revision: 'discord-2' });
  await tick();
  assert.equal(restarts, 1);
  assert.equal(failures, 0);
  assert.equal(reads, 1);
  stop();
  const cancel = watchConfiguration(
    'discord-1',
    () =>
      new Promise((r) => {
        resolve = r;
      }),
    async () => {
      restarts++;
    },
    async () => {
      failures++;
    },
    1,
  );
  await tick();
  cancel();
  resolve({ revision: 'discord-2' });
  await tick();
  assert.equal(restarts, 1);
});
test('unreadable managed settings stop the bot instead of retaining stale credentials', async () => {
  let failures = 0;
  const stop = watchConfiguration(
    'discord-1',
    async () => {
      throw new Error('private details');
    },
    async () => assert.fail('Unexpected restart'),
    async () => {
      failures++;
    },
    1,
  );
  await tick();
  stop();
  assert.equal(failures, 1);
});
