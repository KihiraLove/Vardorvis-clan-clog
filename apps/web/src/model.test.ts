/** Public parser/projection tests cover shared counts, invalid relationships and hardcore removal. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  creditLine,
  modeCredits,
  itemState,
  parseCatalog,
  parseCollections,
  progress,
  catalogSections,
  progressClass,
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

test('catalog sections retain staff names and order, reject dangling pages and allow an empty taxonomy', () => {
  const data = parseCatalog({
    ...catalog,
    sections: [
      { id: 'custom', name: 'Clan trophies' },
      { id: 'bosses', name: 'Boss drops' },
    ],
    pages: [{ ...catalog.pages[0], category: 'custom' }],
  });
  assert.deepEqual(catalogSections(data), [
    { id: 'custom', name: 'Clan trophies' },
    { id: 'bosses', name: 'Boss drops' },
  ]);
  assert.throws(() =>
    parseCatalog({
      ...catalog,
      sections: [{ id: 'custom', name: 'Clan trophies' }],
    }),
  );
  assert.throws(() =>
    parseCatalog({
      ...catalog,
      pages: [],
      sections: [
        { id: 'x', name: 'One' },
        { id: 'x', name: 'Two' },
      ],
    }),
  );
  assert.deepEqual(
    catalogSections(parseCatalog({ ...catalog, pages: [], sections: [] })),
    [],
  );
  assert.equal(progressClass(0, 0), 'count-empty');
  assert.equal(progressClass(0, 2), 'count-empty');
  assert.equal(progressClass(1, 2), 'count-partial');
  assert.equal(progressClass(2, 2), 'complete');
});

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
test('typed public histories retain repeated Regular credits, one Event and independent hardcore data', () => {
  const regular = { ...normal, collectionType: 'regular' as const };
  const event = {
    ...normal,
    submissionId: 'event',
    collectionType: 'event' as const,
    collectedOn: '2026-10-18',
  };
  const credits = parseCollections({
    revision: 'typed',
    credits: [
      event,
      { ...regular, submissionId: 'a', collectedOn: '2026-10-01' },
      { ...regular, submissionId: 'b', collectedOn: '2026-10-02' },
      hardcore,
    ],
  }).credits;
  const state = itemState(1, modeCredits(credits, false));
  assert.equal(state.eventCollected, true);
  assert.deepEqual(
    state.collectors.map((c) => c.submissionId),
    ['event', 'a', 'b'],
  );
  assert.deepEqual(progress([1, 1], credits), { collected: 1, total: 1 });
  assert.equal(itemState(1, modeCredits(credits, true)).eventCollected, false);
  assert.equal(
    itemState(
      1,
      credits.filter((c) => c.submissionId !== 'event'),
    ).eventCollected,
    false,
  );
  for (const invalid of [
    { ...event, hardcore: true },
    { ...event, collectionType: 'invalid' },
  ])
    assert.throws(() =>
      parseCollections({ revision: 'invalid', credits: [invalid] }),
    );
  assert.throws(() =>
    parseCollections({
      revision: 'duplicate-event',
      credits: [event, { ...event, submissionId: 'another-event' }],
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
    eventCollected: false,
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
test('normal and hardcore credits are independent; one collector is displayed in each log', () => {
  const credits = parseCollections({
    revision: 'one',
    credits: [hardcore, normal],
  }).credits;
  const ordinary = itemState(1, modeCredits(credits, false));
  const hc = itemState(1, modeCredits(credits, true));
  assert.equal(ordinary.hardcoreCollected, false);
  assert.equal(hc.hardcoreCollected, true);
  assert.equal(
    creditLine(ordinary.collectors[0]!),
    'Collected by KihiraVD on 03/10/26',
  );
  assert.equal(
    creditLine(hc.collectors[0]!),
    'Collected by KihiraVD on 05/10/26 on hardcore worlds',
  );
  assert.equal(itemState(1, modeCredits([credits[1]!], true)).collected, false);
  assert.equal(
    parseCollections({
      revision: 'one',
      credits: [normal, { ...normal, submissionId: 'duplicate' }],
    }).credits.length,
    2,
  );
  assert.throws(() =>
    parseCollections({
      revision: 'one',
      credits: [{ ...normal, collectedOn: '2026-02-30' }],
    }),
  );
});
