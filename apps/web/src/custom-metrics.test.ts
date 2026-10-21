import {
  UnknownMetricRequestError,
  parseMetricResolution,
} from './competition-import-api.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LiveCompetitionClient,
  parseWomCompetition,
} from './competition-api.ts';
import {
  competitionScope,
  competitionUnit,
  type CustomCompetitionMetric,
} from '@clog/domain';
import { parseTracker } from './xp-tracker.ts';
import { zeroTotals } from './xp-model.ts';

const sourceUrl = 'https://wiseoldman.net/competitions/123';
const prompt = {
  id: 123,
  title: 'New raid',
  sourceUrl,
  metrics: [{ metric: 'new_raid', weight: '1' }],
  unknownMetrics: ['new_raid'],
  startsAt: '2026-10-01T00:00:00Z',
  endsAt: '2026-11-01T00:00:00Z',
  resolutionToken: 'A'.repeat(43),
  revision: 'metrics-1',
  expiresAt: '2099-01-01T00:00:00Z',
  pages: [{ id: 'raid', name: 'Raid' }],
};
const definition: CustomCompetitionMetric = {
  metric: 'new_raid',
  name: 'New raid',
  type: 'BOSS',
  pageIds: ['raid'],
};

test('typed unknown-metric responses are validated and saves retain CSRF, key and exact registry revision', async (t) => {
  const client = new LiveCompetitionClient();
  const controller = new AbortController();
  const resolution = parseMetricResolution(prompt);
  let value: unknown = { code: 'UNKNOWN_WOM_METRICS', resolution: prompt };
  let status = 422;
  const sent: RequestInit[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: string, options: RequestInit) => {
      sent.push(options);
      return Response.json(value, { status });
    },
  );
  await assert.rejects(
    client.preview(sourceUrl, 'csrf', controller.signal),
    (e: unknown) =>
      e instanceof UnknownMetricRequestError && e.resolution.id === 123,
  );
  value = {
    code: 'UNKNOWN_WOM_METRICS',
    resolution: {
      ...prompt,
      id: 124,
      sourceUrl: 'https://wiseoldman.net/competitions/124',
    },
  };
  await assert.rejects(
    client.preview(sourceUrl, 'csrf', controller.signal),
    /does not match/,
  );
  value = { revision: 'metrics-2', savedMetrics: ['new_raid'] };
  status = 200;
  const key = crypto.randomUUID();
  await client.saveMetrics(
    resolution,
    [definition],
    key,
    'csrf',
    controller.signal,
  );
  const options = sent.at(-1)!;
  assert.equal(new Headers(options.headers).get('X-CSRF-Token'), 'csrf');
  assert.equal(new Headers(options.headers).get('Idempotency-Key'), key);
  assert.equal(options.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(String(options.body)), {
    resolutionToken: prompt.resolutionToken,
    expectedRevision: 'metrics-1',
    definitions: [definition],
  });
  value = { revision: 'metrics-2', savedMetrics: ['unrelated'] };
  await assert.rejects(
    client.saveMetrics(
      resolution,
      [definition],
      key,
      'csrf',
      controller.signal,
    ),
    /Unexpected metric save receipt/,
  );
  for (const fields of [
    { resolutionToken: 'bad' },
    { unknownMetrics: ['unrelated'] },
    { metrics: [] },
    { sourceUrl: 'https://example.com/competitions/123' },
  ])
    assert.throws(() => parseMetricResolution({ ...prompt, ...fields }));
});

test('public Activity and XP parsers accept frozen custom definitions and preserve their numeric meaning', () => {
  const competition = parseWomCompetition({
    ...prompt,
    kind: 'ACTIVITY',
    metrics: ['new_raid'],
    metricDefinitions: [{ metric: 'new_raid', weight: '1', definition }],
    standings: [
      {
        playerId: 1,
        displayName: 'Winner',
        gained: '5',
        deltas: [{ metric: 'new_raid', gained: '5' }],
      },
    ],
  });
  assert.equal(competitionUnit(competition), 'Kills');
  assert.equal(
    competition.metricDefinitions?.[0]?.definition?.name,
    definition.name,
  );
  assert.throws(
    () => parseWomCompetition({ ...competition, metricDefinitions: undefined }),
    /Unknown/,
  );
  const xpDefinition = {
    ...definition,
    type: 'SKILL',
    skill: 'attack',
    pageIds: [],
  };
  const xpCompetition = {
    ...competition,
    kind: 'SKILL',
    metricDefinitions: [
      { metric: 'new_raid', weight: '1', definition: xpDefinition },
    ],
  };
  const tracker = parseTracker({
    revision: 'xp-1',
    totals: { ...zeroTotals(), attack: '5' },
    events: [
      {
        id: 123,
        title: 'Custom XP',
        sourceUrl,
        skills: ['attack'],
        gains: { attack: '5' },
        competition: xpCompetition,
      },
    ],
  });
  assert.equal(tracker.totals.attack, '5');
  assert.deepEqual(
    competitionScope(
      tracker.events[0]!.competition!.metrics,
      tracker.events[0]!.competition!.metricDefinitions,
    ).skills,
    ['attack'],
  );
});
