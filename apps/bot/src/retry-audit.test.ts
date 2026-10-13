/** Uncertain first-attempt outcomes must survive a failed retry. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpBotApi, type Claim } from './api.js';
import { failureMessage } from './handler.js';

const claim: Claim = {
  interactionId: '345678901234567890',
  guildId: '234567890123456789',
  actorDiscordId: '123456789012345678',
  rawItemText: 'Dragon axe',
  collectorName: 'Audit fixture',
  proofUrl: 'https://imgur.com/a/fixture',
  hardcore: false,
};

test('permanent first-attempt failures are not retried', async () => {
  for (const status of [400, 401, 403, 409, 422, 429]) {
    let calls = 0;
    const api = new HttpBotApi('http://api:3000', 'a'.repeat(64), async () => {
      calls++;
      return Response.json({ error: 'fixture' }, { status });
    });
    await assert.rejects(api.submit(claim), { status });
    assert.equal(calls, 1);
  }
});

test('repeated transport failures stop after two identical attempts and remain uncertain', async () => {
  const bodies: string[] = [];
  const api = new HttpBotApi(
    'http://api:3000',
    'a'.repeat(64),
    async (_url, options) => {
      bodies.push(String(options?.body));
      throw new Error('Connection lost after possible commit');
    },
  );
  await assert.rejects(api.submit(claim), (error: unknown) => {
    assert.match(failureMessage(error), /might have reached the server/u);
    return true;
  });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
});

test(
  'a retry rejected after an uncertain commit must not claim nothing was saved',
  {
    todo: 'GitHub #62 B06: the HTTP adapter loses first-attempt uncertainty when the retry returns 401.',
  },
  async () => {
    let calls = 0;
    const api = new HttpBotApi('http://api:3000', 'a'.repeat(64), async () => {
      calls++;
      if (calls === 1) throw new Error('Commit acknowledgement lost');
      return Response.json({ error: 'Credentials rotated' }, { status: 401 });
    });
    await assert.rejects(api.submit(claim), (error: unknown) => {
      assert.doesNotMatch(failureMessage(error), /Nothing was saved/u);
      return true;
    });
  },
);
