import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseClanKey } from './clan-api-key.ts';
import { MemoryAdminClient } from '../tests/support/admin.ts';
import { LiveAdminClient } from './admin-api.ts';
const signal = () => new AbortController().signal;

test('preview keys default on and can be viewed and rotated while the requirement is disabled', async () => {
  const client = new MemoryAdminClient();
  const initial = await client.clanApiKey(signal());
  assert.equal(initial.enabled, true);
  assert.match(initial.key, /^[a-f0-9]{32}$/u);
  const disabled = await client.saveClanApiKey(
    { expectedRevision: initial.revision, enabled: false },
    'csrf',
    signal(),
  );
  assert.equal(disabled.key, initial.key);
  const generated = await client.saveClanApiKey(
    { expectedRevision: disabled.revision, generate: true },
    'csrf',
    signal(),
  );
  assert.equal(generated.enabled, false);
  assert.notEqual(generated.key, initial.key);
  const custom = await client.saveClanApiKey(
    {
      expectedRevision: generated.revision,
      key: ' key! 😀\n123 ',
    },
    'csrf',
    signal(),
  );
  assert.equal(custom.enabled, false);
  assert.equal(custom.key, ' key! 😀\n123 ');
  const enabled = await client.saveClanApiKey(
    { expectedRevision: custom.revision, enabled: true },
    'csrf',
    signal(),
  );
  assert.equal(enabled.key, custom.key);
  assert.equal(enabled.enabled, true);
  assert.deepEqual(Object.keys(client.publicSettings()).sort(), [
    'clanName',
    'copy',
    'hardcore',
    'hardcoreEnabled',
    'howToSubmitMarkdown',
    'revision',
  ]);
  await assert.rejects(
    client.saveClanApiKey(
      { expectedRevision: initial.revision, generate: true },
      'csrf',
      signal(),
    ),
    { status: 409 },
  );
});
test('private key reads/writes preserve CSRF, revisions and the supplied value, and reject bad receipts', async () => {
  const settings = {
    revision: 'clan-key-2',
    enabled: false,
    key: ' key! 😀\n123 ',
  };
  const client = new LiveAdminClient(async (path, options) => {
    assert.equal(path, '/api/v1/admin/clan-api-key');
    assert.equal(options?.cache, 'no-store');
    assert.equal(options?.credentials, 'same-origin');
    if (options?.method === 'PUT') {
      assert.equal(
        (options.headers as Record<string, string>)['X-CSRF-Token'],
        'csrf',
      );
      assert.deepEqual(JSON.parse(String(options.body)), {
        expectedRevision: 'clan-key-1',
        key: settings.key,
      });
    }
    return Response.json(settings);
  });
  assert.deepEqual(await client.clanApiKey(signal()), settings);
  assert.deepEqual(
    await client.saveClanApiKey(
      { expectedRevision: 'clan-key-1', key: settings.key },
      'csrf',
      signal(),
    ),
    settings,
  );
  for (const bad of [
    { ...settings, key: '' },
    { ...settings, key: '\r\nbad' },
    { ...settings, enabled: 'false' },
    { ...settings, revision: 'wrong' },
  ])
    assert.throws(() => parseClanKey(bad), /Invalid/u);
  await assert.rejects(
    new LiveAdminClient(async () => Response.json(settings)).saveClanApiKey(
      { expectedRevision: 'clan-key-2', generate: true },
      'csrf',
      signal(),
    ),
    /Unexpected/u,
  );
});
