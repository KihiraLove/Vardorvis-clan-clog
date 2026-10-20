/** Mock transport tests verify private headers, version/idempotency payloads and server receipts. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveAdminClient } from './admin-api.ts';
import { adminFixtures } from '../tests/admin-fixtures.ts';

const signal = () => new AbortController().signal;
const json = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });

test('highlight settings send revision and CSRF, accept reordered channels and reject malformed or mismatched receipts', async () => {
  const eventHighlight = { alpha: 0.375, blue: 128, green: 255, red: 0 };
  let receipt: unknown = {
    revision: 'settings-6',
    clanName: 'Clan name',
    hardcoreEnabled: false,
    eventHighlight,
  };
  const client = new LiveAdminClient(async (path, options) => {
    assert.equal(path, '/api/v1/admin/settings');
    assert.equal(options?.method, 'PUT');
    assert.equal(new Headers(options?.headers).get('X-CSRF-Token'), 'csrf');
    assert.deepEqual(JSON.parse(String(options?.body)), {
      hardcoreEnabled: false,
      expectedRevision: 'settings-5',
      eventHighlight,
    });
    return json(receipt);
  });
  const save = () =>
    client.saveSettings(
      false,
      'settings-5',
      'csrf',
      signal(),
      undefined,
      undefined,
      undefined,
      undefined,
      { eventHighlight },
    );
  assert.deepEqual((await save()).eventHighlight, {
    red: 0,
    green: 255,
    blue: 128,
    alpha: 0.375,
  });
  for (const invalid of [
    { ...eventHighlight, alpha: 1.1 },
    { ...eventHighlight, red: '0' },
    null,
  ]) {
    receipt = {
      revision: 'settings-6',
      clanName: 'Clan name',
      hardcoreEnabled: false,
      eventHighlight: invalid,
    };
    await assert.rejects(save(), /highlight/i);
  }
  receipt = {
    revision: 'settings-6',
    clanName: 'Clan name',
    hardcoreEnabled: false,
    eventHighlight: { ...eventHighlight, alpha: 1 },
  };
  await assert.rejects(save(), /Unexpected settings receipt/);
});

test('Discord status accepts explicit phases and legacy replies while rejecting contradictions and malformed states', async () => {
  for (const state of [
    'disabled',
    'connecting',
    'connected',
    'disconnected',
    'unavailable',
  ] as const) {
    const value = {
      enabled: state !== 'disabled',
      ready: state === 'connected',
      state,
    };
    const client = new LiveAdminClient(
      async () =>
        new Response(
          JSON.stringify({ ...value, token: 'private ignored field' }),
          { status: value.ready || !value.enabled ? 200 : 503 },
        ),
    );
    assert.deepEqual(await client.discordStatus(signal()), value);
  }
  for (const value of [
    { enabled: false, ready: true, state: 'disabled' },
    { enabled: true, ready: false, state: 'connected' },
    { enabled: true, ready: true, state: 'connecting' },
    { enabled: false, ready: false, state: 'disconnected' },
    { enabled: true, ready: false, state: 'disabled' },
    { enabled: true, ready: false, state: 'bad' },
    { enabled: true, ready: false, state: null },
    {},
  ]) {
    const client = new LiveAdminClient(async () => json(value));
    await assert.rejects(client.discordStatus(signal()), /Discord status/);
  }
  for (const value of [
    { enabled: false, ready: false },
    { enabled: true, ready: true },
  ]) {
    const client = new LiveAdminClient(async () => json(value));
    assert.deepEqual(await client.discordStatus(signal()), {
      ...value,
      state: value.ready ? 'connected' : 'disabled',
    });
  }
  const unhealthy = new LiveAdminClient(
    async () =>
      new Response(
        JSON.stringify({ enabled: true, ready: true, state: 'connected' }),
        { status: 503 },
      ),
  );
  await assert.rejects(unhealthy.discordStatus(signal()), /Discord status/);
});

test('review decisions and separate flag saves send only their selected fields and validate receipts', async () => {
  const row = (await adminFixtures()).detail.submission;
  const flags = { hardcore: false, collectionType: 'event' as const };
  for (const action of ['approve', 'reject', 'flags'] as const) {
    const client = new LiveAdminClient(async (path, options) => {
      assert.equal(path, '/api/v1/admin/submissions/' + row.id + '/' + action);
      assert.equal(options!.method, action === 'flags' ? 'PATCH' : 'POST');
      assert.equal(
        (options!.headers as Record<string, string>)['X-CSRF-Token'],
        'csrf',
      );
      assert.deepEqual(JSON.parse(String(options!.body)), {
        expectedVersion: row.version,
        flags,
        ...(action === 'approve' ? {} : { reason: 'Verified' }),
      });
      return json({
        ...row,
        ...flags,
        version: row.version + 1,
        status: action === 'reject' ? 'rejected' : 'approved',
      });
    });
    if (action === 'flags')
      await client.saveCollectionFlags(
        row.id,
        row.version,
        flags,
        'Verified',
        'csrf',
        signal(),
      );
    else
      await client.decide(
        row.id,
        row.version,
        action,
        'Verified',
        'csrf',
        signal(),
        flags,
      );
  }
  const badReceipt = new LiveAdminClient(async () =>
    json({
      ...row,
      version: row.version + 1,
      status: 'approved',
      hardcore: true,
      collectionType: 'regular',
    }),
  );
  await assert.rejects(
    badReceipt.decide(
      row.id,
      row.version,
      'approve',
      '',
      'csrf',
      signal(),
      flags,
    ),
    /Unexpected review receipt/,
  );
  await assert.rejects(
    badReceipt.saveCollectionFlags(
      row.id,
      row.version,
      flags,
      'Verified',
      'csrf',
      signal(),
    ),
    /Unexpected collection flags receipt/,
  );
});

test('Discord settings use CSRF and revision checks; unavailable gateway status remains readable', async () => {
  const fields = {
    enabled: true,
    applicationId: '123456789012345678',
    guildId: '223456789012345678',
    testGuildId: '',
    limits: {
      intakeUser: 5,
      intakeGuild: 60,
      searchUser: 30,
      searchGuild: 300,
    },
  };
  const token = 'private_token_123456789012345678';
  const client = new LiveAdminClient(async (path, options) => {
    assert.equal(options?.cache, 'no-store');
    assert.equal(options?.credentials, 'same-origin');
    if (path === '/api/v1/discord/status')
      return new Response(JSON.stringify({ enabled: true, ready: false }), {
        status: 503,
      });
    assert.equal(path, '/api/v1/admin/discord-settings');
    assert.equal(
      (options?.headers as Record<string, string>)['X-CSRF-Token'],
      'csrf',
    );
    assert.deepEqual(JSON.parse(String(options?.body)), {
      ...fields,
      token,
      expectedRevision: 'discord-1',
    });
    return json({ ...fields, tokenConfigured: true, revision: 'discord-2' });
  });
  const saved = await client.saveDiscordSettings(
    { ...fields, token, expectedRevision: 'discord-1' },
    'csrf',
    signal(),
  );
  assert.equal(saved.tokenConfigured, true);
  assert.equal('token' in saved, false);
  assert.deepEqual(await client.discordStatus(signal()), {
    enabled: true,
    ready: false,
    state: 'unavailable',
  });
  await assert.rejects(
    new LiveAdminClient(async () =>
      json({ ...fields, tokenConfigured: true, revision: 'discord-1' }),
    ).saveDiscordSettings(
      { ...fields, expectedRevision: 'discord-1' },
      'csrf',
      signal(),
    ),
    /Unexpected Discord settings receipt/,
  );
});

test('page item deletion sends the selected page, CSRF and both revisions, and validates its retirement receipt', async () => {
  const client = new LiveAdminClient(async (path, options) => {
    assert.equal(path, '/api/v1/admin/catalog/pages/one%2Fpage/items/42');
    assert.equal(options?.method, 'DELETE');
    assert.equal(
      (options?.headers as Record<string, string>)['X-CSRF-Token'],
      'csrf',
    );
    assert.deepEqual(JSON.parse(String(options?.body)), {
      expectedRevision: 'catalog-1',
      expectedVersion: 'page-2',
    });
    return json({
      itemId: 42,
      pageId: 'one/page',
      retired: false,
      catalogRevision: 'catalog-2',
    });
  });
  assert.deepEqual(
    await client.removePageItem(
      'one/page',
      42,
      'catalog-1',
      'page-2',
      'csrf',
      signal(),
    ),
    { retired: false },
  );
  for (const receipt of [
    {
      itemId: 42,
      pageId: 'other',
      retired: false,
      catalogRevision: 'catalog-2',
    },
    {
      itemId: 42,
      pageId: 'one/page',
      retired: 'true',
      catalogRevision: 'catalog-2',
    },
    {
      itemId: 43,
      pageId: 'one/page',
      retired: false,
      catalogRevision: 'catalog-2',
    },
  ])
    await assert.rejects(
      new LiveAdminClient(async () => json(receipt)).removePageItem(
        'one/page',
        42,
        'catalog-1',
        'page-2',
        'csrf',
        signal(),
      ),
      /Unexpected/u,
    );
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
  await client.detail('opaque/id?one', signal(), 'audit/:?cursor');
  const params = new URL('https://example.test' + paths[1]).searchParams;
  assert.equal(params.get('status'), 'pending');
  assert.equal(params.get('unmatched'), 'true');
  assert.equal(params.get('cursor'), 'cursor/:?one');
  assert.equal(params.get('limit'), '20');
  assert.ok(paths[2]!.endsWith('/opaque%2Fid%3Fone'));
  assert.equal(
    new URL('https://example.test' + paths[3]).searchParams.get('cursor'),
    'audit/:?cursor',
  );
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
    gameItemIds: [900001],
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

test('manual create and password sign-in use private routes, CSRF and validated receipt', async () => {
  const f = await adminFixtures();
  const row = f.detail.submission;
  const requests: { url: string; options: RequestInit | undefined }[] = [];
  const client = new LiveAdminClient(async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith('/auth/login'))
      return json({ authenticated: true });
    return new Response(
      JSON.stringify({
        ...row,
        source: 'manual',
        status: 'approved',
      }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    );
  });
  await client.login('admin', 'test-only-password', signal());
  const created = await client.addManual(
    {
      itemId: row.itemId!,
      collectorName: row.collectorName,
      collectedOn: row.collectedOn,
      hardcore: row.hardcore,
      proofUrl: '',
      approve: true,
    },
    '00000000-0000-4000-8000-000000000001',
    'csrf',
    signal(),
  );
  assert.equal(created.source, 'manual');
  assert.equal(requests[0]!.url, '/api/v1/auth/login');
  assert.deepEqual(JSON.parse(requests[0]!.options!.body as string), {
    username: 'admin',
    password: 'test-only-password',
  });
  assert.equal(
    (requests[1]!.options?.headers as Record<string, string>)[
      'Idempotency-Key'
    ],
    '00000000-0000-4000-8000-000000000001',
  );
  assert.equal(requests[1]!.url, '/api/v1/admin/submissions');
  assert.equal(requests[1]!.options?.method, 'POST');
  assert.equal(
    (requests[1]!.options?.headers as Record<string, string>)['X-CSRF-Token'],
    'csrf',
  );
});

test('manual submission accepts a 201 response with no proof URL and preserves the empty field', async () => {
  const fixture = await adminFixtures();
  const row = fixture.detail.submission;
  const client = new LiveAdminClient(async (path, options) => {
    assert.equal(path, '/api/v1/admin/submissions');
    assert.equal(options?.method, 'POST');
    assert.equal(
      (options?.headers as Record<string, string>)['X-CSRF-Token'],
      'csrf',
    );
    return new Response(
      JSON.stringify({
        ...row,
        source: 'manual',
        itemId: row.itemId,
        hardcore: false,
        status: 'approved',
        proofUrl: '',
      }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    );
  });
  const receipt = await client.addManual(
    {
      itemId: row.itemId!,
      collectorName: row.collectorName,
      collectedOn: row.collectedOn,
      hardcore: false,
      approve: true,
    },
    '00000000-0000-4000-8000-000000000001',
    'csrf',
    signal(),
  );
  assert.equal(receipt.proofUrl, '');
  assert.equal(receipt.source, 'manual');
});

test('409 occupied credit detail is shown only for the known server conflict message', async () => {
  const occupied =
    'An approved credit already exists for this item and world mode. Revoke the existing credit or select a different item or mode.';
  const client = new LiveAdminClient(
    async () =>
      new Response(JSON.stringify({ error: occupied }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  await assert.rejects(client.queue('pending', undefined, signal()), {
    status: 409,
    message: occupied,
  });
  const untrusted = new LiveAdminClient(
    async () =>
      new Response(
        JSON.stringify({ error: 'private SQL details must not show' }),
        {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
  );
  await assert.rejects(untrusted.queue('pending', undefined, signal()), {
    status: 409,
    message:
      'Another change was saved. Load the latest data before trying again.',
  });
});

test('manual PNG uploads use multipart with CSRF and a stable retry key', async () => {
  const fixture = await adminFixtures();
  const fields = {
    itemId: fixture.detail.submission.itemId!,
    collectorName: 'PNG Collector',
    collectedOn: '2026-10-05',
    hardcore: false,
    approve: false,
  };
  const file = new File(
    [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
    'proof.png',
    { type: 'image/png' },
  );
  const path =
    '/api/v1/admin/submission-images/00000000-0000-4000-8000-000000000001.webp';
  const client = new LiveAdminClient(async (url, options) => {
    assert.equal(url, '/api/v1/admin/submissions/upload');
    assert.equal(
      (options?.headers as Record<string, string>)['X-CSRF-Token'],
      'csrf',
    );
    assert.equal(
      (options?.headers as Record<string, string>)['Idempotency-Key'],
      '00000000-0000-4000-8000-000000000002',
    );
    assert.equal(
      (options?.headers as Record<string, string>)['Content-Type'],
      undefined,
    );
    assert.ok(options?.body instanceof FormData);
    assert.deepEqual(
      JSON.parse(String(options.body.get('submission'))),
      fields,
    );
    assert.equal((options.body.get('screenshot') as File).name, 'proof.png');
    return Response.json(
      {
        ...fixture.detail.submission,
        ...fields,
        source: 'manual',
        status: 'pending',
        proofUrl: '',
        screenshotPath: path,
      },
      { status: 201 },
    );
  });
  const result = await client.addManual(
    fields,
    '00000000-0000-4000-8000-000000000002',
    'csrf',
    signal(),
    file,
  );
  assert.equal(result.screenshotPath, path);
});

test('note-only PATCH has its own versioned CSRF contract and validates the saved note receipt', async () => {
  const f = await adminFixtures();
  const original = f.detail.submission;
  let attempts = 0;
  const client = new LiveAdminClient(async (url, options) => {
    attempts++;
    assert.equal(
      url,
      '/api/v1/admin/submissions/' + encodeURIComponent(original.id) + '/note',
    );
    assert.equal(options?.method, 'PATCH');
    assert.equal(
      (options?.headers as Record<string, string>)['X-CSRF-Token'],
      'csrf',
    );
    assert.deepEqual(JSON.parse(String(options?.body)), {
      expectedVersion: original.version,
      note: '  A saved note  ',
    });
    return Response.json({
      ...original,
      version: attempts === 1 ? original.version + 1 : original.version,
      reviewNote: attempts === 1 ? 'A saved note' : 'different',
    });
  });
  const result = await client.saveReviewNote(
    original.id,
    original.version,
    '  A saved note  ',
    'csrf',
    signal(),
  );
  assert.equal(result.reviewNote, 'A saved note');
  await assert.rejects(
    client.saveReviewNote(
      original.id,
      original.version,
      '  A saved note  ',
      'csrf',
      signal(),
    ),
    /Unexpected review note receipt/u,
  );
});
