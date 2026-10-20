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
