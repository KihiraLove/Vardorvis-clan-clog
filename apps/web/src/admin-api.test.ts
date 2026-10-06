import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveAdminClient } from './admin-api.ts';
import { adminFixtures } from '../tests/admin-fixtures.ts';

const signal = () => new AbortController().signal;
const json = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });

test('private reads use same-origin/no-store, native fetch receiver and encoded queue cursors', async () => {
  const fixture = await adminFixtures(),
    paths: string[] = [];
  const client = new LiveAdminClient(async function (
    this: unknown,
    path,
    options,
  ) {
    assert.equal(this, globalThis);
    assert.equal(options?.credentials, 'same-origin');
    assert.equal(options?.cache, 'no-store');
    paths.push(String(path));
    if (String(path).includes('/submissions?')) return json(fixture.unmatched);
    if (String(path).includes('/submissions/'))
      return json({
        ...fixture.detail,
        submission: { ...fixture.detail.submission, id: 'opaque/id?one' },
      });
    return json(fixture.catalog);
  });
  await client.catalog(signal());
  await client.queue('unmatched', 'cursor/:?one', signal());
  await client.detail('opaque/id?one', signal());
  const params = new URL('https://example.test' + paths[1]).searchParams;
  assert.equal(params.get('status'), 'pending');
  assert.equal(params.get('unmatched'), 'true');
  assert.equal(params.get('cursor'), 'cursor/:?one');
  assert.equal(params.get('limit'), '20');
  assert.ok(paths[2]!.endsWith('/opaque%2Fid%3Fone'));
});

test('correction and review writes carry CSRF/versions and never caller-provided actors or credits', async () => {
  const fixture = await adminFixtures(),
    row = fixture.detail.submission;
  const requests: { path: string; options: RequestInit | undefined }[] = [];
  const client = new LiveAdminClient(async (path, options) => {
    requests.push({ path: String(path), options });
    return json({
      ...row,
      version: 2,
      status: String(path).endsWith('/approve') ? 'approved' : 'pending',
    });
  });
  await client.edit(
    row.id,
    1,
    {
      itemId: row.itemId!,
      collectorName: 'KihiraVD',
      collectedOn: row.collectedOn,
      hardcore: true,
      reason: '',
    },
    'csrf',
    signal(),
  );
  await client.decide(row.id, 1, 'approve', 'ignored', 'csrf', signal());
  assert.equal(requests[0]!.options!.method, 'PATCH');
  const correction = JSON.parse(requests[0]!.options!.body as string);
  assert.equal(correction.expectedVersion, 1);
  assert.equal(correction.hardcore, true);
  assert.equal(correction.actorName, undefined);
  assert.equal(correction.status, undefined);
  assert.deepEqual(JSON.parse(requests[1]!.options!.body as string), {
    expectedVersion: 1,
  });
  for (const request of requests)
    assert.equal(
      (request.options!.headers as Record<string, string>)['X-CSRF-Token'],
      'csrf',
    );
});

test('icon staging uses multipart, and item retries retain the same idempotency payload/key', async () => {
  const fixture = await adminFixtures(),
    requests: RequestInit[] = [];
  const item = {
    id: 500,
    name: 'Future drop',
    iconPath: '/api/v1/catalog/icons/asset',
    origin: 'manual',
    overrides: ['name', 'icon', 'pages'],
  };
  const client = new LiveAdminClient(async (path, options) => {
    requests.push(options!);
    return json(
      String(path).endsWith('/icons')
        ? {
            assetId: 'asset',
            iconPath: item.iconPath,
            expiresAt: '2099-10-05T12:00:00Z',
          }
        : {
            item,
            pageIds: [fixture.catalog.pages[0]!.id],
            catalogRevision: 'new',
          },
    );
  });
  const file = new File(
    [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])],
    'icon.png',
    { type: 'image/png' },
  );
  const asset = await client.upload(file, 'csrf', signal());
  const fields = {
    name: 'Future drop',
    iconAssetId: asset.assetId,
    pageIds: [fixture.catalog.pages[0]!.id],
  };
  await client.create(fields, 'stable-key', 'csrf', signal());
  await client.create(fields, 'stable-key', 'csrf', signal());
  assert.ok(requests[0]!.body instanceof FormData);
  assert.equal(
    (requests[0]!.headers as Record<string, string>)['Content-Type'],
    undefined,
  );
  for (const request of requests.slice(1)) {
    assert.equal(
      (request.headers as Record<string, string>)['Idempotency-Key'],
      'stable-key',
    );
    assert.deepEqual(JSON.parse(request.body as string), fields);
  }
});

test('page-order writes send the complete permutation/revision and reject mismatched receipts', async () => {
  const fixture = await adminFixtures(),
    page = fixture.catalog.pages.find((page) => page.id === 'vardorvis')!;
  const ids = [...page.itemIds].reverse();
  let wrong = false;
  const client = new LiveAdminClient(async (_path, options) => {
    assert.equal(options?.method, 'PUT');
    assert.deepEqual(JSON.parse(options?.body as string), {
      orderedItemIds: ids,
      expectedVersion: page.version,
    });
    return json({
      catalogRevision: 'new',
      page: {
        ...page,
        itemIds: wrong ? page.itemIds : ids,
        version: 'page-2',
        orderOrigin: 'manual',
      },
    });
  });
  assert.deepEqual(
    (await client.order(page.id, ids, page.version, 'csrf', signal())).itemIds,
    ids,
  );
  wrong = true;
  await assert.rejects(
    client.order(page.id, ids, page.version, 'csrf', signal()),
    /Unexpected/,
  );
});

test('missing/forbidden admin sessions and stale writes have explicit outcomes; logout accepts 204', async () => {
  const fixture = await adminFixtures();
  const authenticated = new LiveAdminClient(async (_path, options) => {
    assert.equal(options?.cache, 'no-store');
    return json(fixture.session);
  });
  assert.equal(
    (await authenticated.session(signal()))?.displayName,
    'KihiraVD',
  );
  const unauthorized = new LiveAdminClient(
    async () => new Response(null, { status: 401 }),
  );
  assert.equal(await unauthorized.session(signal()), null);
  await assert.rejects(unauthorized.catalog(signal()), { status: 401 });
  await assert.rejects(
    new LiveAdminClient(
      async () => new Response(null, { status: 403 }),
    ).session(signal()),
    { status: 403 },
  );
  await assert.rejects(
    new LiveAdminClient(async () => new Response(null, { status: 409 })).decide(
      'id',
      1,
      'reject',
      'Wrong item',
      'csrf',
      signal(),
    ),
    { status: 409 },
  );
  await new LiveAdminClient(async (path, options) => {
    assert.equal(path, '/api/v1/auth/logout');
    assert.equal(
      (options?.headers as Record<string, string>)['X-CSRF-Token'],
      'csrf',
    );
    return new Response(null, { status: 204 });
  }).logout('csrf', signal());
});

test('unsafe asset paths, incomplete metadata and wrong decision identities are rejected', async () => {
  const fixture = await adminFixtures();
  const badCatalog = {
    ...fixture.catalog,
    items: fixture.catalog.items.map((item, index) =>
      index ? item : { ...item, iconPath: 'https://evil.test/icon.png' },
    ),
  };
  await assert.rejects(
    new LiveAdminClient(async () => json(badCatalog)).catalog(signal()),
    /same-origin/,
  );
  const row = fixture.detail.submission;
  await assert.rejects(
    new LiveAdminClient(async () =>
      json({ ...row, id: 'other', status: 'approved', version: 2 }),
    ).decide(row.id, 1, 'approve', '', 'csrf', signal()),
    /Unexpected/,
  );
  await assert.rejects(
    new LiveAdminClient(async () =>
      json({ ...fixture.catalog, sourceRevision: undefined }),
    ).catalog(signal()),
  );
});
