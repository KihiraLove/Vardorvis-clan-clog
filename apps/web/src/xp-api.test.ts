/** Exercise only the aggregate tracker and private session used by the product. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveXpClient } from './xp-api.ts';
import { zeroTotals } from './xp-model.ts';
const signal = () => new AbortController().signal;
const tracker = {
  revision: 'xp-1',
  totals: { ...zeroTotals(), attack: '9007199254740993' },
  events: [],
};
const json = (value: unknown, etag = 'xp-1') =>
  new Response(JSON.stringify(value), {
    headers: { ETag: etag, 'Content-Type': 'application/json' },
  });

test('aggregate tracker preserves exact gains, native fetch context and validated conditional reuse', async () => {
  let repeated = false;
  const client = new LiveXpClient(async function (
    this: unknown,
    path,
    options,
  ) {
    assert.equal(this, globalThis);
    assert.equal(path, '/api/v1/xp/tracker');
    assert.equal(options?.credentials, 'same-origin');
    assert.equal(options?.cache, 'no-cache');
    if (!repeated) return json(tracker);
    assert.equal(
      (options?.headers as Record<string, string>)['If-None-Match'],
      'xp-1',
    );
    return new Response(null, { status: 304 });
  });
  const first = await client.tracker(signal());
  assert.equal(first.totals.attack, '9007199254740993');
  repeated = true;
  assert.deepEqual(await client.tracker(signal()), first);
});

test('invalid or aborted tracker responses never replace a valid cached snapshot', async () => {
  let phase = 'valid';
  const controller = new AbortController();
  const client = new LiveXpClient(async (_path, options) => {
    if (phase !== 'valid')
      assert.equal(
        (options?.headers as Record<string, string>)['If-None-Match'],
        'xp-1',
      );
    if (phase === 'invalid') return json({ ...tracker, totals: {} }, 'bad');
    if (phase === 'aborted') {
      controller.abort();
      return json({ ...tracker, revision: 'xp-2' }, 'xp-2');
    }
    if (phase === 'replay') return new Response(null, { status: 304 });
    return json(tracker);
  });
  const first = await client.tracker(signal());
  phase = 'invalid';
  await assert.rejects(client.tracker(signal()));
  phase = 'aborted';
  await assert.rejects(client.tracker(controller.signal), {
    name: 'AbortError',
  });
  phase = 'replay';
  assert.deepEqual(await client.tracker(signal()), first);
});

test('session reads are private, validate identity, and distinguish signed-out from forbidden', async () => {
  const session = {
    authenticated: true,
    csrfToken: 'csrf',
    displayName: 'Staff',
    username: 'staff',
    role: 'moderator',
    mustChangePassword: false,
  };
  const client = new LiveXpClient(async (path, options) => {
    assert.equal(path, '/api/v1/auth/session');
    assert.equal(options?.cache, 'no-store');
    assert.equal(options?.credentials, 'same-origin');
    return json(session);
  });
  assert.equal((await client.session(signal()))?.role, 'moderator');
  for (const status of [401, 403, 503]) {
    const failed = new LiveXpClient(async () => new Response(null, { status }));
    if (status === 401) assert.equal(await failed.session(signal()), null);
    else await assert.rejects(failed.session(signal()), { status });
  }
  assert.equal(
    await new LiveXpClient(async () => json({ authenticated: false })).session(
      signal(),
    ),
    null,
  );
  await assert.rejects(
    new LiveXpClient(async () => json({ ...session, role: 'owner' })).session(
      signal(),
    ),
  );
});
