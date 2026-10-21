import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  matchCatalogUpdate,
  parseCatalogUpdate,
  type UpdateCatalog,
} from './catalog-update-model.js';
const batch = () =>
  parseCatalogUpdate({
    id: 'test-release',
    title: 'Test release',
    pages: [{ key: 'archive', name: 'The Archive', category: 'raids' }],
    items: [
      {
        key: 'new-item',
        name: 'Archive relic',
        gameItemIds: [42],
        image: { sha256: 'a'.repeat(64), width: 36, height: 32 },
        pageKeys: ['archive'],
      },
    ],
  });
test('catalog matching distinguishes name-only review candidates, exact IDs, collisions, variants and retired records', () => {
  const local: UpdateCatalog = {
    bindings: [],
    items: [
      {
        id: 99,
        name: '  Archive   relic ',
        gameItemIds: [999],
        iconPath: null,
        active: true,
      },
    ],
    pages: [
      {
        id: 'manual-page',
        name: 'The Archive',
        category: 'raids',
        active: true,
        itemIds: [],
      },
    ],
  };
  let matches = matchCatalogUpdate(batch(), local);
  assert.equal(matches[1]!.localId, '99');
  assert.equal(matches[1]!.candidate, true);
  assert.equal(matches[0]!.candidate, false);
  local.items[0]!.name = 'Typo';
  local.items[0]!.gameItemIds = [42, 43];
  matches = matchCatalogUpdate(batch(), local);
  assert.equal(matches[1]!.localId, '99');
  assert.equal(matches[1]!.candidate, false);
  local.items.push({
    id: 100,
    name: 'Archive relic',
    gameItemIds: [],
    iconPath: null,
    active: true,
  });
  assert.ok(matchCatalogUpdate(batch(), local)[1]!.conflict);
  local.items.pop();
  local.items[0]!.active = false;
  assert.match(
    matchCatalogUpdate(batch(), local)[1]!.conflict!.reason,
    /retired/,
  );
  local.items[0]!.active = true;
  local.bindings = [{ kind: 'item', source_key: 'new-item', local_id: '123' }];
  assert.ok(matchCatalogUpdate(batch(), local)[1]!.conflict);
});
test('catalog manifests reject unsafe assets, duplicate IDs, malformed fields and contradictory source identities', () => {
  const b = batch();
  assert.deepEqual(parseCatalogUpdate(b), b);
  assert.throws(() =>
    parseCatalogUpdate({
      ...b,
      items: [
        { ...b.items[0], image: { sha256: '../bad', width: 36, height: 32 } },
      ],
    }),
  );
  assert.throws(() =>
    parseCatalogUpdate({
      ...b,
      items: [b.items[0], { ...b.items[0], key: 'second' }],
    }),
  );
  assert.throws(() => parseCatalogUpdate({ ...b, unexpected: true }));
  assert.throws(() => parseCatalogUpdate({ ...b, title: 'Bad\u0000name' }));
});

test('page membership evidence defers renamed manual pages, including shared and retired candidates', () => {
  const local: UpdateCatalog = {
    bindings: [],
    items: [
      {
        id: 7,
        name: 'Archive relic',
        gameItemIds: [42],
        active: true,
        iconPath: null,
      },
    ],
    pages: [
      {
        id: 'our-loot',
        name: 'Our raid loot',
        category: 'other',
        itemIds: [7],
        active: true,
      },
    ],
  };
  let page = matchCatalogUpdate(batch(), local)[0]!;
  assert.equal(page.localId, 'our-loot');
  assert.equal(page.candidate, true);
  assert.deepEqual(page.pageChoices![0]!.matchedItems, ['Archive relic']);
  local.pages.push({
    ...local.pages[0]!,
    id: 'shared',
    name: 'Shared rewards',
  });
  page = matchCatalogUpdate(batch(), local)[0]!;
  assert.equal(page.localId, null);
  assert.ok(page.conflict);
  assert.equal(page.pageChoices!.length, 2);
  local.pages.pop();
  local.pages[0]!.active = false;
  page = matchCatalogUpdate(batch(), local)[0]!;
  assert.match(page.conflict!.reason, /retired/);
  local.pages[0]!.active = true;
  local.bindings.push({
    kind: 'page',
    source_key: 'archive',
    local_id: 'our-loot',
  });
  page = matchCatalogUpdate(batch(), local)[0]!;
  assert.equal(page.candidate, false);
  assert.equal(page.pageChoices, undefined);
});
