import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LiveCompetitionClient,
  PreviewCompetitionClient,
  parseWomCompetition,
} from './competition-api.ts';
import { PreviewAdminClient } from './preview/admin.ts';
import { PreviewXpClient } from './preview/xp.ts';
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
test('preview mode detects stable skill and activity fixture metadata without a caller kind', async () => {
  const client = new PreviewCompetitionClient(undefined, new PreviewXpClient());
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
test('preview mode enforces staff access and the administrator-only finished XP boundary', async (t) => {
  const admin = new PreviewAdminClient();
  const session = (await admin.session(signal()))!;
  const mocked = t.mock.method(admin, 'session', async () => ({
    ...session,
    role: 'moderator' as const,
  }));
  const client = new PreviewCompetitionClient(admin, new PreviewXpClient());
  await assert.rejects(client.preview(url(1001), 'csrf', signal()), {
    status: 403,
  });
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
  const admin = new PreviewAdminClient();
  const session = (await admin.session(signal()))!;
  t.mock.method(admin, 'session', async () => ({
    ...session,
    role: 'moderator' as const,
  }));
  const xp = new PreviewXpClient();
  const client = new PreviewCompetitionClient(admin, xp, (c) =>
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

test('preview receipt replay enforces current authentication and the original finished XP role', async (t) => {
  const admin = new PreviewAdminClient();
  const session = (await admin.session(signal()))!;
  const mocked = t.mock.method(
    admin,
    'session',
    async (): Promise<AdminSession | null> => session,
  );
  const client = new PreviewCompetitionClient(admin, new PreviewXpClient());
  const p = await client.preview(url(1001), 'csrf', signal());
  const key = crypto.randomUUID();
  await client.apply(p, 'csrf', key, false, signal());
  mocked.mock.mockImplementation(async () => ({
    ...session,
    role: 'moderator' as const,
  }));
  await assert.rejects(client.apply(p, 'csrf', key, false, signal()), {
    status: 403,
  });
  mocked.mock.mockImplementation(async () => null);
  await assert.rejects(client.apply(p, 'csrf', key, false, signal()), {
    status: 401,
  });
});
