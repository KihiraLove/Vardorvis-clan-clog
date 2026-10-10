import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withAbort } from './with-abort.ts';
test('uncooperative requests release the action on abort and ignore late completion', async () => {
  const controller = new AbortController();
  let finish!: (value: string) => void;
  const action = withAbort(
    new Promise<string>((resolve) => {
      finish = resolve;
    }),
    controller.signal,
  );
  controller.abort();
  await assert.rejects(action, { name: 'AbortError' });
  finish('late');
  await assert.rejects(action, { name: 'AbortError' });
  assert.equal(
    await withAbort(Promise.resolve('retry'), new AbortController().signal),
    'retry',
  );
});
