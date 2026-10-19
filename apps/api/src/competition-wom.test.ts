import assert from 'node:assert/strict';
import { test } from 'node:test';
import { competitionLifecycle, skillIds } from '@clog/domain';
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
        now,
        async () => {
          calls++;
          return Response.json({ ...source, private: 'raw-source-secret' });
        },
      );
      assert.equal(calls, 1);
      assert.equal(snapshot.competition.kind, kind);
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
    now,
    request(source),
  );
  assert.deepEqual(snapshot.results?.participants, [
    {
      playerId: 1,
      displayName: 'Winner',
      gained: '9007199254740993',
      rank: 1,
      deltas: [{ metric: 'vardorvis', gained: '9007199254740993' }],
    },
  ]);
  for (const gained of [null, -1, 1.1, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(
      fetchCompetition(
        'https://wiseoldman.net/competitions/123',
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
      now,
      request({ ...source, participantCount: 3 }),
    ),
    { status: 422 },
  );
});
test('all supported single skills are inferred from metadata and preserve exact finished XP', async () => {
  for (const skill of skillIds) {
    const snapshot = await fetchCompetition(
      'https://wiseoldman.net/competitions/123',
      now,
      request(fixture(skill, now - 2000, now)),
    );
    assert.equal(snapshot.competition.kind, 'SKILL');
    assert.deepEqual(snapshot.skills, [skill]);
    assert.equal(snapshot.results?.xp?.event.gains[skill], '9007199254740993');
    assert.equal(snapshot.results?.participants[0]?.gained, '9007199254740993');
  }
});
test('unknown metrics, mixed WOM types and invalid weights fail explicitly', async () => {
  for (const metrics of [
    ['unknown_metric'],
    ['attack', 'vardorvis'],
    ['total', 'ehp'],
    ['vardorvis', 'clue_scrolls_all'],
  ])
    await assert.rejects(
      fetchCompetition(
        'https://wiseoldman.net/competitions/123',
        now,
        request({
          ...fixture(),
          metrics: metrics.map((metric) => ({ metric })),
        }),
      ),
      { status: 422 },
    );
  for (const weight of [0, -1, null, {}, 'not-a-weight'])
    await assert.rejects(
      fetchCompetition(
        'https://wiseoldman.net/competitions/123',
        now,
        request({ ...fixture(), metrics: [{ metric: 'vardorvis', weight }] }),
      ),
      { status: 422 },
    );
});
test('overall and total scopes fetch one complete skill batch and ignore aggregate scores', async () => {
  for (const aggregate of ['overall', 'total']) {
    const source = fixture(aggregate, now - 2000, now);
    const details = {
      ...source,
      metrics: skillIds.map((metric) => ({ metric, weight: 1 })),
      participations: source.participations.map((p, i) => ({
        ...p,
        deltas: [
          ...skillIds.map((metric) => ({
            metric,
            values: {
              gained: i === 0 && metric === 'mining' ? '9007199254740993' : '0',
            },
          })),
          { metric: 'total', values: { gained: '99999999999999999' } },
        ],
      })),
    };
    const urls: string[] = [];
    const snapshot = await fetchCompetition(
      'https://wiseoldman.net/competitions/123',
      now,
      async (input) => {
        urls.push(String(input));
        return Response.json(urls.length === 1 ? source : details);
      },
    );
    assert.equal(snapshot.competition.kind, 'SKILL');
    assert.deepEqual(snapshot.skills, [...skillIds]);
    assert.equal(urls.length, 2);
    assert.deepEqual(new URL(urls[1]!).searchParams.getAll('metrics'), [
      ...skillIds,
    ]);
    assert.equal(snapshot.results?.participants[0]?.gained, '9007199254740993');
    assert.equal(
      Object.hasOwn(snapshot.results!.xp!.event.gains, 'total'),
      false,
    );
    await assert.rejects(
      fetchCompetition(
        'https://wiseoldman.net/competitions/123',
        now,
        async (input) =>
          Response.json(
            String(input).includes('?')
              ? { ...details, participantCount: 3 }
              : source,
          ),
      ),
      { status: 422 },
    );
  }
});
test('multi-skill results keep individual contributions and omit players whose relevant sum is zero', async () => {
  const source = fixture('overall', now - 2000, now);
  const skills = ['attack', 'fishing'];
  source.metrics = skills.map((metric) => ({ metric }));
  source.participations = source.participations.map((p, i) => ({
    ...p,
    deltas: [
      ...skills.map((metric) => ({
        metric,
        values: { gained: i === 0 ? '10' : '0' },
      })),
      { metric: 'total', values: { gained: i === 0 ? '20' : '0' } },
    ],
  }));
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

test('multi-boss, multi-activity and computed competitions retain every delta and WOM combined score', async () => {
  for (const [metrics, values] of [
    [
      ['vardorvis', 'zulrah'],
      ['10', '20', '30'],
    ],
    [
      ['clue_scrolls_hard', 'clue_scrolls_elite'],
      ['3', '5', '8'],
    ],
    [
      ['ehp', 'ehb'],
      ['1.25', '2.5', '3.75'],
    ],
  ] as const) {
    const source = {
      ...fixture('vardorvis', now - 2000, now),
      metrics: metrics.map((metric) => ({ metric, weight: 1 })),
      participantCount: 1,
      participations: [
        {
          playerId: 1,
          player: { displayName: 'Winner' },
          deltas: [...metrics, 'total'].map((metric, i) => ({
            metric,
            values: { gained: values[i] },
          })),
        },
      ],
    };
    const result = await fetchCompetition(
      'https://wiseoldman.net/competitions/123',
      now,
      request(source),
    );
    assert.equal(result.results?.participants[0]?.gained, values[2]);
    assert.equal(result.results?.participants[0]?.deltas?.length, 3);
    assert.equal(result.results?.xp, undefined);
    assert.deepEqual(
      result.competition.metricDefinitions?.map((d) => d.weight),
      ['1', '1'],
    );
    for (const deltas of [
      source.participations[0]!.deltas.slice(0, 2),
      [
        source.participations[0]!.deltas[0],
        source.participations[0]!.deltas[0],
        source.participations[0]!.deltas[2],
      ],
    ])
      await assert.rejects(
        fetchCompetition(
          'https://wiseoldman.net/competitions/123',
          now,
          request({
            ...source,
            participations: [{ ...source.participations[0], deltas }],
          }),
        ),
        { status: 422 },
      );
  }
});

test('weighted skill standings use WOM scores while the tracker receives only raw skill XP', async () => {
  const source = {
    ...fixture('attack', now - 2000, now),
    metrics: [
      { metric: 'attack', weight: 0.25 },
      { metric: 'fishing', weight: 2 },
    ],
    participations: [
      {
        playerId: 2,
        player: { displayName: 'Weighted winner' },
        deltas: [
          { metric: 'attack', values: { gained: 0 } },
          { metric: 'fishing', values: { gained: 20 } },
          { metric: 'total', values: { gained: 40 } },
        ],
      },
      {
        playerId: 1,
        player: { displayName: 'Most XP' },
        deltas: [
          { metric: 'attack', values: { gained: 100 } },
          { metric: 'fishing', values: { gained: 0 } },
          { metric: 'total', values: { gained: 25 } },
        ],
      },
    ],
  };
  const result = await fetchCompetition(
    'https://wiseoldman.net/competitions/123',
    now,
    request(source),
  );
  assert.deepEqual(result.results?.xp?.event.gains, {
    attack: '100',
    fishing: '20',
  });
  assert.equal(result.results?.participants[0]?.displayName, 'Weighted winner');
  assert.equal(result.results?.participants[0]?.gained, '40');
  assert.equal(result.competition.metricDefinitions?.[0]?.weight, '0.25');
  const changed = await fetchCompetition(
    'https://wiseoldman.net/competitions/123',
    now,
    request({
      ...source,
      metrics: [
        { metric: 'attack', weight: 0.5 },
        { metric: 'fishing', weight: 2 },
      ],
    }),
  );
  assert.notEqual(
    changed.results?.xp?.sourceHash,
    result.results?.xp?.sourceHash,
  );
  assert.deepEqual(
    changed.results?.xp?.event.gains,
    result.results?.xp?.event.gains,
  );
});

test('overall plus a skill retains the combined score but expands raw XP only once', async () => {
  const source = {
    ...fixture('overall', now - 2000, now),
    metrics: [{ metric: 'overall' }, { metric: 'attack' }],
    participantCount: 1,
    participations: [
      {
        playerId: 1,
        player: { displayName: 'Winner' },
        deltas: [
          { metric: 'overall', values: { gained: 100 } },
          { metric: 'attack', values: { gained: 10 } },
          { metric: 'total', values: { gained: 110 } },
        ],
      },
    ],
  };
  const breakdown = {
    ...source,
    participations: [
      {
        ...source.participations[0],
        deltas: skillIds.map((metric) => ({
          metric,
          values: {
            gained: metric === 'attack' ? 10 : metric === 'mining' ? 90 : 0,
          },
        })),
      },
    ],
  };
  const result = await fetchCompetition(
    'https://wiseoldman.net/competitions/123',
    now,
    async (url) =>
      Response.json(String(url).includes('?') ? breakdown : source),
  );
  assert.equal(result.results?.participants[0]?.gained, '110');
  assert.equal(
    Object.values(result.results!.xp!.event.gains).reduce(
      (n, v) => n + BigInt(v!),
      0n,
    ),
    100n,
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
