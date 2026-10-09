/** Full-source regressions: never mistake a reduced fixture for production coverage. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  buildSnapshot,
  buildVerifiedSnapshot,
  type Provenance,
} from './catalog-build.js';
import { readBundledSnapshot } from './catalog-import.js';
import { readClueTaxonomy } from './clue-taxonomy.js';
import { validateSnapshot } from './catalog-model.js';

const root = new URL('../../../catalog/', import.meta.url);
test('all pinned source pages, slot order, IDs, icons and supporting assets reproduce exactly', async () => {
  const built = await buildVerifiedSnapshot();
  assert.deepEqual(built, await readBundledSnapshot());
  assert.equal(built.items.length, 1717);
  assert.equal(built.pages.length, 124);
  assert.equal(
    built.pages.reduce((sum, page) => sum + page.itemIds.length, 0),
    1864,
  );
  const source = JSON.parse(
    await readFile(new URL('sources/categories.json', root), 'utf8'),
  ) as Record<string, Record<string, number[]>>;
  const aliases = new Map(
    built.items.flatMap((item) =>
      item.gameItemIds.map((id) => [item.id, id] as const),
    ),
  );
  for (const page of built.pages)
    assert.deepEqual(
      page.itemIds.map((id) => aliases.get(id)),
      source[page.category]![page.id],
      `Slot order changed: ${page.id}`,
    );
  assert.ok(
    built.items.every((item) => !item.gameItemIds.includes(item.id)),
    'Internal IDs must remain distinct from external aliases',
  );
  const shared = built.items.find((item) => item.gameItemIds.includes(26241))!;
  assert.ok(
    built.pages.filter((page) => page.itemIds.includes(shared.id)).length >= 4,
    'Virtus mask is one identity across bosses',
  );
  const variants = built.items.filter(
    (item) => item.name === 'Chompy bird hat',
  );
  assert.ok(variants.length > 1, 'Same-name variants must not be merged');
  assert.equal(new Set(variants.map((item) => item.id)).size, variants.length);
});

test('invalid imports reject ambiguous aliases, duplicate slots, missing IDs and injected credits', async () => {
  const original = await readBundledSnapshot();
  for (const mutate of [
    (s: typeof original) => {
      s.items[1]!.gameItemIds = s.items[0]!.gameItemIds;
    },
    (s: typeof original) => {
      s.items[0]!.gameItemIds = [];
    },
    (s: typeof original) => {
      s.pages[0]!.itemIds.push(s.pages[0]!.itemIds[0]!);
    },
    (s: typeof original) => {
      s.pages[0]!.itemIds.push(2147483647);
    },
    (s: typeof original) => {
      s.items[0]!.iconPath = 'https://evil.test/icon.png';
    },
  ]) {
    const invalid = structuredClone(original);
    mutate(invalid);
    assert.throws(() => validateSnapshot(invalid));
  }
  assert.throws(() => validateSnapshot({ ...original, credits: [] }));
});

test('source-to-identity mapping refuses omissions, duplicates and dangling source slots', async () => {
  const read = async (name: string) =>
    JSON.parse(await readFile(new URL(name, root), 'utf8'));
  const source = (await read('sources/categories.json')) as Record<
    string,
    Record<string, number[]>
  >;
  const names = (await read('sources/items.json')).items as Record<
    string,
    string
  >;
  const labels = (await read('sources/page-names.json')) as Record<
    string,
    string
  >;
  const ids = (await read('identities.json')) as Record<string, number>;
  const provenance = (await read('provenance.json')) as Provenance;
  assert.throws(() =>
    buildSnapshot(
      source,
      { ...names, 999999: 'Missing slot' },
      labels,
      { ...ids, 999999: 999999 },
      provenance,
    ),
  );
  const ambiguous = { ...ids, 1249: ids[3140]! };
  assert.throws(() =>
    buildSnapshot(source, names, labels, ambiguous, provenance),
  );
  const dangling = structuredClone(source);
  dangling.bosses!.abyssal_sire!.push(999999);
  assert.throws(() => buildSnapshot(dangling, names, labels, ids, provenance));
});

test('rare clue taxonomy exactly reproduces the pinned OSRS Wiki and shares canonical identities', async () => {
  const patch = await readClueTaxonomy();
  const wiki = JSON.parse(
    (
      JSON.parse(
        await readFile(new URL('sources/wiki.json', root), 'utf8'),
      ) as {
        query: {
          pages: { revisions: { slots: { main: { content: string } } }[] }[];
        };
      }
    ).query.pages[0]!.revisions[0]!.slots.main.content,
  ) as { id: number; name: string; tabs: string[] }[];
  const snapshot = await readBundledSnapshot();
  const idByGame = new Map(
    snapshot.items.flatMap((item) =>
      item.gameItemIds.map((id) => [id, item.id] as const),
    ),
  );
  const totals = {
    hard_treasure_trails_rare: 24,
    elite_treasure_trails_rare: 39,
    master_treasure_trails_rare: 45,
  };
  for (const [id, rare] of Object.entries(patch.rarePages)) {
    assert.equal(rare.gameItemIds.length, totals[id as keyof typeof totals]);
    assert.deepEqual(
      rare.gameItemIds,
      wiki
        .filter((item) => item.tabs.includes(rare.name))
        .map((item) => item.id),
      id + ' must use every item and exact order from the pinned Wiki page',
    );
    assert.ok(rare.gameItemIds.every((gameId) => idByGame.has(gameId)));
  }
  const ring = wiki.find((item) => item.id === 23185)!;
  assert.deepEqual(ring.tabs, [
    'Elite Treasure Trails',
    'Master Treasure Trails',
  ]);
  for (const [id, move] of Object.entries(patch.regularMoves)) {
    const basePage = snapshot.pages.find((page) => page.id === id)!;
    const current = basePage.itemIds;
    for (const gameId of move.removeGameItemIds) {
      assert.ok(current.includes(idByGame.get(gameId)!));
      assert.ok(
        patch.rarePages[id + '_rare']!.gameItemIds.includes(gameId),
        'Relocated item must exist on the respective rare page',
      );
      assert.ok(
        !wiki
          .find((item) => item.id === gameId)!
          .tabs.includes(
            id === 'elite_treasure_trails'
              ? 'Elite Treasure Trails'
              : 'Master Treasure Trails',
          ),
      );
    }
    assert.deepEqual(move.addGameItemIds, [23185]);
    assert.ok(!current.includes(idByGame.get(23185)!));
  }
  const original = snapshot.pages.filter((page) =>
    patch.retiredPages.includes(page.id),
  );
  assert.deepEqual(
    original.map((page) => page.id),
    ['gilded', 'third_age', 'mimic'],
  );
  assert.equal(
    new Set(wiki.map((item) => item.id)).size,
    snapshot.items.length,
  );
});
