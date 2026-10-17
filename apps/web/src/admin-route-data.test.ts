import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadAdminRoute } from './admin-route-data.ts';
import { MemoryAdminClient } from '../tests/support/admin.ts';
import { MemoryXpClient } from '../tests/support/xp.ts';
import type { AdminSession } from './xp-model.ts';

const signal = () => new AbortController().signal;
test('route loaders prepare every destination with one shared catalog read and no session or write waterfall', async (t) => {
  const client = new MemoryAdminClient(),
    xp = new MemoryXpClient();
  const session = (await client.session(signal()))!;
  t.mock.method(client, 'session', async () => {
    throw new Error('session already verified');
  });
  const catalog = t.mock.method(client, 'catalog');
  for (const method of ['tracker', 'history'] as const)
    t.mock.method(xp, method, async () => {
      throw new Error('retired XP screen must not load private XP data');
    });
  for (const [path, kind] of [
    ['/admin', 'queue'],
    ['/admin/catalog', 'catalog'],
    ['/admin/xp', 'schedules'],
    ['/admin/schedules', 'schedules'],
    ['/admin/settings', 'settings'],
    ['/admin/settings/hardcore', 'settings'],
    ['/admin/runelite', 'runelite'],
    ['/admin/accounts', 'accounts'],
    ['/admin/account', 'account'],
  ]) {
    const result = await loadAdminRoute(path!, session, client, xp, signal());
    assert.equal(result.kind, kind);
    if (['queue', 'catalog', 'schedules'].includes(kind!))
      assert.ok(result.catalog?.revision);
    if (kind === 'schedules') assert.ok(result.schedules);
    if (kind === 'settings') {
      assert.ok(result.settings);
      assert.ok(result.branding);
    }
    if (kind === 'runelite') {
      assert.ok(result.clanKey);
      assert.ok(result.runeLite);
    }
  }
  assert.equal(catalog.mock.callCount(), 4);
});
test('moderator and mandatory-password routes never issue unauthorized reads', async (t) => {
  const client = new MemoryAdminClient(),
    xp = new MemoryXpClient();
  const session: AdminSession = {
    ...(await client.session(signal()))!,
    role: 'moderator',
  };
  for (const method of ['settings', 'branding', 'accounts'] as const)
    t.mock.method(client, method, async () => {
      throw new Error('unauthorized read');
    });
  for (const method of ['tracker', 'history'] as const)
    t.mock.method(xp, method, async () => {
      throw new Error('retired XP screen must not load private XP data');
    });
  for (const path of [
    '/admin/settings',
    '/admin/settings/hardcore',
    '/admin/accounts',
  ])
    assert.equal(
      (await loadAdminRoute(path, session, client, xp, signal())).kind,
      'denied',
    );
  const legacy = await loadAdminRoute(
    '/admin/xp',
    session,
    client,
    xp,
    signal(),
  );
  assert.equal(legacy.kind, 'schedules');
  assert.ok(legacy.schedules);
  assert.ok(legacy.catalog);
  assert.equal(
    (await loadAdminRoute('/admin/runelite', session, client, xp, signal()))
      .kind,
    'runelite',
  );
  assert.equal(
    (
      await loadAdminRoute(
        '/admin/settings',
        { ...session, mustChangePassword: true },
        client,
        xp,
        signal(),
      )
    ).kind,
    'account',
  );
});
test('a canceled loader settles even when a source ignores its signal; late results cannot revive it', async (t) => {
  const client = new MemoryAdminClient(),
    xp = new MemoryXpClient();
  const session = (await client.session(signal()))!;
  const catalog = await client.catalog(signal());
  let release!: (value: typeof catalog) => void;
  t.mock.method(
    client,
    'catalog',
    () =>
      new Promise<typeof catalog>((resolve) => {
        release = resolve;
      }),
  );
  const controller = new AbortController();
  const loading = loadAdminRoute(
    '/admin/catalog',
    session,
    client,
    xp,
    controller.signal,
  );
  controller.abort();
  await assert.rejects(loading, { name: 'AbortError' });
  release(catalog);
  await assert.rejects(loading, { name: 'AbortError' });
});
test('multi-read destinations reject incomplete preparations instead of exposing a partial form', async (t) => {
  const client = new MemoryAdminClient(),
    xp = new MemoryXpClient();
  const session = (await client.session(signal()))!;
  t.mock.method(client, 'branding', async () => {
    throw new Error('branding unavailable');
  });
  await assert.rejects(
    loadAdminRoute('/admin/settings', session, client, xp, signal()),
    /branding unavailable/,
  );
});
