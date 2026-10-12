import assert from 'node:assert/strict';
import { test } from 'node:test';
import { competitionLifecycle } from '@clog/domain';
import { fetchCompetition, mappedPages } from './competition-wom.js';
import { rankPodium } from './xp-store.js';
import { fetchWomCompetition } from './wom.js';
const now = Date.parse('2026-10-12T12:00:00Z');
const fixture = (
  metric = 'vardorvis',
  start = now - 1000,
  end = now + 1000,
) => ({
  id: 123,
  title: 'Boss week',
  metrics: [{ metric }],
  startsAt: new Date(start).toISOString(),
  endsAt: new Date(end).toISOString(),
  updatedAt: new Date(now).toISOString(),
  participantCount: 2,
  participations: [
    {
      playerId: 1,
      player: { displayName: 'Winner' },
      deltas: [{ metric, values: { gained: '9007199254740993' } }],
    },
    {
      playerId: 2,
      player: { displayName: 'Zero' },
      deltas: [{ metric, values: { gained: 0 } }],
    },
  ],
});
const request =
  (source: unknown): typeof fetch =>
  async () =>
    Response.json(source);
test('lifecycle boundaries include start and exclude end', () => {
  const c = {
    startsAt: new Date(now).toISOString(),
    endsAt: new Date(now + 100).toISOString(),
  };
  assert.equal(competitionLifecycle(c, now - 1), 'future');
  assert.equal(competitionLifecycle(c, now), 'running');
  assert.equal(competitionLifecycle(c, now + 99), 'running');
  assert.equal(competitionLifecycle(c, now + 100), 'finished');
});
test('future/running fetch discards live roster, gains, snapshots and unnecessary breakdown requests', async () => {
  for (const kind of ['SKILL', 'ACTIVITY'] as const)
    for (const start of [now - 1000, now + 1000]) {
      const source = fixture(
        kind === 'SKILL' ? 'overall' : 'vardorvis',
        start,
        now + 2000,
      );
      source.participations = [];
      source.participantCount = 10000;
      let calls = 0;
      const snapshot = await fetchCompetition(
        'https://wiseoldman.net/competitions/123',
        kind,
        now,
        async () => {
          calls++;
          return Response.json({ ...source, private: 'raw-source-secret' });
        },
      );
      assert.equal(calls, 1);
      assert.deepEqual(Object.keys(snapshot).sort(), [
        'competition',
        'lifecycle',
        'skills',
      ]);
      assert.equal(
        JSON.stringify(snapshot).includes('raw-source-secret'),
        false,
      );
      assert.equal(snapshot.results, undefined);
    }
});
test('finished activity results discard zeros, preserve integer precision and reject missing/partial results', async () => {
  const source = fixture('vardorvis', now - 2000, now);
  const snapshot = await fetchCompetition(
    'https://wiseoldman.net/competitions/123',
    'ACTIVITY',
    now,
    request(source),
  );
  assert.deepEqual(snapshot.results?.participants, [
    { playerId: 1, displayName: 'Winner', gained: '9007199254740993' },
  ]);
  for (const gained of [null, -1, 1.1, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(
      fetchCompetition(
        'https://wiseoldman.net/competitions/123',
        'ACTIVITY',
        now,
        request({
          ...source,
          participations: [
            {
              ...source.participations[0],
              deltas: [{ metric: 'vardorvis', values: { gained } }],
            },
          ],
          participantCount: 1,
        }),
      ),
      { status: 422 },
    );
  await assert.rejects(
    fetchCompetition(
      'https://wiseoldman.net/competitions/123',
      'ACTIVITY',
      now,
      request({ ...source, participantCount: 3 }),
    ),
    { status: 422 },
  );
});
test('explicit kinds validate their metrics; they are never inferred from source', async () => {
  await assert.rejects(
    fetchCompetition(
      'https://wiseoldman.net/competitions/123',
      'SKILL',
      now,
      request(fixture()),
    ),
    { status: 422 },
  );
  await assert.rejects(
    fetchCompetition(
      'https://wiseoldman.net/competitions/123',
      'ACTIVITY',
      now,
      request(fixture('attack')),
    ),
    { status: 422 },
  );
  for (const m of ['ehb', 'unknown_metric'])
    await assert.rejects(
      fetchCompetition(
        'https://wiseoldman.net/competitions/123',
        'ACTIVITY',
        now,
        request(fixture(m)),
      ),
      { status: 422 },
    );
});
test('multi-skill results keep individual contributions and omit players whose relevant sum is zero', async () => {
  const source = fixture('overall', now - 2000, now);
  const skills = ['attack', 'fishing'];
  source.metrics = skills.map((metric) => ({ metric }));
  const details = {
    ...source,
    participations: source.participations.map((p, i) => ({
      ...p,
      deltas: [
        ...skills.map((metric) => ({
          metric,
          values: { gained: i === 0 ? '10' : '0' },
        })),
        { metric: 'total', values: { gained: 999 } },
      ],
    })),
  };
  let calls = 0;
  const snapshot = await fetchCompetition(
    'https://wiseoldman.net/competitions/123',
    'SKILL',
    now,
    async (input) => {
      calls++;
      if (calls === 2) {
        assert.match(String(input), /metrics=attack&metrics=fishing/u);
        return Response.json(details);
      }
      return Response.json(source);
    },
  );
  assert.deepEqual(snapshot.results?.xp?.event.gains, {
    attack: '10',
    fishing: '10',
  });
  assert.equal(snapshot.results?.xp?.participants.length, 1);
  assert.equal(snapshot.results?.participants[0]?.gained, '20');
  const legacy = await fetchWomCompetition(
    'https://wiseoldman.net/competitions/123',
    async (input) => {
      if (String(input).includes('?')) {
        assert.match(String(input), /metrics=attack&metrics=fishing$/u);
        return Response.json(details);
      }
      return Response.json(source);
    },
  );
  assert.deepEqual(legacy.event.gains, { attack: '10', fishing: '10' });
});
test('page aliases respect current shared pages and ambiguous metrics require staff pages', () => {
  assert.deepEqual(mappedPages('dagannoth_rex'), ['dagannoth_kings']);
  assert.deepEqual(mappedPages('artio'), ['callisto_and_artio']);
  assert.deepEqual(mappedPages('theatre_of_blood_hard_mode'), [
    'theatre_of_blood',
  ]);
  assert.deepEqual(mappedPages('collections_logged'), []);
  assert.deepEqual(mappedPages('attack'), []);
  assert.equal(
    mappedPages('clue_scrolls_all').includes('master_treasure_trails'),
    true,
  );
});
test('podium ranks exact integers, uses stable ID ties and fills only actual positive places', () => {
  const p = (playerId: number, gained: string) => ({
    playerId,
    displayName: 'P' + playerId,
    gained,
  });
  assert.deepEqual(
    rankPodium([
      p(3, '9007199254740993'),
      p(2, '9007199254740993'),
      p(1, '0'),
      p(4, '9007199254740994'),
    ]).map((p) => p.playerId),
    [4, 2, 3],
  );
  assert.equal(rankPodium([p(1, '0')]).length, 0);
  assert.equal(rankPodium([p(1, '1')]).length, 1);
});
