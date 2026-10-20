/** Build and verify the complete checked-in catalog without network access. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  categories,
  sha256,
  snapshotId,
  validateSnapshot,
  type CatalogSnapshot,
} from './catalog-model.js';

const root = new URL('../../../', import.meta.url);
const json = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(new URL(path, root), 'utf8')) as T;
export interface Provenance {
  schemaVersion: number;
  retrievedAt: string;
  sourceUrl: string;
  sourceRevision: string;
  wikiRevision: number;
  iconRevision: string;
  sources: { file: string; url: string; sha256: string }[];
  coverage: { categories: number; pages: number; items: number; slots: number };
}
interface Assets {
  iconRevision: string;
  items: {
    gameItemId: number;
    path: string;
    url: string;
    sourceSha256: string;
    sha256: string;
    width: number;
    height: number;
  }[];
  supporting: { path: string; sha256: string }[];
}

/** Keep source order verbatim. Name equality never merges two distinct source IDs. */
export function buildSnapshot(
  source: Record<string, Record<string, number[]>>,
  names: Record<string, string>,
  labels: Record<string, string>,
  identities: Record<string, number>,
  provenance: Provenance,
): CatalogSnapshot {
  assert.deepEqual(
    Object.keys(source),
    [...categories],
    'Unexpected source categories/order',
  );
  const gameIds = Object.keys(names)
    .map(Number)
    .sort((a, b) => a - b);
  assert.deepEqual(
    Object.keys(identities)
      .map(Number)
      .sort((a, b) => a - b),
    gameIds,
    'Identity registry coverage changed',
  );
  const pages = Object.entries(source).flatMap(([category, entries]) =>
    Object.entries(entries).map(([id, gameItemIds], sortOrder) => ({
      id,
      category,
      name: labels[id]!,
      sortOrder,
      itemIds: gameItemIds.map((gameId) => {
        assert.ok(identities[gameId], `Unmapped source ID ${gameId}`);
        return identities[gameId]!;
      }),
    })),
  );
  assert.deepEqual(
    Object.keys(labels).sort(),
    pages.map((page) => page.id).sort(),
    'Page label coverage changed',
  );
  const used = [
    ...new Set(
      Object.values(source).flatMap((entries) => Object.values(entries).flat()),
    ),
  ].sort((a, b) => a - b);
  assert.deepEqual(used, gameIds, 'Source item/page coverage differs');
  const snapshot: CatalogSnapshot = {
    schemaVersion: 1,
    source: {
      url: provenance.sourceUrl,
      revision: provenance.sourceRevision,
      retrievedAt: provenance.retrievedAt,
    },
    items: gameIds.map((gameId) => ({
      id: identities[gameId]!,
      name: names[gameId]!,
      gameItemIds: [gameId],
      iconPath: `/catalog/items/${gameId}.webp`,
    })),
    pages,
  };
  validateSnapshot(snapshot);
  assert.deepEqual(
    {
      categories: Object.keys(source).length,
      pages: pages.length,
      items: snapshot.items.length,
      slots: pages.reduce((sum, page) => sum + page.itemIds.length, 0),
    },
    provenance.coverage,
    'Pinned coverage differs',
  );
  return snapshot;
}

/** Check both independent item coverage and each local asset's original bytes. */
export async function buildVerifiedSnapshot(): Promise<CatalogSnapshot> {
  const provenance = await json<Provenance>('catalog/provenance.json');
  assert.equal(provenance.schemaVersion, 1);
  assert.deepEqual(provenance.sources.map((source) => source.file).sort(), [
    'categories.json',
    'items.json',
    'page-names.json',
    'wiki.json',
  ]);
  for (const source of provenance.sources)
    assert.equal(
      sha256(await readFile(new URL('catalog/sources/' + source.file, root))),
      source.sha256,
      `Changed source ${source.file}`,
    );
  const revision = sha256(
    Buffer.concat(
      await Promise.all(
        ['categories.json', 'items.json', 'page-names.json'].map((file) =>
          readFile(new URL('catalog/sources/' + file, root)),
        ),
      ),
    ),
  );
  assert.equal(revision, provenance.sourceRevision, 'Source revision mismatch');
  const source = await json<Record<string, Record<string, number[]>>>(
    'catalog/sources/categories.json',
  );
  const names = (
    await json<{ items: Record<string, string> }>('catalog/sources/items.json')
  ).items;
  const snapshot = buildSnapshot(
    source,
    names,
    await json('catalog/sources/page-names.json'),
    await json('catalog/identities.json'),
    provenance,
  );
  const wiki = await json<{
    query: {
      pages: {
        revisions: { revid: number; slots: { main: { content: string } } }[];
      }[];
    };
  }>('catalog/sources/wiki.json');
  const revisionData = wiki.query.pages[0]!.revisions[0]!;
  assert.equal(revisionData.revid, provenance.wikiRevision);
  const wikiItems = JSON.parse(revisionData.slots.main.content) as {
    id: number;
  }[];
  assert.deepEqual(
    wikiItems.map((item) => item.id).sort((a, b) => a - b),
    snapshot.items.flatMap((item) => item.gameItemIds),
    'Wiki item coverage differs',
  );
  const assets = await json<Assets>('catalog/assets.json');
  assert.equal(assets.iconRevision, provenance.iconRevision);
  assert.match(assets.iconRevision, /^[a-f0-9]{40}$/u);
  assert.deepEqual(
    assets.items.map((asset) => asset.gameItemId),
    snapshot.items.flatMap((item) => item.gameItemIds),
    'Asset coverage differs',
  );
  for (const asset of assets.items) {
    assert.equal(
      asset.path,
      `apps/web/public/catalog/items/${asset.gameItemId}.webp`,
    );
    assert.equal(
      asset.url,
      `https://raw.githubusercontent.com/runelite/static.runelite.net/${assets.iconRevision}/cache/item/icon/${asset.gameItemId}.png`,
    );
    const bytes = await readFile(new URL(asset.path, root));
    assert.equal(
      sha256(bytes),
      asset.sha256,
      `Changed icon ${asset.gameItemId}`,
    );
    assert.match(asset.sourceSha256, /^[a-f0-9]{64}$/u);
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
    assert.equal(bytes.readUInt32LE(4) + 8, bytes.length);
    assert.equal(bytes.toString('ascii', 8, 16), 'WEBPVP8L');
    assert.equal(bytes[20], 0x2f);
    const dimensions = bytes.readUInt32LE(21);
    assert.equal((dimensions & 0x3fff) + 1, 36);
    assert.equal(((dimensions >>> 14) & 0x3fff) + 1, 32);
    assert.equal(asset.width, 36);
    assert.equal(asset.height, 32);
    assert.ok(dimensions & (1 << 28), 'Icons must retain transparency');
  }
  assert.deepEqual(
    assets.supporting.map((asset) => asset.path),
    [
      'apps/web/public/fonts/runescape.ttf',
      'apps/web/public/fonts/LICENSE.txt',
      'apps/web/public/ui/panel.webp',
    ],
  );
  for (const asset of assets.supporting)
    assert.equal(
      sha256(
        !asset.path.endsWith('.txt')
          ? await readFile(new URL(asset.path, root))
          : (await readFile(new URL(asset.path, root), 'utf8')).replaceAll(
              '\r\n',
              '\n',
            ),
      ),
      asset.sha256,
      `Changed supporting asset ${asset.path}`,
    );
  return snapshot;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const snapshot = await buildVerifiedSnapshot();
  const serialized = JSON.stringify(snapshot, null, 2) + '\n';
  const path = new URL('catalog/snapshot.json', root);
  if (process.argv.includes('--check'))
    assert.equal(
      await readFile(path, 'utf8'),
      serialized,
      'Run catalog:build and review the diff',
    );
  else await writeFile(path, serialized);
  const hashPath = new URL('catalog/snapshot.sha256', root);
  if (process.argv.includes('--check'))
    assert.equal(
      (await readFile(hashPath, 'utf8')).trim(),
      snapshotId(snapshot),
    );
  else await writeFile(hashPath, snapshotId(snapshot) + '\n');
  console.log(
    `Verified ${snapshot.items.length} items, ${snapshot.pages.length} pages; no collection credits`,
  );
}
