import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultRuneLiteRules, parseRuneLiteSettings } from '@clog/domain';
import { LiveAdminClient } from './admin-api.ts';
import { MemoryAdminClient } from '../tests/support/admin.ts';
const signal = () => new AbortController().signal;
test('private RuneLite adapter sends revisions and CSRF and validates canonical receipts', async () => {
  const rules = defaultRuneLiteRules('In-game Clan');
  rules.playerWhitelist = ['Player_One', 'player one'];
  const receipt = {
    revision: 'runelite-2',
    ...rules,
    playerWhitelist: ['player one'],
    clanKeyRequirement: { enabled: false, revision: 'clan-key-2' },
  };
  const client = new LiveAdminClient(async (path, options) => {
    assert.equal(path, '/api/v1/admin/runelite-settings');
    assert.equal(options?.cache, 'no-store');
    assert.equal(options?.credentials, 'same-origin');
    assert.equal(options?.method, 'PUT');
    assert.equal(
      (options.headers as Record<string, string>)['X-CSRF-Token'],
      'csrf',
    );
    assert.deepEqual(JSON.parse(String(options.body)), {
      expectedRevision: 'runelite-1',
      ...rules,
      playerWhitelist: ['player one'],
      clanKeyRequirement: { enabled: false, expectedRevision: 'clan-key-1' },
    });
    return Response.json(receipt);
  });
  assert.deepEqual(
    await client.saveRuneLiteSettings(
      {
        expectedRevision: 'runelite-1',
        ...rules,
        clanKeyRequirement: { enabled: false, expectedRevision: 'clan-key-1' },
      },
      'csrf',
      signal(),
    ),
    receipt,
  );
  for (const bad of [
    { ...receipt, revision: 'bad' },
    { ...receipt, matchClanName: 1 },
    {
      ...receipt,
      clanKeyRequirement: { enabled: false, revision: 'runelite-1' },
    },
  ])
    assert.throws(() => parseRuneLiteSettings(bad));
  await assert.rejects(
    new LiveAdminClient(async () =>
      Response.json(receipt),
    ).saveRuneLiteSettings(
      { expectedRevision: 'runelite-2', ...rules },
      'csrf',
      signal(),
    ),
    /Unexpected/u,
  );
});
test('preview RuneLite settings persist independently of display names, isolate returned arrays and reject stale writes', async () => {
  const client = new MemoryAdminClient();
  const initial = await client.runeLiteSettings(signal());
  const { revision, clanKeyRequirement, ...rules } = initial;
  assert.equal(clanKeyRequirement, undefined);
  const changed = await client.saveRuneLiteSettings(
    {
      expectedRevision: revision,
      ...rules,
      clanName: 'Game Clan',
      playerWhitelist: ['Player'],
    },
    'csrf',
    signal(),
  );
  changed.playerWhitelist.push('Injected');
  assert.deepEqual((await client.runeLiteSettings(signal())).playerWhitelist, [
    'Player',
  ]);
  assert.equal(client.publicSettings().clanName, 'Clan name');
  await assert.rejects(
    client.saveRuneLiteSettings(
      { expectedRevision: revision, ...rules },
      'csrf',
      signal(),
    ),
    { status: 409 },
  );
});
