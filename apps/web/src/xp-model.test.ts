/** Verify exact arithmetic, strict source/payload parsing and repeatable preview reconciliation. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  amount,
  competitionUrl,
  exactXp,
  millionXp,
  parseChanges,
  skills,
  timestamp,
} from './xp-model.ts';
import {
  compareXp,
  parseImportHistory,
  parseCompetition,
  parseParticipants,
} from '../tests/support/xp-contracts.ts';
import { MemoryXpClient } from '../tests/support/xp.ts';

const signal = () => new AbortController().signal;
const url = (id: number) => 'https://wiseoldman.net/competitions/' + id;

test('fixture XP history pages include unchanged receipts, bind appends and preserve exact validated evidence', async () => {
  const client = new MemoryXpClient();
  for (let n = 0; n < 25; n++) {
    const preview = await client.preview(url(1001), 'test-only', signal());
    await client.apply(preview, 'test-only', 'history-' + n, signal());
  }
  const first = parseImportHistory(await client.history(signal()));
  const second = parseImportHistory(
    await client.history(signal(), first.nextCursor!),
  );
  assert.equal(first.imports.length, 20);
  assert.equal(second.imports.length, 5);
  assert.equal(second.nextCursor, null);
  assert.equal(
    new Set([...first.imports, ...second.imports].map((row) => row.id)).size,
    25,
  );
  assert.ok(first.imports.every((row) => row.outcome === 'unchanged'));
  assert.equal(second.imports.at(-1)!.outcome, 'applied');
  assert.deepEqual(await client.history(signal(), first.pageCursor), first);
  const preview = await client.preview(url(1001), 'test-only', signal());
  await client.apply(preview, 'test-only', 'history-new', signal());
  await assert.rejects(client.history(signal(), first.pageCursor), {
    status: 409,
  });
  const value = {
    ...first,
    imports: [
      {
        ...first.imports[0]!,
        changes: [
          {
            skill: 'attack',
            before: '9007199254740993',
            after: '9007199254740994',
            change: '1',
          },
        ],
      },
    ],
  };
  assert.equal(
    parseImportHistory(value).imports[0]!.changes[0]!.before,
    '9007199254740993',
  );
  assert.throws(
    () =>
      parseImportHistory({
        ...value,
        imports: [...value.imports, ...value.imports],
      }),
    /Duplicate/,
  );
  assert.throws(
    () =>
      parseImportHistory({
        ...first,
        imports: [...first.imports, ...second.imports],
      }),
    /size/,
  );
  assert.throws(
    () => parseImportHistory({ ...value, nextCursor: undefined }),
    /text/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.history(controller.signal), {
    name: 'AbortError',
  });
  await assert.rejects(new MemoryXpClient(async () => null).history(signal()), {
    status: 401,
  });
  assert.deepEqual(
    (
      await new MemoryXpClient(async () => ({
        csrfToken: 'test',
        displayName: 'Staff',
        username: 'staff',
        role: 'moderator',
        mustChangePassword: false,
      })).history(signal())
    ).imports,
    [],
  );
});

test('million labels never round above recorded XP, and hover values retain integer precision', () => {
  assert.equal(millionXp('0'), '0.00m');
  assert.equal(millionXp('999999'), '0.99m');
  assert.equal(millionXp('12345678'), '12.34m');
  assert.equal(millionXp('9007199254740993'), '9007199254.74m');
  assert.equal(exactXp('9007199254740993'), '9,007,199,254,740,993');
  assert.equal(compareXp('9007199254740993', '9007199254740992'), -1);
  assert.equal(compareXp('0', null), -1);
  assert.equal(compareXp(null, '0'), 1);
  assert.equal(skills.length, 24);
  assert.deepEqual(
    skills.slice(-3).map(([id]) => id),
    ['construction', 'hunter', 'sailing'],
  );
});

test('only canonical HTTPS WOM competition links are accepted', () => {
  assert.deepEqual(
    competitionUrl(
      ' https://www.wiseoldman.net/competitions/1001/?x=1#results ',
    ),
    { id: 1001, url: url(1001) },
  );
  for (const invalid of [
    'http://wiseoldman.net/competitions/1',
    'https://wiseoldman.net.evil.test/competitions/1',
    'https://user:secret@wiseoldman.net/competitions/1',
    'https://wiseoldman.net:444/competitions/1',
    'https://wiseoldman.net/competitions/0',
    'https://wiseoldman.net/competitions/9007199254740993',
    'https://wiseoldman.net/competitions/1/extra',
    'not a link',
  ])
    assert.throws(() => competitionUrl(invalid));
});

test('payloads reject fractional/negative XP, impossible dates, duplicate identities and mismatched changes', () => {
  for (const invalid of [1, '-1', '1.5', '01', '1e6', '', '9'.repeat(101)])
    assert.throws(() => amount(invalid));
  assert.equal(amount('-12', true), '-12');
  assert.equal(
    timestamp('2024-02-29T00:00:00.000Z'),
    '2024-02-29T00:00:00.000Z',
  );
  assert.throws(() => timestamp('2026-02-30T00:00:00Z'));
  assert.throws(() => timestamp('2026-10-05T12:00:00'));
  assert.throws(
    () =>
      parseParticipants(
        [
          { playerId: 1, displayName: 'One', gains: { attack: '0' } },
          { playerId: 1, displayName: 'Renamed', gains: { attack: '1' } },
        ],
        ['attack'],
      ),
    /Duplicate/,
  );
  assert.throws(
    () =>
      parseParticipants(
        [
          {
            playerId: 1,
            displayName: 'One',
            gains: { attack: '1', overall: '2' },
          },
        ],
        ['attack'],
      ),
    /Unknown/,
  );
  assert.throws(
    () =>
      parseParticipants(
        [{ playerId: 1, displayName: 'One', gains: {} }],
        ['attack'],
      ),
    /exact decimal/,
  );
  assert.throws(
    () =>
      parseChanges([
        { skill: 'attack', before: '0', after: '10', change: '9' },
      ]),
    /Inconsistent/,
  );
});

test('preview imports add each contribution once; unchanged and incremental refreshes reconcile the same competition', async () => {
  const client = new MemoryXpClient();
  assert.ok(
    Object.values(
      (await client.load('attack', undefined, signal())).overview.totals,
    ).every((xp) => xp === '0'),
  );
  const first = await client.preview(url(1001), 'test-only', signal());
  assert.equal(first.participants.length, 4);
  assert.equal(first.participants[2]!.gains.attack, '0');
  assert.equal(first.participants[3]!.gains.attack, null);
  const applied = await client.apply(
    first,
    'test-only',
    'request-one',
    signal(),
  );
  assert.equal(applied.outcome, 'applied');
  assert.deepEqual(
    await client.apply(first, 'test-only', 'request-one', signal()),
    applied,
  );
  const unchanged = await client.preview(url(1001), 'test-only', signal());
  assert.equal(unchanged.changes[0]!.change, '0');
  assert.equal(
    (await client.apply(unchanged, 'test-only', 'request-two', signal()))
      .outcome,
    'unchanged',
  );
  client.advance();
  const next = await client.preview(url(1001), 'test-only', signal());
  assert.deepEqual(next.changes[0], {
    skill: 'attack',
    before: '18345678',
    after: '19595678',
    change: '1250000',
  });
  assert.equal(
    (await client.load('attack', undefined, signal())).overview.totals.attack,
    '18345678',
    'previewing never grants credit',
  );
  await client.apply(next, 'test-only', 'request-three', signal());
  const result = await client.load('attack', 1001, signal());
  assert.equal(result.overview.totals.attack, '19595678');
  assert.equal(result.members.find((m) => m.playerId === 1)!.xp, '13595678');
  assert.equal(result.members.find((m) => m.playerId === 3)!.xp, '0');
  assert.equal(result.members.find((m) => m.playerId === 4)!.xp, null);
  assert.equal(
    (await client.history()).imports.length,
    3,
    'idempotent retry adds no second history entry',
  );
});

test('multi-skill imports accumulate independently, and repeat sample setup adds no duplicate XP', async () => {
  const client = new MemoryXpClient();
  await client.samples();
  await client.samples();
  const snapshot = await client.load('sailing', undefined, signal());
  assert.equal(snapshot.overview.totals.attack, '18345678');
  assert.equal(snapshot.overview.totals.fishing, '4400123');
  assert.equal(snapshot.overview.totals.sailing, '7500000');
  assert.deepEqual(
    snapshot.detail!.competition.skills,
    skills.map(([id]) => id),
  );
  assert.equal(snapshot.detail!.participants.length, 4);
  parseCompetition(snapshot.detail!.competition);
  parseParticipants(
    snapshot.detail!.participants,
    skills.map(([id]) => id),
  );
  assert.equal(snapshot.overview.totals.mining, '0');
});

test('stale/expired previews and conflicting request retries cannot write the fixture ledger', async () => {
  const client = new MemoryXpClient();
  const stale = await client.preview(url(1001), 'test-only', signal());
  const current = await client.preview(url(1002), 'test-only', signal());
  await client.apply(current, 'test-only', 'request-one', signal());
  await assert.rejects(
    client.apply(stale, 'test-only', 'request-two', signal()),
    { status: 409 },
  );
  await assert.rejects(
    client.apply(stale, 'test-only', 'request-one', signal()),
    { status: 409 },
  );
  const fresh = await client.preview(url(1001), 'test-only', signal());
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + 600000;
    await assert.rejects(
      client.apply(fresh, 'test-only', 'expired', signal()),
      { status: 409 },
    );
  } finally {
    Date.now = originalNow;
  }
  assert.equal(
    (await client.load('attack', undefined, signal())).overview.totals.attack,
    '0',
  );
});
