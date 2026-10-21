import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import {
  readCatalogUpdates,
  validateUpdateImage,
} from './catalog-update-bundle.js';
import { prepareBundledCatalogImages } from './catalog-update-install.js';
import type { CatalogSnapshot } from './catalog-model.js';
test('release loader validates all manifest/image inputs before installation and rejects mutated or missing assets', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'clog-update-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = pathToFileURL(directory + '/');
  const bytes = await sharp({
    create: { width: 2, height: 2, channels: 4, background: '#abc' },
  })
    .webp({ lossless: true })
    .toBuffer();
  const image = {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    width: 2,
    height: 2,
  };
  const batch = {
    id: 'release-one',
    title: 'Release one',
    pages: [{ key: 'archive', name: 'Archive', category: 'raids' }],
    items: [
      {
        key: 'relic',
        name: 'Relic',
        gameItemIds: [50001],
        image,
        pageKeys: ['archive'],
      },
    ],
  };
  await mkdir(join(directory, 'assets'));
  await writeFile(
    join(directory, 'index.json'),
    JSON.stringify({ schemaVersion: 1, batches: ['release-one'] }),
  );
  await writeFile(join(directory, 'release-one.json'), JSON.stringify(batch));
  await writeFile(join(directory, 'assets', image.sha256 + '.webp'), bytes);
  assert.equal((await readCatalogUpdates(root)).images.length, 1);
  await assert.rejects(
    validateUpdateImage(bytes, { ...image, width: 3 }),
    /dimensions/,
  );
  await assert.rejects(
    validateUpdateImage(Buffer.from('bad'), image),
    /checksum/,
  );
  await writeFile(
    join(directory, 'assets', image.sha256 + '.webp'),
    Buffer.from('bad'),
  );
  await assert.rejects(readCatalogUpdates(root), /checksum/);
  await rm(join(directory, 'assets', image.sha256 + '.webp'));
  await assert.rejects(readCatalogUpdates(root), { code: 'ENOENT' });
  await writeFile(
    join(directory, 'index.json'),
    JSON.stringify({ schemaVersion: 1, batches: ['../escape'] }),
  );
  await assert.rejects(readCatalogUpdates(root), /index/);
});
test('legacy asset pin prevents replacing current artwork before admin review, including items removed from a later snapshot', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'clog-legacy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = pathToFileURL(directory + '/');
  await mkdir(join(directory, 'legacy-images'));
  const bytes = await sharp({
    create: { width: 2, height: 2, channels: 4, background: '#abc' },
  })
    .webp({ lossless: true })
    .toBuffer();
  const assets = JSON.stringify({
    items: [
      {
        path: 'apps/web/public/catalog/items/1.webp',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        width: 2,
        height: 2,
      },
    ],
  });
  await writeFile(join(directory, 'assets.json'), assets);
  await writeFile(
    join(directory, 'legacy-assets.sha256'),
    createHash('sha256').update(assets).digest('hex'),
  );
  await writeFile(join(directory, 'legacy-images/1.webp'), bytes);
  const snapshot: CatalogSnapshot = {
    schemaVersion: 1,
    source: {
      url: 'https://templeosrs.com/api/collection-log/categories.php',
      revision: 'a'.repeat(64),
      retrievedAt: '2026-10-20T00:00:00Z',
    },
    items: [],
    pages: [],
  };
  assert.equal((await prepareBundledCatalogImages(snapshot, root)).size, 1);
  await writeFile(join(directory, 'assets.json'), assets + ' ');
  await assert.rejects(
    prepareBundledCatalogImages(snapshot, root),
    /immutable/,
  );
});
