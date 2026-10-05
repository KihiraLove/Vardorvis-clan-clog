import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  collectionState,
  formatCollectionDate,
  validateCatalog,
  validateCollectionDate,
  validateProofUrl,
  type CollectionCredit,
} from './index.js';

test('an item shared by pages has one collection state and all items start uncollected', () => {
  const items = [{ id: 1, name: 'Shared item', gameItemIds: [100] }];
  const pages = [
    { id: 'page-a', itemIds: [1] },
    { id: 'page-b', itemIds: [1] },
  ];
  validateCatalog(items, pages);
  for (const page of pages)
    assert.equal(collectionState(page.itemIds[0]!, []).collected, false);
  const credit: CollectionCredit = {
    submissionId: 'a',
    itemId: 1,
    collectorName: 'KihiraVD',
    collectedOn: '2026-10-16',
    status: 'approved',
  };
  for (const page of pages)
    assert.equal(collectionState(page.itemIds[0]!, [credit]).collected, true);
  assert.equal(collectionState(2, [credit]).collected, false);
});

test('pending, rejected and revoked submissions never grant collection credit', () => {
  for (const status of ['pending', 'rejected', 'revoked'] as const) {
    assert.equal(
      collectionState(1, [
        {
          submissionId: 'a',
          itemId: 1,
          collectorName: 'A',
          collectedOn: '2026-10-01',
          status,
        },
      ]).collected,
      false,
    );
  }
});

test('multiple approved collectors are preserved and ordered by collection date', () => {
  const credits: CollectionCredit[] = ['2026-10-16', '2026-10-01'].map(
    (collectedOn, index) => ({
      submissionId: String(index),
      itemId: 1,
      collectorName: String(index),
      collectedOn,
      status: 'approved',
    }),
  );
  assert.equal(
    collectionState(1, credits).collectors[0]?.collectedOn,
    '2026-10-01',
  );
  assert.equal(collectionState(1, credits).collectors.length, 2);
});

test('catalog rejects ambiguous mappings and dangling page references', () => {
  const item = { id: 1, name: 'A', gameItemIds: [100] };
  assert.throws(() => validateCatalog([item, { ...item, id: 2 }], []));
  assert.throws(() => validateCatalog([item], [{ id: 'a', itemIds: [99] }]));
  assert.throws(() => validateCatalog([item], [{ id: 'a', itemIds: [1, 1] }]));
});

test('proof links reject spoofed domains, credentials, scripts and unsupported ports', () => {
  for (const value of [
    'http://imgur.com/a',
    'https://imgur.com.evil.test/a',
    'https://evil.test/imgur.com/a',
    'https://user@imgur.com/a',
    'https://gyazo.com:444/a',
    'javascript:alert(1)',
    'https://imgur.com/',
    'https://imgur.com/a b',
  ])
    assert.throws(() => validateProofUrl(value));
  assert.equal(
    validateProofUrl('https://i.imgur.com/test.png'),
    'https://i.imgur.com/test.png',
  );
  assert.equal(
    validateProofUrl('https://gyazo.com/abc123'),
    'https://gyazo.com/abc123',
  );
});

test('dates are calendar dates, independent of server timezone', () => {
  assert.equal(formatCollectionDate('2026-10-16'), '16/10/26');
  assert.equal(validateCollectionDate('2024-02-29'), '2024-02-29');
  for (const value of ['2026-02-29', '2026-04-31', '16/10/26', '2026-13-01'])
    assert.throws(() => validateCollectionDate(value));
});
