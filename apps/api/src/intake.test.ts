/** Strict bot-only API boundary and normalization tests without live Discord. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from './app.js';
import { readConfig, type BotConfig } from './config.js';
import { claimHash, validCollectionDate, validProofUrl } from './intake.js';
import { resolveMatch, searchMatches, type MatchItem } from './matching.js';
import { ApiError, type BackendStore, type BotSubmissionInput, type BotReceipt } from './types.js';

const guildId = '234567890123456789';
const actorDiscordId = '123456789012345678';
const token = 'a'.repeat(64);
const bot: BotConfig = { token, guildId };
const headers = { authorization: 'Bearer ' + token };
const rows: MatchItem[] = [
  { id: 42, name: 'Dragon axe', aliases: ['D axe'] },
  { id: 43, name: 'Dragon axe (or)', aliases: ['Shared axe'] },
  { id: 44, name: 'Mystic axe', aliases: ['Shared axe'] },
];

const example: BotSubmissionInput = {
  interactionId: '345678901234567890',
  guildId,
  actorDiscordId,
  rawItemText: 'dragon axe',
  collectorName: 'Collector',
  proofUrl: 'https://imgur.com/a/record',
  hardcore: false,
};

function fixture() {
  const receipts = new Map<string, { hash: string; receipt: BotReceipt }>();
  let calls = 0;
  const store = {
    async botItems(q: string, limit: number) {
      return searchMatches(rows, q, limit);
    },
    async submitClaim(input: BotSubmissionInput, hash: string) {
      calls++;
      const prior = receipts.get(input.interactionId);
      if (prior) {
        if (prior.hash !== hash) throw new ApiError(409, 'Changed interaction.');
        return { created: false, receipt: prior.receipt };
      }
      const today = new Date().toISOString().slice(0, 10);
      if (input.collectedOn && !validCollectionDate(input.collectedOn, today))
        throw new ApiError(422, 'Invalid collection date.');
      const match = resolveMatch(rows, input.rawItemText, input.itemId);
      const receipt: BotReceipt = {
        submissionId: 'fixture-' + input.interactionId,
        interactionId: input.interactionId,
        status: 'pending',
        submittedAt: new Date().toISOString(),
        collectedOn: input.collectedOn ?? today,
        dateSource: input.collectedOn ? 'collector' : 'submission_default',
        hardcore: input.hardcore,
        resolution: match.resolution,
        itemId: match.itemId,
        candidates: match.candidates,
        creditOccupied: false,
      };
      receipts.set(input.interactionId, { hash, receipt });
      return { created: true, receipt };
    },
  } as unknown as BackendStore;
  const app = createApp(undefined, undefined, { store, bot, logger: false });
  return { app, receipts, calls: () => calls };
}

test('exact aliases and canonical IDs resolve; ambiguous and fuzzy inputs remain unapproved suggestions', () => {
  assert.deepEqual(resolveMatch(rows, '  D   AXE  ').itemId, 42);
  assert.deepEqual(resolveMatch(rows, 'item:43').itemId, 43);
  assert.deepEqual(resolveMatch(rows, 'not that name', 44).itemId, 44);
  assert.equal(resolveMatch(rows, 'shared axe').itemId, null);
  assert.equal(resolveMatch(rows, 'shared axe').candidates.length, 2);
  assert.equal(resolveMatch(rows, 'dragn axe').itemId, null);
  assert.ok(searchMatches(rows, 'dragn axe').some((item) => item.id === 42));
  assert.equal(resolveMatch(rows, 'item:9999').itemId, null);
  assert.equal(searchMatches(rows, '', 2).length, 2);
});

test('proof URLs permit only actual HTTPS Imgur/Gyazo hosts and nonempty paths', () => {
  for (const proof of [
    'https://imgur.com/a/hello',
    'https://i.imgur.com/hello.png',
    'https://gyazo.com/hello',
    'https://i.gyazo.com/hello.png',
  ]) assert.equal(validProofUrl(proof), true, proof);
  for (const proof of [
    'http://imgur.com/hello',
    'https://imgur.com.evil.test/hello',
    'https://evil.test/imgur.com/hello',
    'https://foo.imgur.com/hello',
    'https://user@imgur.com/hello',
    'https://imgur.com:8443/hello',
    'https://imgur.com/',
    'https://gyazo.com/hello\n',
    'https://gyazo.com',
    'javascript:alert(1)',
  ]) assert.equal(validProofUrl(proof), false, proof);
});
test('date checks reject impossible, future and malformed calendar days', () => {
  assert.equal(validCollectionDate('2026-02-28', '2026-10-08'), true);
  assert.equal(validCollectionDate('2026-02-30', '2026-10-08'), false);
  assert.equal(validCollectionDate('2026-10-09', '2026-10-08'), false);
  assert.equal(validCollectionDate('08/10/2026', '2026-10-08'), false);
  assert.equal(validCollectionDate('2024-02-29', '2026-10-08'), true);
});
test('hardcore and every immutable claim field enter the idempotency fingerprint', () => {
  const standard = claimHash(example);
  assert.equal(claimHash({ ...example, hardcore: false }), standard);
  for (const change of [
    { hardcore: true },
    { collectorName: 'Someone else' },
    { itemId: 42 },
    { rawItemText: 'Dragon axe' },
    { proofUrl: 'https://gyazo.com/other' },
    { collectedOn: '2026-01-01' },
    { actorDiscordId: '999999999999999999' },
  ]) assert.notEqual(claimHash({ ...example, ...change }), standard);
});
test('bot routes are disabled without both credentials, and config refuses partial or weak settings', async () => {
  const noBot = createApp();
  assert.equal((await noBot.inject('/api/v1/bot/items')).statusCode, 404);
  await noBot.close();
  assert.equal(readConfig({}).bot, undefined);
  assert.equal(readConfig({ BOT_API_TOKEN: token, DISCORD_GUILD_ID: guildId }).bot?.guildId, guildId);
  for (const env of [
    { BOT_API_TOKEN: token },
    { DISCORD_GUILD_ID: guildId },
    { BOT_API_TOKEN: 'weak', DISCORD_GUILD_ID: guildId },
    { BOT_API_TOKEN: token, DISCORD_GUILD_ID: 'invalid' },
  ]) assert.throws(() => readConfig(env));
});
test('bot token is required for search/write; it cannot access admin routes', async () => {
  const { app } = fixture();
  try {
    assert.equal((await app.inject('/api/v1/bot/items')).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/v1/bot/items', headers: { authorization: 'Bearer ' + 'b'.repeat(64) } })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/v1/bot/items?q=axe&limit=2', headers })).json().items.length, 2);
    assert.equal((await app.inject({ url: '/api/v1/bot/items?q=axe&limit=26', headers })).statusCode, 400);
    assert.equal((await app.inject({ url: '/api/v1/admin/settings', headers })).statusCode, 404);
    assert.equal((await app.inject({ url: '/api/v1/status' })).json().submissionsEnabled, true);
    assert.equal((await app.inject({ url: '/api/v1/bot/items?q=x&unexpected=1', headers })).statusCode, 400);
  } finally {
    await app.close();
  }
});
test('intake enforces guild, proof, actor, fields and exact retry semantics', async () => {
  const { app, calls, receipts } = fixture();
  const submit = (payload: unknown, auth = headers) =>
    app.inject({ method: 'POST', url: '/api/v1/bot/submissions', headers: auth, payload });
  try {
    assert.equal((await submit(example, {})).statusCode, 401);
    for (const payload of [
      { ...example, guildId: '999999999999999999' },
      { ...example, rawItemText: '' },
      { ...example, collectorName: '  ' },
      { ...example, proofUrl: 'https://evil.test/evidence' },
      { ...example, actorDiscordId: 123 },
      { ...example, itemId: '42' },
      { ...example, hardcore: 'true' },
      { ...example, reviewedBy: actorDiscordId },
      { ...example, collectedOn: 'not-a-date' },
    ]) {
      const response = await submit(payload);
      assert.ok([400, 403, 422].includes(response.statusCode));
    }
    assert.equal(calls(), 0);
    const first = await submit(example);
    assert.equal(first.statusCode, 201);
    assert.equal(first.json().status, 'pending');
    assert.equal(first.json().resolution, 'resolved');
    assert.equal(first.json().itemId, 42);
    assert.equal(first.json().dateSource, 'submission_default');
    assert.equal(first.json().hardcore, false);
    assert.equal(receipts.size, 1);
    const retry = await submit({ ...example, hardcore: false });
    assert.equal(retry.statusCode, 200);
    assert.deepEqual(retry.json(), first.json());
    assert.equal((await submit({ ...example, hardcore: true })).statusCode, 409);
    assert.equal(receipts.size, 1);
    const unknown = await submit({
      ...example,
      interactionId: '456789012345678901',
      rawItemText: 'Shared axe',
      hardcore: true,
      collectedOn: '2026-01-12',
    });
    assert.equal(unknown.statusCode, 201);
    assert.equal(unknown.json().itemId, null);
    assert.equal(unknown.json().resolution, 'needs_match');
    assert.equal(unknown.json().dateSource, 'collector');
  } finally {
    await app.close();
  }
});
