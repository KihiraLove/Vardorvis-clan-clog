import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  creditLine,
  itemState,
  parseCatalog,
  parseCollections,
  progress,
} from './model.ts';

const catalog = {
  revision: 'one',
  items: [{ id: 1, name: 'Shared drop', iconPath: '/icons/1.png' }],
  pages: [
    { id: 'one', name: 'One', category: 'bosses', itemIds: [1] },
    { id: 'two', name: 'Two', category: 'raids', itemIds: [1] },
  ],
};
const normal = {
  submissionId: 'one',
  itemId: 1,
  collectorName: 'KihiraVD',
  collectedOn: '2026-10-03',
  hardcore: false,
};
const hardcore = {
  ...normal,
  submissionId: 'two',
  collectedOn: '2026-10-05',
  hardcore: true,
};

test('manual items need no external game ID; malformed catalog relationships fail', () => {
  assert.equal(parseCatalog(catalog).items.length, 1);
  assert.throws(() =>
    parseCatalog({ ...catalog, items: [...catalog.items, ...catalog.items] }),
  );
  assert.throws(() =>
    parseCatalog({
      ...catalog,
      pages: [{ ...catalog.pages[0], itemIds: [2] }],
    }),
  );
  assert.throws(() =>
    parseCatalog({
      ...catalog,
      pages: [{ ...catalog.pages[0], itemIds: [1, 1] }],
    }),
  );
  assert.throws(() =>
    parseCatalog({
      ...catalog,
      items: [{ ...catalog.items[0], iconPath: '//external.test/a.png' }],
    }),
  );
});
test('defaults are uncollected and queue statuses never produce public credit', () => {
  const data = parseCollections({
    revision: 'one',
    credits: ['pending', 'rejected', 'revoked'].map((status) => ({
      ...normal,
      status,
    })),
  });
  assert.equal(data.credits.length, 0);
  assert.deepEqual(itemState(1, data.credits), {
    collected: false,
    collectors: [],
    hardcoreCollected: false,
  });
  assert.equal(
    parseCollections({
      revision: 'one',
      credits: [{ ...normal, hardcore: undefined }],
    }).credits[0]?.hardcore,
    false,
  );
});
test('one shared item increments both pages but global progress counts it once', () => {
  const credits = parseCollections({
    revision: 'one',
    credits: [normal],
  }).credits;
  const data = parseCatalog(catalog);
  for (const page of data.pages)
    assert.deepEqual(progress(page.itemIds, credits), {
      collected: 1,
      total: 1,
    });
  assert.deepEqual(
    progress(
      data.pages.flatMap((page) => page.itemIds),
      credits,
    ),
    { collected: 1, total: 1 },
  );
});
test('mixed credits, exact dates and final-hardcore revocation retain ordinary collection', () => {
  const credits = parseCollections({
    revision: 'one',
    credits: [hardcore, normal],
  }).credits;
  const mixed = itemState(1, credits);
  assert.equal(mixed.hardcoreCollected, true);
  assert.equal(
    creditLine(mixed.collectors[0]!),
    'Collected by KihiraVD on 03/10/26',
  );
  assert.equal(
    creditLine(mixed.collectors[1]!),
    'Collected by KihiraVD on 05/10/26 on hardcore worlds',
  );
  assert.deepEqual(
    {
      ...itemState(
        1,
        credits.filter((credit) => !credit.hardcore),
      ),
      collectors: [],
    },
    { collected: true, collectors: [], hardcoreCollected: false },
  );
  assert.equal(itemState(1, []).collected, false);
  assert.throws(() =>
    parseCollections({
      revision: 'one',
      credits: [{ ...normal, collectedOn: '2026-02-30' }],
    }),
  );
});
