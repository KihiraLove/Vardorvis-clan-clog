/** Injected fetch responses verify conditional reads and cache preservation on partial failure. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PublicLogClient } from './api.ts';

const catalog = {
  revision: 'catalog-one',
  items: [{ id: 1, name: 'Shared', iconPath: '/icons/1.png' }],
  pages: [{ id: 'one', name: 'One', category: 'bosses', itemIds: [1] }],
};
const collections = { revision: 'credits-one', credits: [] };
const json = (data: unknown, etag: string) =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { ETag: etag, 'Content-Type': 'application/json' },
  });
const signal = () => new AbortController().signal;

test('conditional polling reuses 304 data and reconciles changed credits', async () => {
  let phase = 0;
  const request: typeof fetch = async function (this: unknown, path, options) {
    assert.equal(
      this,
      globalThis,
      'native fetch must receive the browser/global context',
    );
    const isCatalog = String(path).endsWith('/catalog');
    const headers = options?.headers as Record<string, string>;
    if (phase === 0)
      return json(
        isCatalog ? catalog : collections,
        isCatalog ? 'cat-1' : 'credits-1',
      );
    assert.equal(headers['If-None-Match'], isCatalog ? 'cat-1' : 'credits-1');
    if (phase === 1 || isCatalog) return new Response(null, { status: 304 });
    return json(
      {
        revision: 'credits-two',
        credits: [
          {
            submissionId: 'one',
            itemId: 1,
            collectorName: 'KihiraVD',
            collectedOn: '2026-10-03',
          },
        ],
      },
      'credits-2',
    );
  };
  const client = new PublicLogClient(request);
  const first = await client.load(signal());
  phase = 1;
  const unchanged = await client.load(signal());
  assert.equal(unchanged.catalog, first.catalog);
  assert.equal(unchanged.collections, first.collections);
  phase = 2;
  assert.equal((await client.load(signal())).collections.credits.length, 1);
});
test('partial failure does not advance either cache or replace a valid snapshot', async () => {
  let phase = 0;
  const request: typeof fetch = async (path, options) => {
    const isCatalog = String(path).endsWith('/catalog');
    if (phase === 0)
      return json(
        isCatalog ? catalog : collections,
        isCatalog ? 'cat-1' : 'credits-1',
      );
    if (phase === 1)
      return isCatalog
        ? json({ ...catalog, revision: 'catalog-two' }, 'cat-2')
        : new Response(null, { status: 503 });
    assert.equal(
      (options?.headers as Record<string, string>)['If-None-Match'],
      isCatalog ? 'cat-1' : 'credits-1',
    );
    return new Response(null, { status: 304 });
  };
  const client = new PublicLogClient(request);
  const original = await client.load(signal());
  phase = 1;
  await assert.rejects(client.load(signal()));
  phase = 2;
  assert.equal((await client.load(signal())).catalog, original.catalog);
});
test('inconsistent catalog/credits are rejected and aborted reads cannot commit', async () => {
  const client = new PublicLogClient(async (path) =>
    json(
      String(path).endsWith('/catalog')
        ? catalog
        : {
            revision: 'one',
            credits: [
              {
                submissionId: 'one',
                itemId: 999,
                collectorName: 'Test',
                collectedOn: '2026-10-03',
              },
            ],
          },
      'one',
    ),
  );
  await assert.rejects(client.load(signal()), /unknown catalog item/);
  const controller = new AbortController();
  controller.abort();
  const aborted = new PublicLogClient(async (path) =>
    json(String(path).endsWith('/catalog') ? catalog : collections, 'one'),
  );
  await assert.rejects(aborted.load(controller.signal), {
    name: 'AbortError',
  });
});
