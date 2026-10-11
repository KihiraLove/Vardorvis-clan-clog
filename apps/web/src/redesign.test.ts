import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PreviewAdminClient } from './preview/admin.ts';
import { PreviewXpClient } from './preview/xp.ts';
import { LiveXpClient } from './xp-api.ts';
import { LiveAdminClient } from './admin-api.ts';
import { parseSettings } from './site-settings.ts';
import { parseTracker, eventTotals, sumXp } from './xp-tracker.ts';
import { skills, zeroTotals } from './xp-model.ts';
const signal = () => new AbortController().signal;
test('hardcore release flag defaults off, is versioned, preserves credits and rejects stale saves', async () => {
  const client = new PreviewAdminClient();
  const initial = await client.settings(signal());
  assert.equal(initial.hardcoreEnabled, false);
  await client.decide('sample-hardcore', 1, 'approve', '', 'preview', signal());
  const queue = await client.queue('pending', undefined, signal());
  const next = await client.saveSettings(
    true,
    initial.revision,
    'preview',
    signal(),
  );
  assert.equal(client.publicSettings().hardcoreEnabled, true);
  assert.ok(queue.nextCursor);
  assert.equal(
    (await client.queue('pending', queue.nextCursor!, signal())).submissions
      .length,
    1,
  );
  await assert.rejects(
    client.saveSettings(false, initial.revision, 'preview', signal()),
    { status: 409 },
  );
  await client.saveSettings(false, next.revision, 'preview', signal());
  assert.equal(client.publicLog().collections.credits.length, 1);
  await client.logout('preview', signal());
  await assert.rejects(client.settings(signal()), { status: 401 });
  assert.throws(() =>
    parseSettings({ revision: 'one', hardcoreEnabled: 'false' }),
  );
});
test('duplicate approval and moving an approved credit into an occupied mode are rejected', async () => {
  const client = new PreviewAdminClient();
  const first = await client.decide(
    'sample-ordinary',
    1,
    'approve',
    '',
    'preview',
    signal(),
  );
  const second = await client.edit(
    'sample-unmatched',
    1,
    {
      itemId: first.itemId!,
      collectorName: 'Second',
      collectedOn: '2026-10-06',
      hardcore: false,
      reason: '',
    },
    'preview',
    signal(),
  );
  await assert.rejects(
    client.decide(
      second.id,
      second.version,
      'approve',
      '',
      'preview',
      signal(),
    ),
    { status: 409 },
  );
  const hc = await client.decide(
    'sample-hardcore',
    1,
    'approve',
    '',
    'preview',
    signal(),
  );
  await assert.rejects(
    client.edit(
      hc.id,
      hc.version,
      {
        itemId: hc.itemId!,
        collectorName: hc.collectorName,
        collectedOn: hc.collectedOn,
        hardcore: false,
        reason: 'Move worlds',
      },
      'preview',
      signal(),
    ),
    { status: 409 },
  );
  await client.decide(
    first.id,
    first.version,
    'revoke',
    'Wrong collector',
    'preview',
    signal(),
  );
  await client.decide(
    second.id,
    second.version,
    'approve',
    '',
    'preview',
    signal(),
  );
  assert.equal(client.publicLog().collections.credits.length, 2);
});
test('tracker exposes only aggregate event gains, supports single/all skills and repeat refreshes', async () => {
  const client = new PreviewXpClient();
  assert.equal((await client.tracker(signal())).events.length, 0);
  await client.samples();
  const first = parseTracker(await client.tracker(signal()));
  assert.equal(first.events[0]!.skills.length, 1);
  assert.equal(first.events[1]!.skills.length, skills.length);
  assert.equal(eventTotals(first.events[0]!).fishing, '0');
  assert.equal(first.totals.attack, '18345678');
  await client.samples();
  assert.deepEqual((await client.tracker(signal())).totals, first.totals);
  assert.throws(() =>
    parseTracker({
      ...first,
      events: [{ ...first.events[0], skills: ['attack', 'fishing'] }],
    }),
  );
  assert.throws(() =>
    parseTracker({ ...first, events: [first.events[0], first.events[0]] }),
  );
  assert.equal(
    sumXp({ ...zeroTotals(), attack: '9007199254740993' }),
    '9007199254740993',
  );
  assert.equal(sumXp({ ...zeroTotals(), attack: null }), null);
});
test('aggregate tracker ETag commits only a validated complete payload', async () => {
  const preview = new PreviewXpClient();
  await preview.samples();
  const data = await preview.tracker(signal());
  let phase = 0;
  const client = new LiveXpClient(async (path, options) => {
    assert.equal(path, '/api/v1/xp/tracker');
    if (phase === 2) {
      assert.equal(
        (options?.headers as Record<string, string>)['If-None-Match'],
        'good',
      );
      return new Response(null, { status: 304 });
    }
    return new Response(
      JSON.stringify(phase === 1 ? { ...data, totals: { attack: '1' } } : data),
      { headers: { ETag: phase === 1 ? 'bad' : 'good' } },
    );
  });
  await client.tracker(signal());
  phase = 1;
  await assert.rejects(client.tracker(signal()));
  phase = 2;
  assert.deepEqual(await client.tracker(signal()), data);
});
test('admin setting writes carry CSRF and revision and validate saved visibility', async () => {
  const client = new LiveAdminClient(async (path, options) => {
    assert.equal(path, '/api/v1/admin/settings');
    assert.equal(options?.method, 'PUT');
    assert.equal(
      (options?.headers as Record<string, string>)['X-CSRF-Token'],
      'csrf',
    );
    assert.deepEqual(JSON.parse(options?.body as string), {
      hardcoreEnabled: true,
      expectedRevision: 'settings-1',
    });
    return Response.json({
      revision: 'settings-2',
      clanName: 'Vardorvis',
      hardcoreEnabled: true,
    });
  });
  assert.equal(
    (await client.saveSettings(true, 'settings-1', 'csrf', signal()))
      .hardcoreEnabled,
    true,
  );
});
