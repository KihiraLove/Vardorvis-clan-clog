/** Uncertain first-attempt outcomes must survive rejection of an identical retry. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BotApiError,
  HttpBotApi,
  UnconfirmedSubmissionError,
  type Claim,
  type Receipt,
} from './api.js';
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
const receipt: Receipt = {
  submissionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  interactionId: claim.interactionId,
  status: 'pending',
  submittedAt: '2026-10-13T08:00:00.000Z',
  collectedOn: '2026-10-13',
  dateSource: 'submission_default',
  hardcore: false,
  resolution: 'needs_match',
  itemId: null,
  candidates: [],
  creditOccupied: false,
};
const origin = 'http://api:3000';
const token = 'a'.repeat(64);
const expectedBody = JSON.stringify(claim);

function assertUnconfirmed(error: unknown, reason: UnconfirmedSubmissionError['reason']) {
  assert.ok(error instanceof UnconfirmedSubmissionError);
  assert.equal(error.reason, reason);
  assert.equal(error.interactionId, claim.interactionId);
  const message = failureMessage(error);
  assert.match(message, /could not be confirmed/u);
  assert.match(message, /might have reached the server/u);
  assert.match(message, /Discord interaction ID: 345678901234567890/u);
  assert.match(message, /new interaction ID/u);
  assert.match(message, /admin to check/u);
  assert.doesNotMatch(message, /Nothing was saved|Saved for admin review/u);
  assert.doesNotMatch(message, /Bearer|secret|Connection lost|Credentials rotated/u);
  return true;
}

test('permanent first-attempt failures are rejected once and retain their authoritative message', async () => {
  for (const status of [400, 401, 403, 409, 422, 429]) {
    let calls = 0;
    const api = new HttpBotApi(origin, token, async () => {
      calls++;
      return Response.json({ error: 'private fixture response' }, { status });
    });
    await assert.rejects(api.submit(claim), (error: unknown) => {
      assert.ok(error instanceof BotApiError);
      assert.equal(error.status, status);
      assert.ok(!(error instanceof UnconfirmedSubmissionError));
      if ([400, 401, 403, 409, 422].includes(status))
        assert.match(failureMessage(error), /Nothing (new )?was saved/u);
      assert.doesNotMatch(failureMessage(error), /private fixture response/u);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('transport timeout followed by a durable 200 replay confirms exactly one pending receipt', async () => {
  const bodies: string[] = [];
  let calls = 0;
  const api = new HttpBotApi(origin, token, async (_url, options) => {
    bodies.push(String(options?.body));
    if (++calls === 1) throw new Error('Lost acknowledgement after commit');
    return Response.json(receipt, { status: 200 });
  });
  assert.deepEqual(await api.submit(claim), receipt);
  assert.deepEqual(bodies, [expectedBody, expectedBody]);
});

test('transport/5xx uncertainty followed by 401, 403 or 422 cannot claim nothing was saved', async () => {
  for (const initial of ['transport', 'server'] as const)
    for (const status of [400, 401, 403, 409, 422, 429]) {
      let calls = 0;
      const bodies: string[] = [];
      const api = new HttpBotApi(origin, token, async (_url, options) => {
        calls++;
        bodies.push(String(options?.body));
        if (calls === 1) {
          if (initial === 'transport')
            throw new Error('private connection error with password');
          return Response.json({ error: 'try again' }, { status: 503 });
        }
        return Response.json({ error: 'Credentials rotated' }, { status });
      });
      await assert.rejects(
        api.submit(claim),
        (error: unknown) => assertUnconfirmed(error, 'retry-rejected'),
      );
      assert.deepEqual(bodies, [expectedBody, expectedBody]);
    }
});

test('closed-page 403 after an uncertain write is still unconfirmed; initial closed page remains authoritative', async () => {
  const { closedCollectionPageMessage } = await import('@clog/domain');
  for (const afterTimeout of [false, true]) {
    let calls = 0;
    const api = new HttpBotApi(origin, token, async () => {
      if (afterTimeout && ++calls === 1)
        throw new Error('Lost acknowledgement after commit');
      if (!afterTimeout) calls++;
      return Response.json(
        { error: closedCollectionPageMessage },
        { status: 403 },
      );
    });
    if (afterTimeout)
      await assert.rejects(
        api.submit(claim),
        (error: unknown) => assertUnconfirmed(error, 'retry-rejected'),
      );
    else
      await assert.rejects(api.submit(claim), (error: unknown) => {
        assert.ok(error instanceof BotApiError);
        assert.equal(failureMessage(error), closedCollectionPageMessage);
        return true;
      });
    assert.equal(calls, afterTimeout ? 2 : 1);
  }
});

test('repeated transport and server errors stop after exactly two identical attempts and remain uncertain', async () => {
  for (const kind of ['transport', 'server'] as const) {
    const bodies: string[] = [];
    const api = new HttpBotApi(origin, token, async (_url, options) => {
      bodies.push(String(options?.body));
      if (kind === 'transport')
        throw new Error('Connection lost after possible commit');
      return Response.json({ error: 'temporary failure' }, { status: 503 });
    });
    await assert.rejects(
      api.submit(claim),
      (error: unknown) => assertUnconfirmed(error, 'retries-exhausted'),
    );
    assert.deepEqual(bodies, [expectedBody, expectedBody]);
  }
});

test('malformed, mismatched and unreadable successful receipts cannot confirm success or cause new writes', async () => {
  for (const [status, response] of [
    [200, Response.json({ status: 'approved' })],
    [201, Response.json({ ...receipt, interactionId: '999999999999999999' })],
    [200, new Response('{', { status: 200, headers: { 'content-type': 'application/json' } })],
  ] as const) {
    let calls = 0;
    const api = new HttpBotApi(origin, token, async () => {
      calls++;
      return response;
    });
    await assert.rejects(
      api.submit(claim),
      (error: unknown) => assertUnconfirmed(error, 'invalid-receipt'),
    );
    assert.equal(calls, 1, 'a successful HTTP response with no durable receipt is not replayed');
    assert.ok(status === 200 || status === 201);
  }
  let calls = 0;
  const secondInvalid = new HttpBotApi(origin, token, async () => {
    if (++calls === 1) throw new Error('timeout after commit');
    return Response.json({ status: 'not-a-durable-receipt' }, { status: 200 });
  });
  await assert.rejects(
    secondInvalid.submit(claim),
    (error: unknown) => assertUnconfirmed(error, 'invalid-receipt'),
  );
  assert.equal(calls, 2);
});

test('staff correlation ID is numeric-only and does not reflect attacker-supplied text', () => {
  const injected = '345678901234567890\\n@everyone secret';
  const message = failureMessage(
    new UnconfirmedSubmissionError(injected, 'retries-exhausted'),
  );
  assert.doesNotMatch(message, /@everyone|secret|345678901234567890/u);
  assert.match(message, /could not be confirmed/u);
  assert.match(failureMessage(new Error('private SQL data'), claim.interactionId), /345678901234567890/u);
  assert.doesNotMatch(failureMessage(new Error('private SQL data'), claim.interactionId), /private SQL data/u);
});
