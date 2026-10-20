import assert from 'node:assert/strict';
import { test } from 'node:test';
import { competitionScope } from './competitions.js';
import {
  competitionMetricType,
  competitionUnit,
  competitionUsesPages,
  parseCustomCompetitionMetric,
  parseCompetitionDefinitions,
  parseCompetitionStandings,
} from './competition-metrics.js';

test('saved definitions preserve scope, numeric precision, units and page behavior without a global registry', () => {
  for (const [type, kind, unit, pages] of [
    ['BOSS', 'ACTIVITY', 'Kills', true],
    ['ACTIVITY', 'ACTIVITY', 'Score', true],
    ['COMPUTED', 'ACTIVITY', 'Hours', false],
    ['SKILL', 'SKILL', 'XP', false],
  ] as const) {
    const definition = parseCustomCompetitionMetric({
      metric: 'new_metric',
      name: 'New metric',
      type,
      pageIds: pages ? ['raid'] : [],
      ...(type === 'SKILL' ? { skill: 'attack' } : {}),
    });
    const definitions = parseCompetitionDefinitions(
      [{ metric: definition.metric, weight: '1', definition }],
      [definition.metric],
    );
    assert.equal(competitionMetricType(definition.metric, definitions), type);
    assert.equal(competitionScope([definition.metric], definitions).kind, kind);
    assert.equal(
      competitionUnit({
        metrics: [definition.metric],
        metricDefinitions: definitions,
      }),
      unit,
    );
    assert.equal(competitionUsesPages([definition.metric], definitions), pages);
    const value =
      type === 'COMPUTED' ? '9007199254740993.125' : '9007199254740993';
    const row = {
      playerId: 1,
      displayName: 'Player',
      gained: value,
      deltas: [{ metric: definition.metric, gained: value }],
    };
    assert.equal(
      parseCompetitionStandings([row], [definition.metric], definitions)[0]
        ?.gained,
      value,
    );
    if (type !== 'COMPUTED')
      assert.throws(
        () =>
          parseCompetitionStandings(
            [{ playerId: 1, displayName: 'Player', gained: '1.5' }],
            [definition.metric],
            definitions,
          ),
        /integers/,
      );
    if (type !== 'COMPUTED')
      assert.throws(
        () =>
          parseCompetitionStandings(
            [
              {
                ...row,
                gained: '1.5',
                deltas: [{ metric: definition.metric, gained: '1.5' }],
              },
            ],
            [definition.metric],
            definitions,
          ),
        /integers/,
      );
    if (type === 'SKILL') {
      assert.deepEqual(
        competitionScope([definition.metric], definitions).skills,
        ['attack'],
      );
      assert.throws(
        () => competitionScope([definition.metric, 'attack'], definitions),
        /duplicate/,
      );
    }
  }
  assert.throws(() => competitionScope(['new_metric']), /Unknown/);
});

test('custom definitions reject invalid types, unknown skill targets, duplicate pages and mismatched snapshots', () => {
  const base = {
    metric: 'new_metric',
    name: 'New metric',
    type: 'BOSS',
    pageIds: [],
  };
  for (const fields of [
    { type: 'INVALID' },
    { metric: 'bad/key' },
    { name: ' ' },
    { pageIds: ['x', 'x'] },
    { type: 'SKILL', skill: 'invented_skill' },
    { type: 'SKILL', skill: 'attack', pageIds: ['x'] },
    { type: 'COMPUTED', pageIds: ['x'] },
    { skill: 'attack' },
  ])
    assert.throws(() => parseCustomCompetitionMetric({ ...base, ...fields }));
  assert.throws(
    () =>
      parseCompetitionDefinitions(
        [{ metric: 'new_metric', definition: { ...base, metric: 'other' } }],
        ['new_metric'],
      ),
    /key/,
  );
  const definitions = [
    {
      metric: 'new_metric',
      weight: '1',
      definition: parseCustomCompetitionMetric(base),
    },
  ];
  assert.throws(
    () => competitionScope(['new_metric', 'ehp'], definitions),
    /Mixed/,
  );
});
