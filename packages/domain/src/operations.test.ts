import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OperationalDiagnostics,
  WorkDrain,
  safeFailure,
  withinDeadline,
} from './operations.js';
test('diagnostics classify known failures and keep secrets and unsafe driver objects out of bounded counters', () => {
  const records: Record<string, unknown>[] = [],
    diagnostics = new OperationalDiagnostics('api', (record) =>
      records.push(record),
    );
  const examples = [
    [401, 'auth'],
    [403, 'forbidden'],
    [409, 'conflict'],
    [422, 'validation'],
    [429, 'overload'],
    [503, 'dependency'],
  ] as const;
  for (const [status, category] of examples)
    assert.equal(safeFailure(undefined, status).category, category);
  for (const [code, category] of [
    ['23505', 'conflict'],
    ['23503', 'validation'],
    ['40P01', 'database'],
    ['08006', 'database'],
    ['57P01', 'database'],
    ['57014', 'timeout'],
  ]) {
    const unsafe = Object.assign(
      new Error('password proof cookie postgresql://secret'),
      { code, detail: 'private body', connection: { password: 'secret' } },
    );
    assert.equal(safeFailure(unsafe).category, category);
    diagnostics.record('failure', {
      operation: 'http',
      ...safeFailure(unsafe),
      correlation: 'password-secret',
      pending: ['https://private/proof', '123456789012345678'],
    });
  }
  const eventCount = Object.keys(diagnostics.snapshot()).length;
  for (let n = 0; n < 10000; n++)
    diagnostics.record('failure', {
      operation: 'http',
      ...safeFailure({ code: 'unsafe-secret-' + n }),
    });
  assert.equal(Object.keys(diagnostics.snapshot()).length, eventCount + 1);
  assert.doesNotMatch(
    JSON.stringify([records, diagnostics.snapshot()]),
    /password|cookie|postgresql|private|unsafe-secret/iu,
  );
  assert.equal(records[0]!.correlation, undefined);
});
test('drain stops new admission, retains active correlations and completes only after idempotent releases', async () => {
  const work = new WorkDrain(),
    release = work.enter('123456789012345678')!;
  let completed = false;
  const stop = work.stop().then(() => {
    completed = true;
  });
  assert.equal(work.enter(), undefined);
  const child = work.enter('123456789012345678', true)!;
  release();
  release();
  await Promise.resolve();
  assert.equal(completed, false);
  assert.deepEqual(work.snapshot().pending, ['123456789012345678']);
  child();
  await stop;
  await work.stop();
  assert.equal(work.snapshot().active, 0);
});
test('deadlines report expiry without claiming stalled work completed and propagate actual failure', async () => {
  assert.equal(await withinDeadline(async () => {}, 100), true);
  assert.equal(await withinDeadline(() => new Promise(() => {}), 10), false);
  await assert.rejects(
    withinDeadline(async () => {
      throw Error('failure');
    }, 100),
    /failure/u,
  );
});
