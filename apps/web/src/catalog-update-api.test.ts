import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  catalogUpdates,
  applyCatalogUpdate,
  parseCatalogUpdateReview,
} from './catalog-update-api.ts';
const review = () => ({
  revision: 'a'.repeat(64),
  catalogRevision: 'catalog-1',
  autoOpen: true,
  releases: [],
  proposals: [],
  conflicts: [],
  currentImages: [],
});
test('catalog update transport validates images, revisions and receipts and sends exact CSRF/retry choices', async (t) => {
  assert.throws(() =>
    parseCatalogUpdateReview({
      ...review(),
      currentImages: [
        {
          name: 'Bad',
          path: 'https://other.example/image.webp',
          suppliedPath: '/bad',
          identical: false,
        },
      ],
    }),
  );
  assert.throws(() =>
    parseCatalogUpdateReview({ ...review(), revision: 'bad' }),
  );
  const calls: RequestInit[] = [];
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async (_url, options) => {
    calls.push(options!);
    return Response.json(
      options?.method
        ? { applied: 1, kept: 0, catalogRevision: 'catalog-2' }
        : review(),
    );
  };
  assert.equal(
    (await catalogUpdates(new AbortController().signal)).autoOpen,
    true,
  );
  const selection = {
    revision: 'a'.repeat(64),
    catalogRevision: 'catalog-1',
    apply: ['b'.repeat(64)],
    keep: [],
  };
  await applyCatalogUpdate(
    selection,
    'key',
    'csrf',
    new AbortController().signal,
  );
  assert.deepEqual(JSON.parse(calls[1]!.body as string), selection);
  assert.equal(
    (calls[1]!.headers as Record<string, string>)['Idempotency-Key'],
    'key',
  );
  assert.equal(
    (calls[1]!.headers as Record<string, string>)['X-CSRF-Token'],
    'csrf',
  );
  globalThis.fetch = async () => new Response('proxy login', { status: 401 });
  await assert.rejects(catalogUpdates(new AbortController().signal), {
    status: 401,
  });
});
