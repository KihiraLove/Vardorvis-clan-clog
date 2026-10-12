/** Source contract tests never contact WOM; all requests use a controlled fixture. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fetchWomCompetition,
  parseCompetitionUrl,
  parseWomSnapshot,
} from './wom.js';
import { diffTotals, emptyTotals, skillIds } from './xp-types.js';

const details = (
  metrics: string[],
  players: { id: number; name?: string; gains: Record<string, unknown> }[],
  overrides: Record<string, unknown> = {},
) => ({
  id: 123,
  title: 'SOTW: Mining',
  startsAt: '2026-09-01T12:00:00.000Z',
  endsAt: '2026-09-08T12:00:00.000Z',
  updatedAt: '2026-09-08T12:05:00.000Z',
  metrics: metrics.map((metric) => ({ metric, weight: 1 })),
  participantCount: players.length,
  participations: players.map((p) => ({
    playerId: p.id,
    player: { id: p.id, displayName: p.name ?? 'Player ' + p.id },
    deltas: Object.entries(p.gains).map(([metric, gained]) => ({
      metric,
      values: { gained, start: 100, end: 100 },
    })),
  })),
  ...overrides,
});
const sample = details(
  ['mining'],
  [
    { id: 2, gains: { mining: 0 } },
    { id: 1, gains: { mining: '9007199254740993' } },
  ],
);
test('links use only canonical WOM competition identity and reject alternate origins', () => {
  assert.deepEqual(
    parseCompetitionUrl(
      'https://www.wiseoldman.net/competitions/123/?preview=true#ignore',
    ),
    {
      id: 123,
      url: 'https://wiseoldman.net/competitions/123',
    },
  );
  for (const url of [
    'http://wiseoldman.net/competitions/123',
    'https://wiseoldman.net.evil.test/competitions/123',
    'https://u:pass@wiseoldman.net/competitions/123',
    'https://wiseoldman.net:8443/competitions/123',
    'https://wiseoldman.net/competitions/0',
    'https://wiseoldman.net/competitions/123/extra',
  ])
    assert.throws(() => parseCompetitionUrl(url));
});
test('single-skill events discard zero players and retain large exact gains and event identity', () => {
  const item = parseWomSnapshot(sample, undefined, 123);
  assert.deepEqual(item.event.skills, ['mining']);
  assert.deepEqual(item.event.gains, { mining: '9007199254740993' });
  assert.equal(item.participants.length, 1);
  assert.equal(item.participants[0]?.playerId, 1);
  assert.equal(item.event.sourceUrl, 'https://wiseoldman.net/competitions/123');
  assert.equal(item.event.title, 'SOTW: Mining');
  assert.equal(item.sourceHash.length, 64);
});
test('all-skill scope requires complete explicit deltas; ignores weighted total instead of double-counting', () => {
  const overall = details(
    ['overall'],
    [
      { id: 1, gains: { overall: 25 } },
      { id: 2, gains: { overall: 70 } },
    ],
  );
  const rows = details(
    [...skillIds],
    [
      {
        id: 1,
        gains: Object.fromEntries([
          ...skillIds.map((s) => [s, s === 'attack' ? 10 : 0]),
          ['total', 99],
        ]),
      },
      {
        id: 2,
        gains: Object.fromEntries([
          ...skillIds.map((s) => [s, s === 'attack' ? 30 : 0]),
          ['total', 70],
        ]),
      },
    ],
  );
  const result = parseWomSnapshot(overall, rows, 123);
  assert.equal(result.event.skills.length, 24);
  assert.equal(result.event.gains.attack, '40');
  assert.equal(result.event.gains.sailing, '0');
  assert.equal(Object.hasOwn(result.event.gains, 'total'), false);
  assert.equal(result.participants[0]?.gains.attack, '10');
});
test('unsupported partial scope, incomplete source and non-XP metrics fail without simulated zero', () => {
  for (const value of [
    details(
      ['mining', 'fishing'],
      [{ id: 1, gains: { mining: 1, fishing: 2 } }],
    ),
    details(['zulrah'], [{ id: 1, gains: { zulrah: 4 } }]),
    details(['ehp'], [{ id: 1, gains: { ehp: 2 } }]),
    details(['mining'], [{ id: 1, gains: { mining: null } }]),
    details(['mining'], [{ id: 1, gains: { mining: -1 } }]),
    details(['mining'], [{ id: 1, gains: { mining: 2.5 } }]),
    details(['mining'], [{ id: 1, gains: { fishing: 100 } }]),
    details(
      ['mining'],
      [
        { id: 1, gains: { mining: 1 } },
        { id: 1, gains: { mining: 2 } },
      ],
    ),
    details(['mining'], [{ id: 1, gains: { mining: 1 } }], {
      participantCount: 99,
    }),
    details(['mining'], [{ id: 1, gains: { mining: 1 } }], { id: 999 }),
  ])
    assert.throws(() => parseWomSnapshot(value, undefined, 123));
  const original = details(['overall'], [{ id: 1, gains: { overall: 10 } }]);
  const partial = details([...skillIds], [{ id: 1, gains: { mining: 10 } }]);
  assert.throws(() => parseWomSnapshot(original, partial, 123));
});
test('fixed WOM API fetch uses one bulk metrics query, rejects network/rate limit and preserves source', async () => {
  const original = details(['overall'], [{ id: 1, gains: { overall: 500 } }]);
  const extra = details(
    [...skillIds],
    [
      {
        id: 1,
        gains: Object.fromEntries(
          skillIds.map((s) => [s, s === 'mining' ? 5 : 0]),
        ),
      },
    ],
  );
  const urls: string[] = [];
  const request = (async (input: RequestInfo | URL, options?: RequestInit) => {
    urls.push(String(input));
    assert.equal(options?.redirect, 'error');
    return Response.json(urls.length === 1 ? original : extra);
  }) as typeof fetch;
  const item = await fetchWomCompetition(
    'https://wiseoldman.net/competitions/123',
    request,
  );
  assert.equal(item.event.gains.mining, '5');
  assert.equal(urls.length, 2);
  assert.equal(urls[0], 'https://api.wiseoldman.net/v2/competitions/123');
  const u = new URL(urls[1]!);
  assert.equal(u.origin, 'https://api.wiseoldman.net');
  assert.equal(u.searchParams.getAll('metrics').length, skillIds.length);
  await assert.rejects(
    fetchWomCompetition(
      'https://wiseoldman.net/competitions/123',
      (async () => new Response('', { status: 429 })) as typeof fetch,
    ),
    { status: 429 },
  );
  await assert.rejects(
    fetchWomCompetition(
      'https://wiseoldman.net/competitions/123',
      (async () => {
        throw new Error('timeout');
      }) as typeof fetch,
    ),
    { status: 503 },
  );
});
test('event reconciliation is additive/replace-only with signed exact integer changes', () => {
  const before = emptyTotals();
  const first = parseWomSnapshot(sample, undefined, 123).event;
  const add = diffTotals(before, null, first);
  assert.equal(
    add.find((c) => c.skill === 'mining')?.change,
    '9007199254740993',
  );
  const total = { ...before, mining: '9007199254740993' };
  const next = { ...first, gains: { mining: '9007199254740900' } };
  const corrected = diffTotals(total, first, next);
  assert.equal(corrected.find((c) => c.skill === 'mining')?.change, '-93');
  assert.equal(
    corrected.find((c) => c.skill === 'mining')?.after,
    '9007199254740900',
  );
});
