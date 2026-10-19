import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  runeLiteItemName,
  validateRuneLiteItemName,
} from './runelite-item-name.js';

test('submitted names are bounded evidence and override catalog/chat fallbacks', () => {
  for (const value of ['', '   ', '\0item', 'x'.repeat(201)])
    assert.throws(() => validateRuneLiteItemName(value), { status: 422 });
  validateRuneLiteItemName(undefined);
  validateRuneLiteItemName('x'.repeat(200));
  const fields = {
    itemId: 123,
    itemName: ' Original <name> ',
    chatMessage: 'Valuable drop: Other (1 coins)',
  };
  assert.equal(runeLiteItemName(fields, 'Catalog name'), fields.itemName);
  assert.equal(
    runeLiteItemName({ itemId: 123 }, 'Catalog name'),
    'Catalog name',
  );
});

test('legacy names are recovered only from known message formats', () => {
  const messages = [
    'New item added to your collection log: <col=ff0000>Rare item</col>',
    'Valuable drop: 2 x Rare item (1,000 coins)',
    'Untradeable drop: Rare item',
    'Collector received a new collection log item: Rare item (1/100).',
    'Collector received a valuable drop: 2 x Rare item (1,000 coins) from Boss!',
    'Collector received special loot from a raid: Rare item (1,000)',
    "[Clan] Collector has a funny feeling like he's being followed: Rare item at 42 killcount.",
    'Collector has received a drop: 1 x Rare item!',
  ];
  for (const chatMessage of messages)
    assert.equal(
      runeLiteItemName({ itemId: 123, chatMessage }),
      'Rare item',
      chatMessage,
    );
  for (const chatMessage of [
    'something: Rare item',
    'Collector received a drop: Rare item',
    'Valuable drop: ' + 'x'.repeat(201),
  ])
    assert.equal(
      runeLiteItemName({ itemId: 123, chatMessage }),
      'Name not supplied — game item #123',
    );
});
