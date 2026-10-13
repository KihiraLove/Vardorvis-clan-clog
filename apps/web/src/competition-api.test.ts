import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LiveCompetitionClient,
  PreviewCompetitionClient,
  parseWomCompetition,
} from './competition-api.ts';
import { PreviewAdminClient } from './preview/admin.ts';
import { PreviewXpClient } from './preview/xp.ts';
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
