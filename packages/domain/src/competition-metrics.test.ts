import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  competitionAmount,
  compareCompetitionAmounts,
  formatCompetitionAmount,
  parseCompetitionDefinitions,
  competitionUnit,
} from './competition-metrics.js';

test('scores preserve decimal precision, scientific numeric input and very large string counters', () => {
  assert.equal(competitionAmount(0.0000001), '0.0000001');
  assert.equal(
    competitionAmount('9007199254740993.1234500'),
    '9007199254740993.12345',
  );
  assert.equal(
    formatCompetitionAmount('9007199254740993.12345'),
    '9,007,199,254,740,993.12345',
  );
  assert.ok(
    compareCompetitionAmounts('9007199254740993.1', '9007199254740993.01') > 0,
  );
  assert.equal(compareCompetitionAmounts('2', '2.0'), 0);
  for (const value of [
    null,
    NaN,
    Infinity,
    -1,
    Number.MAX_SAFE_INTEGER + 1,
    '01',
    '1e9',
    '1.',
    '.5',
  ])
    assert.throws(() => competitionAmount(value));
  assert.throws(() => competitionAmount('1.01', true));
  assert.equal(competitionAmount('1.000', true), '1');
});
test('positive weights remain metadata, and units distinguish XP, kills, hours and weighted scores', () => {
  const defs = parseCompetitionDefinitions(
    [{ metric: 'attack', weight: 0.25 }],
    ['attack'],
  );
  assert.equal(defs[0]?.weight, '0.25');
  assert.equal(
    competitionUnit({ metrics: ['attack'], metricDefinitions: defs }),
    'Score',
  );
  assert.equal(competitionUnit({ metrics: ['attack', 'fishing'] }), 'XP');
  assert.equal(competitionUnit({ metrics: ['overall', 'attack'] }), 'Score');
  assert.equal(competitionUnit({ metrics: ['vardorvis', 'zulrah'] }), 'Kills');
  assert.equal(competitionUnit({ metrics: ['ehp', 'ehb'] }), 'Hours');
  for (const weight of [null, 0, -1, 'bad'])
    assert.throws(() =>
      parseCompetitionDefinitions([{ metric: 'attack', weight }], ['attack']),
    );
});
