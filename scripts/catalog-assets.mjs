/** Restore pinned item artwork. --capture records the first import's asset manifest. */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';

const root = new URL('../', import.meta.url);
const readJson = async (path) =>
  JSON.parse(await readFile(new URL(path, root), 'utf8'));
const provenance = await readJson('catalog/provenance.json');
const identities = await readJson('catalog/identities.json');
const capture = process.argv.includes('--capture');
const prior = capture ? null : await readJson('catalog/assets.json');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ids = Object.keys(identities)
  .map(Number)
  .sort((a, b) => a - b);
const records = new Map();
await mkdir(new URL('apps/web/public/catalog/items/', root), {
  recursive: true,
});
let cursor = 0;
// Four bounded workers avoid sending the upstream thousands of simultaneous requests.
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      const path = `apps/web/public/catalog/items/${id}.webp`;
      const url = `https://raw.githubusercontent.com/runelite/static.runelite.net/${provenance.iconRevision}/cache/item/icon/${id}.png`;
      const expected = prior?.items.find((item) => item.gameItemId === id);
      if (!capture && (!expected || expected.url !== url))
        throw new Error(`Missing pinned asset ${id}`);
      let bytes,
        sourceHash = expected?.sourceSha256;
      try {
        bytes = await readFile(new URL(path, root));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (
        !bytes ||
        !sourceHash ||
        (expected && sha256(bytes) !== expected.sha256)
      ) {
        for (let attempt = 0; attempt < 4; attempt++) {
          const response = await fetch(url, {
            headers: {
              'User-Agent':
                'ClanCollectionLogCatalog/1.0.0-SNAPSHOT (https://github.com/KihiraLove)',
            },
            signal: AbortSignal.timeout(30_000),
          });
          if (
            (response.status === 429 || response.status >= 500) &&
            attempt < 3
          ) {
            await delay(2000 * 2 ** attempt);
            continue;
          }
          if (!response.ok)
            throw new Error(`Icon ${id}: HTTP ${response.status}`);
          const input = Buffer.from(await response.arrayBuffer());
          if (
            input.length > 100_000 ||
            !input.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
          )
            throw new Error(`Invalid upstream PNG ${id}`);
          const metadata = await sharp(input, {
            limitInputPixels: 36 * 32,
            failOn: 'warning',
          }).metadata();
          if (
            metadata.format !== 'png' ||
            metadata.width !== 36 ||
            metadata.height !== 32 ||
            !metadata.hasAlpha ||
            (metadata.pages ?? 1) !== 1
          )
            throw new Error(`Invalid native RGBA icon ${id}`);
          sourceHash = sha256(input);
          if (expected && sourceHash !== expected.sourceSha256)
            throw new Error(`Changed pinned source icon ${id}`);
          bytes = await sharp(input)
            .webp({ lossless: true, effort: 6 })
            .toBuffer();
          break;
        }
      }
      if (!bytes || bytes.length > 100_000 || !sourceHash)
        throw new Error(`Invalid native RGBA icon ${id}`);
      const hash = sha256(bytes);
      if (expected && hash !== expected.sha256)
        throw new Error(`Changed pinned icon ${id}`);
      await writeFile(new URL(path, root), bytes);
      records.set(id, {
        gameItemId: id,
        path,
        url,
        sha256: hash,
        sourceSha256: sourceHash,
        width: 36,
        height: 32,
      });
      if (records.size % 200 === 0)
        console.log(`Verified ${records.size}/${ids.length} icons`);
    }
  }),
);
if (capture) {
  const supporting = [];
  for (const [path, source, dimensions] of [
    [
      'apps/web/public/fonts/runescape.ttf',
      'https://github.com/evansloan/collectionlog.net',
      'TrueType scalable font; no raster dimensions',
    ],
    [
      'apps/web/public/fonts/LICENSE.txt',
      'https://github.com/evansloan/collectionlog.net',
      'text',
    ],
    [
      'apps/web/public/ui/panel.webp',
      'Repository-authored panel texture; see docs/catalog-import.md',
      'Lossless WebP 128 x 128',
    ],
  ])
    supporting.push({
      path,
      source,
      dimensions,
      sha256: sha256(
        !path.endsWith('.txt')
          ? await readFile(new URL(path, root))
          : (await readFile(new URL(path, root), 'utf8')).replaceAll(
              '\r\n',
              '\n',
            ),
      ),
    });
  await writeFile(
    new URL('catalog/assets.json', root),
    JSON.stringify(
      {
        iconRevision: provenance.iconRevision,
        retrievedAt: new Date().toISOString(),
        items: ids.map((id) => records.get(id)),
        supporting,
      },
      null,
      2,
    ) + '\n',
  );
}
console.log(`Verified ${records.size} pinned local icons`);
