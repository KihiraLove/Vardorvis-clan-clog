/** Mock XP endpoints check exact values, coherent revisions, staged ETags and import receipts. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveXpClient } from './xp-api.ts';
import { competition, importPreview, publicXp } from '../tests/xp-fixtures.ts';

const signal = () => new AbortController().signal;
const json = (data: unknown, etag = 'xp-one') =>
  new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', ETag: etag },
  });

test('public reads preserve exact large XP and reuse conditional snapshots with native fetch context', async () => {
  const data = publicXp('9007199254740993');
  let phase = 0;
  const client = new LiveXpClient(async function (
    this: unknown,
    path,
    options,
  ) {
    assert.equal(this, globalThis);
    assert.equal(options?.credentials, 'same-origin');
    assert.equal(options?.cache, 'no-cache');
    if (!phase) return json(data[String(path)]);
    assert.equal(
      (options?.headers as Record<string, string>)['If-None-Match'],
      'xp-one',
    );
    return new Response(null, { status: 304 });
  });
  const first = await client.load('attack', 1001, signal());
  assert.equal(first.overview.totals.attack, '9007199254740993');
  assert.equal(first.detail!.participants[2]!.gains.attack, '0');
  assert.equal(first.detail!.participants[3]!.gains.attack, null);
  phase = 1;
  assert.deepEqual(await client.load('attack', 1001, signal()), first);
});

test('partial errors or mixed revisions never commit staged ETags', async () => {
  const original = publicXp();
  let phase = 0;
  const client = new LiveXpClient(async (path, options) => {
    const key = String(path);
    if (!phase) return json(original[key]);
    if (phase === 1)
      return key.endsWith('/members')
        ? new Response(null, { status: 503 })
        : json(publicXp('19595678', 'xp-two')[key], 'xp-two');
    if (phase === 2)
      return json(
        key.endsWith('/competitions')
          ? publicXp('19595678', 'xp-two')[key]
          : original[key],
        'must-not-commit',
      );
    assert.equal(
      (options?.headers as Record<string, string>)['If-None-Match'],
      'xp-one',
    );
    return new Response(null, { status: 304 });
  });
  const first = await client.load('attack', undefined, signal());
  phase = 1;
  await assert.rejects(client.load('attack', undefined, signal()), {
    status: 503,
  });
  phase = 2;
  await assert.rejects(
    client.load('attack', undefined, signal()),
    /Inconsistent XP revision/,
  );
  phase = 3;
  assert.deepEqual(await client.load('attack', undefined, signal()), first);
});

test('incomplete totals, invalid dates and aborted reads fail without caching', async () => {
  for (const mode of ['missing', 'date', 'abort']) {
    let phase = 0;
    const client = new LiveXpClient(async (path, options) => {
      if (phase)
        assert.equal(
          (options?.headers as Record<string, string>)['If-None-Match'],
          undefined,
        );
      const payload = structuredClone(publicXp()[String(path)]) as Record<
        string,
        unknown
      >;
      if (!phase && String(path).endsWith('/skills')) {
        if (mode === 'missing') payload.skills = [];
        if (mode === 'date') payload.updatedAt = 'invalid';
      }
      return json(payload);
    });
    const controller = new AbortController();
    if (mode === 'abort') controller.abort();
    await assert.rejects(client.load('attack', undefined, controller.signal));
    phase = 1;
    await client.load('attack', undefined, signal());
  }
});

test('preview requests canonicalize the source and carry CSRF; applies use the validated token and stable request key', async () => {
  const requests: { path: string; options: RequestInit | undefined }[] = [];
  const client = new LiveXpClient(async (path, options) => {
    requests.push({ path: String(path), options });
    return json(
      String(path).endsWith('/preview')
        ? importPreview
        : { outcome: 'applied', revision: 'xp-two' },
    );
  });
  const preview = await client.preview(
    'https://www.wiseoldman.net/competitions/1001/?x=1#results',
    'csrf',
    signal(),
  );
  await client.apply(preview, 'csrf', 'same-request', signal());
  await client.apply(preview, 'csrf', 'same-request', signal());
  assert.deepEqual(JSON.parse(requests[0]!.options!.body as string), {
    competitionUrl: competition.sourceUrl,
  });
  assert.equal(
    (requests[0]!.options!.headers as Record<string, string>)['X-CSRF-Token'],
    'csrf',
  );
  for (const request of requests.slice(1)) {
    assert.equal(request.options?.cache, 'no-store');
    assert.equal(
      (request.options!.headers as Record<string, string>)['Idempotency-Key'],
      'same-request',
    );
    assert.deepEqual(JSON.parse(request.options!.body as string), {
      previewToken: 'validated-token',
      expectedRevision: 'xp-one',
      acknowledgeCorrections: false,
    });
  }
});

test('wrong competition previews and non-admin sessions cannot be treated as an authorized import', async () => {
  const wrong = {
    ...importPreview,
    competition: {
      ...importPreview.competition,
      id: 1002,
      sourceUrl: 'https://wiseoldman.net/competitions/1002',
    },
  };
  await assert.rejects(
    new LiveXpClient(async () => json(wrong)).preview(
      competition.sourceUrl,
      'csrf',
      signal(),
    ),
    /does not match/,
  );
  assert.equal(
    await new LiveXpClient(
      async () => new Response(null, { status: 401 }),
    ).session(signal()),
    null,
  );
  assert.equal(
    await new LiveXpClient(async () => json({ authenticated: false })).session(
      signal(),
    ),
    null,
  );
  await assert.rejects(
    new LiveXpClient(async () => new Response(null, { status: 403 })).preview(
      competition.sourceUrl,
      'csrf',
      signal(),
    ),
    { status: 403 },
  );
});

test('live admin session recognizes only an explicit boolean local test marker', async () => {
  const live = new LiveXpClient(async () =>
    json({ authenticated: true, displayName: 'Local test admin', csrfToken: 'token', development: true }),
  );
  assert.equal((await live.session(signal()))?.development, true);
  const production = new LiveXpClient(async () =>
    json({ authenticated: true, displayName: 'Admin', csrfToken: 'token' }),
  );
  assert.equal((await production.session(signal()))?.development, undefined);
  const malformed = new LiveXpClient(async () =>
    json({ authenticated: true, displayName: 'Admin', csrfToken: 'token', development: 'true' }),
  );
  await assert.rejects(malformed.session(signal()), /Invalid admin session mode/);
});
