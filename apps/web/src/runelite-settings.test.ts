import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultRuneLiteRules, parseRuneLiteSettings } from '@clog/domain';
import { LiveAdminClient } from './admin-api.ts';
import { PreviewAdminClient } from './preview/admin.ts';
const signal = () => new AbortController().signal;
test('private RuneLite adapter sends revisions and CSRF and validates canonical receipts', async () => {
  const rules = defaultRuneLiteRules('In-game Clan');
  rules.playerWhitelist = ['Player_One', 'player one'];
  const receipt = {
    revision: 'runelite-2',
    ...rules,
    playerWhitelist: ['player one'],
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
    });
    return Response.json(receipt);
  });
  assert.deepEqual(
    await client.saveRuneLiteSettings(
      { expectedRevision: 'runelite-1', ...rules },
      'csrf',
      signal(),
    ),
    receipt,
  );
  for (const bad of [
    { ...receipt, revision: 'bad' },
    { ...receipt, matchClanName: 1 },
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
  const client = new PreviewAdminClient();
  const initial = await client.runeLiteSettings(signal());
  const { revision, ...rules } = initial;
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
