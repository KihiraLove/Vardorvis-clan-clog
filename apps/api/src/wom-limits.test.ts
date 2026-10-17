import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getWom, womResponseBytes } from './wom.js';
const url = 'https://api.wiseoldman.net/v2/competitions/123';
const fetcher = (response: Response) =>
  (async (_url: unknown, init?: RequestInit) => {
    assert.equal(init?.redirect, 'error');
    return response;
  }) as typeof fetch;
test('WOM reads a bounded stream before parsing with absent or misleading length', async () => {
  for (const length of [undefined, '1']) {
    let pulls = 0,
      canceled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
        cancel() {
          canceled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const response = new Response(stream, {
      headers: length ? { 'content-length': length } : {},
    });
    response.json = async () => {
      throw new Error('Unbounded JSON parser called');
    };
    await assert.rejects(getWom(url, fetcher(response)), { status: 422 });
    assert.equal(pulls, 9);
    assert.ok(canceled);
  }
  const exact = '"' + 'x'.repeat(womResponseBytes - 2) + '"';
  assert.equal(
    ((await getWom(url, fetcher(new Response(exact)))) as string).length,
    womResponseBytes - 2,
  );
});
test('WOM excessive declared length is rejected before reading and invalid JSON/UTF-8 stays private', async () => {
  let pulls = 0,
    canceled = false;
  const response = new Response(
    new ReadableStream(
      {
        pull() {
          pulls++;
        },
        cancel() {
          canceled = true;
        },
      },
      { highWaterMark: 0 },
    ),
    { headers: { 'content-length': String(womResponseBytes + 1) } },
  );
  await assert.rejects(getWom(url, fetcher(response)), { status: 422 });
  assert.equal(pulls, 0);
  assert.ok(canceled);
  for (const body of ['{broken', new Uint8Array([0xff])])
    await assert.rejects(getWom(url, fetcher(new Response(body))), {
      status: 422,
    });
});
test('WOM cancellation covers stalled headers/body, releases streams and recovers', async () => {
  for (const headers of [true, false]) {
    const controller = new AbortController();
    let canceled = false;
    const timer = setTimeout(() => controller.abort(), 20);
    const request = (
      headers
        ? () => new Promise<Response>(() => undefined)
        : async () =>
            new Response(
              new ReadableStream({
                cancel() {
                  canceled = true;
                },
              }),
            )
    ) as typeof fetch;
    try {
      await assert.rejects(getWom(url, request, controller.signal), {
        status: 503,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!headers) assert.ok(canceled);
  }
  assert.deepEqual(await getWom(url, fetcher(Response.json({ ok: true }))), {
    ok: true,
  });
});
test('WOM host/redirect restrictions and bounded provider Retry-After remain enforced', async () => {
  let calls = 0;
  const request = (async () => {
    calls++;
    return Response.json({});
  }) as typeof fetch;
  await assert.rejects(
    getWom('https://evil.test/v2/competitions/123', request),
    { status: 422 },
  );
  assert.equal(calls, 0);
  await assert.rejects(
    getWom(url, fetcher(new Response('', { status: 302 }))),
    { status: 503 },
  );
  await assert.rejects(
    getWom(
      url,
      fetcher(
        new Response('', { status: 429, headers: { 'retry-after': '7' } }),
      ),
    ),
    { status: 429, retryAfterSeconds: 7 },
  );
  await assert.rejects(
    getWom(url, fetcher(new Response('', { status: 404 }))),
    { status: 422 },
  );
});
