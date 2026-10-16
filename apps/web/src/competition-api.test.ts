import { MemoryCompetitionClient } from '../tests/support/competition.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LiveCompetitionClient,
  parseWomCompetition,
} from './competition-api.ts';
import { MemoryAdminClient } from '../tests/support/admin.ts';
import { MemoryXpClient } from '../tests/support/xp.ts';
import type { AdminSession } from './xp-model.ts';
const signal = () => new AbortController().signal;
const url = (id: number) => 'https://wiseoldman.net/competitions/' + id;
const competition = {
  id: 123,
  kind: 'SKILL',
  title: 'XP week',
  sourceUrl: url(123),
  metrics: ['attack', 'fishing'],
  startsAt: '2026-10-01T00:00:00Z',
  endsAt: '2026-10-08T00:00:00Z',
};

test('activity revalidation retains metadata identity, refreshes the clock and rejects malformed or aborted updates', async (t) => {
  const client = new LiveCompetitionClient();
  const data = {
    serverNow: '2026-10-14T12:00:00Z',
    competitions: [
      { ...competition, kind: 'ACTIVITY', metrics: ['vardorvis'] },
    ],
  };
  let response = Response.json(data, { headers: { ETag: 'W/"a"' } });
  let sent: string | undefined;
  t.mock.method(
    globalThis,
    'fetch',
    async (_path: string, options: RequestInit) => {
      sent = (options.headers as Record<string, string>)['If-None-Match'];
      return response;
    },
  );
  const first = await client.activities(signal());
  response = new Response(null, {
    status: 304,
    headers: { 'X-Server-Now': '2026-10-14T12:01:00Z' },
  });
  const next = await client.activities(signal());
  assert.equal(sent, 'W/"a"');
  assert.equal(next.competitions, first.competitions);
  assert.equal(next.serverNow, '2026-10-14T12:01:00Z');
  // Browser-managed revalidation can expose the cached body as 200 with fresh headers.
  response = Response.json(
    {},
    { headers: { ETag: 'W/"a"', 'X-Server-Now': '2026-10-14T12:02:00Z' } },
  );
  assert.equal(
    (await client.activities(signal())).competitions,
    first.competitions,
  );
  response = Response.json(
    { ...data, competitions: [competition] },
    { headers: { ETag: 'W/"bad"' } },
  );
  await assert.rejects(client.activities(signal()));
  response = Response.json(data, { headers: { ETag: 'W/"canceled"' } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.activities(controller.signal));
  response = new Response(null, {
    status: 304,
    headers: { 'X-Server-Now': '2026-10-14T12:03:00Z' },
  });
  assert.equal(
    (await client.activities(signal())).competitions,
    first.competitions,
  );
  assert.equal(sent, 'W/"a"');
});
test('live preview sends only the canonical link and optional pages, preserving detected kind and exact integer gains', async (t) => {
  const bodies: unknown[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: string, options: RequestInit) => {
      bodies.push(JSON.parse(options.body as string));
      assert.equal(
        (options.headers as Record<string, string>)['X-CSRF-Token'],
        'csrf',
      );
      return Response.json({
        previewToken: 'token',
        expectedRevision: 'xp-1',
        scheduleRevision: 'schedules-1',
        expiresAt: '2099-01-01T00:00:00Z',
        competition,
        lifecycle: 'finished',
        action: 'import-results',
        scheduleStartsAt: null,
        pageIds: [],
        pages: [],
        participants: [
          {
            playerId: 1,
            displayName: 'Winner',
            gains: { attack: '9007199254740993', fishing: '7' },
          },
        ],
        changes: [],
        warnings: [],
      });
    },
  );
  const client = new LiveCompetitionClient();
  const p = await client.preview(
    'https://www.wiseoldman.net/competitions/123/?x=1#results',
    'csrf',
    signal(),
  );
  assert.equal(p.competition.kind, 'SKILL');
  assert.equal(p.participants[0]!.gained, '9007199254741000');
  await client.preview(url(123), 'csrf', signal(), ['vardorvis']);
  assert.deepEqual(bodies, [
    { competitionUrl: url(123) },
    { competitionUrl: url(123), pageIds: ['vardorvis'] },
  ]);
  await assert.rejects(
    client.preview(url(124), 'csrf', signal()),
    /identity does not match/,
  );
});
test('client rejects a kind inconsistent with authoritative metric scope and unsupported mixed scopes', () => {
  assert.throws(
    () => parseWomCompetition({ ...competition, kind: 'ACTIVITY' }),
    /does not match/,
  );
  assert.throws(
    () =>
      parseWomCompetition({ ...competition, metrics: ['attack', 'vardorvis'] }),
    /unsupported/,
  );
  assert.equal(
    parseWomCompetition({
      ...competition,
      kind: 'ACTIVITY',
      metrics: ['vardorvis'],
    }).kind,
    'ACTIVITY',
  );
  assert.equal(
    parseWomCompetition({ ...competition, metrics: ['overall'] }).kind,
    'SKILL',
  );
});
test('fixture client detects stable skill and activity fixture metadata without a caller kind', async () => {
  const client = new MemoryCompetitionClient(undefined, new MemoryXpClient());
  const attack = await client.preview(url(1001), 'csrf', signal());
  const all = await client.preview(url(1002), 'csrf', signal());
  const activity = await client.preview(url(3002), 'csrf', signal());
  assert.equal(attack.competition.kind, 'SKILL');
  assert.deepEqual(attack.competition.metrics, ['attack']);
  assert.equal(all.competition.kind, 'SKILL');
  assert.equal(all.competition.metrics.length, 24);
  assert.equal(activity.competition.kind, 'ACTIVITY');
  assert.deepEqual(activity.changes, []);
});
test('fixture client permits moderator finished XP imports and still requires staff access', async (t) => {
  const admin = new MemoryAdminClient();
  const session = (await admin.session(signal()))!;
  const mocked = t.mock.method(admin, 'session', async () => ({
    ...session,
    role: 'moderator' as const,
  }));
  const client = new MemoryCompetitionClient(admin, new MemoryXpClient());
  assert.equal(
    (await client.preview(url(1001), 'csrf', signal())).competition.kind,
    'SKILL',
  );
  assert.equal(
    (await client.preview(url(1000), 'csrf', signal())).competition.kind,
    'SKILL',
  );
  assert.equal(
    (await client.preview(url(3002), 'csrf', signal())).competition.kind,
    'ACTIVITY',
  );
  mocked.mock.mockImplementation(async () => null);
  await assert.rejects(client.preview(url(3002), 'csrf', signal()), {
    status: 401,
  });
});

test('live SKILL metadata previews exclude pages, opening times, changes and live participants', async (t) => {
  const metadata = {
    previewToken: 'metadata-token',
    expectedRevision: 'xp-1',
    scheduleRevision: 'schedules-1',
    expiresAt: '2099-01-01T00:00:00Z',
    competition,
    lifecycle: 'running',
    action: 'import-metadata',
    scheduleStartsAt: null,
    pageIds: [],
    pages: [],
    participants: [],
    changes: [],
    warnings: [],
  };
  let response: unknown = metadata;
  t.mock.method(globalThis, 'fetch', async () => Response.json(response));
  const client = new LiveCompetitionClient();
  for (const lifecycle of ['future', 'running']) {
    response = { ...metadata, lifecycle };
    assert.equal(
      (await client.preview(url(123), 'csrf', signal())).action,
      'import-metadata',
    );
  }
  for (const extra of [
    { action: 'create-schedule' },
    { pageIds: ['vardorvis'] },
    { pages: [{ id: 'vardorvis', name: 'Vardorvis' }] },
    { scheduleStartsAt: competition.startsAt },
    { changes: [{ skill: 'attack', before: '0', after: '1', change: '1' }] },
    {
      participants: [{ playerId: 1, displayName: 'Live player', gained: '1' }],
    },
    { lifecycle: 'finished' },
    {
      competition: { ...competition, kind: 'ACTIVITY', metrics: ['vardorvis'] },
    },
  ]) {
    response = { ...metadata, ...extra };
    await assert.rejects(
      client.preview(url(123), 'csrf', signal()),
      /metadata/,
    );
  }
});

test('preview metadata imports preserve schedules and publish unavailable SKILL events without adding XP', async (t) => {
  const admin = new MemoryAdminClient();
  const session = (await admin.session(signal()))!;
  t.mock.method(admin, 'session', async () => ({
    ...session,
    role: 'moderator' as const,
  }));
  const xp = new MemoryXpClient();
  const client = new MemoryCompetitionClient(admin, xp, (c) =>
    xp.storeMetadata(c),
  );
  const before = await admin.scheduling(signal());
  for (const id of [1000, 1005]) {
    const p = await client.preview(url(id), 'csrf', signal());
    assert.equal(p.lifecycle, id === 1000 ? 'running' : 'future');
    assert.equal(p.action, 'import-metadata');
    assert.equal(p.scheduleStartsAt, null);
    assert.deepEqual(p.pageIds, []);
    assert.deepEqual(p.pages, []);
    assert.deepEqual(p.changes, []);
    assert.deepEqual(p.participants, []);
    const key = crypto.randomUUID();
    const receipt = await client.apply(p, 'csrf', key, false, signal());
    assert.deepEqual(
      await client.apply(p, 'csrf', key, false, signal()),
      receipt,
    );
    await assert.rejects(client.apply(p, 'csrf', key, true, signal()), {
      status: 409,
    });
    assert.equal(
      (
        await client.apply(
          await client.preview(url(id), 'csrf', signal()),
          'csrf',
          crypto.randomUUID(),
          false,
          signal(),
        )
      ).outcome,
      'unchanged',
    );
    await assert.rejects(
      client.preview(url(id), 'csrf', signal(), ['vardorvis']),
      { status: 422 },
    );
  }
  assert.deepEqual(await admin.scheduling(signal()), before);
  const tracker = await xp.tracker(signal());
  assert.equal(tracker.events.length, 2);
  assert.equal(tracker.totals.attack, '0');
  assert.deepEqual(tracker.podium, []);
  for (const event of tracker.events) {
    assert.equal(event.gains.attack, null);
    assert.deepEqual(event.podium, []);
  }
});

test('preview finished XP receipts remain replayable for moderators and require current authentication', async (t) => {
  const admin = new MemoryAdminClient();
  const session = (await admin.session(signal()))!;
  const mocked = t.mock.method(
    admin,
    'session',
    async (): Promise<AdminSession | null> => session,
  );
  const client = new MemoryCompetitionClient(admin, new MemoryXpClient());
  const p = await client.preview(url(1001), 'csrf', signal());
  const key = crypto.randomUUID();
  await client.apply(p, 'csrf', key, false, signal());
  mocked.mock.mockImplementation(async () => ({
    ...session,
    role: 'moderator' as const,
  }));
  assert.equal(
    (await client.apply(p, 'csrf', key, false, signal())).outcome,
    'applied',
  );
  mocked.mock.mockImplementation(async () => null);
  await assert.rejects(client.apply(p, 'csrf', key, false, signal()), {
    status: 401,
  });
});
