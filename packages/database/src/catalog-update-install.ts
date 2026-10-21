/** Verify all release inputs before changing the installed catalog. */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { CatalogUpdateBatch } from '@clog/domain';
import type { CatalogSnapshot } from './catalog-model.js';
import {
  readCatalogUpdates,
  validateUpdateImage,
  type UpdateImage,
} from './catalog-update-bundle.js';
import { installCatalogUpdate } from './catalog-update-store.js';
import { suppliedImagePath } from './catalog-update-model.js';

export async function prepareBundledCatalogImages(
  snapshot: CatalogSnapshot,
  root = new URL('../../../catalog/', import.meta.url),
): Promise<Map<string, UpdateImage>> {
  const assetBytes = await readFile(new URL('assets.json', root));
  const pinned = (
    await readFile(new URL('legacy-assets.sha256', root), 'utf8')
  ).trim();
  if (createHash('sha256').update(assetBytes).digest('hex') !== pinned)
    throw new Error(
      'Legacy catalog image provenance is immutable. Publish new images in catalog/updates.',
    );
  const assets = JSON.parse(assetBytes.toString('utf8')) as {
    items: { path: string; sha256: string; width: number; height: number }[];
  };
  const result = new Map<string, UpdateImage>();
  for (let offset = 0; offset < assets.items.length; offset += 16) {
    await Promise.all(
      assets.items.slice(offset, offset + 16).map(async (asset) => {
        const iconPath = '/' + asset.path.replace('apps/web/public/', '');
        if (!/^\/catalog\/items\/[1-9]\d*\.webp$/u.test(iconPath))
          throw new Error('Invalid legacy catalog image path.');
        const filename = iconPath.split('/').at(-1)!;
        let bytes: Buffer;
        try {
          bytes = await readFile(new URL('legacy-images/' + filename, root));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          bytes = await readFile(
            new URL('../apps/web/public' + iconPath, root),
          );
        }
        result.set(iconPath, await validateUpdateImage(bytes, asset));
      }),
    );
  }
  if (snapshot.items.some((i) => !result.has(i.iconPath)))
    throw new Error(
      'New item images belong in catalog/updates, not the immutable legacy bundle.',
    );
  return result;
}
export async function freezeBundledImages(
  client: pg.Client,
  images: Map<string, UpdateImage>,
) {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(74261005)');
    for (const [path, image] of images) {
      if (
        !(
          await client.query('SELECT 1 FROM items WHERE icon_path=$1 LIMIT 1', [
            path,
          ])
        ).rowCount
      )
        continue;
      await client.query(
        'INSERT INTO catalog_update_images(sha256,bytes,width,height) VALUES($1,$2,$3,$4) ON CONFLICT(sha256) DO NOTHING',
        [image.sha256, image.bytes, image.width, image.height],
      );
      await client.query('UPDATE items SET icon_path=$2 WHERE icon_path=$1', [
        path,
        suppliedImagePath(image.sha256),
      ]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
export async function prepareCatalogRelease(snapshot: CatalogSnapshot) {
  // Also checks assets on releases with no new batches; existing selected bytes stay durable.
  const images = await prepareBundledCatalogImages(snapshot),
    updates = await readCatalogUpdates();
  return { images, updates };
}
export async function installSnapshotRefresh(
  client: pg.Client,
  snapshot: CatalogSnapshot,
  images: Map<string, UpdateImage>,
  hash: string,
) {
  const batch: CatalogUpdateBatch = {
    id: 'snapshot-' + hash.replace('sha256:', ''),
    title: 'Bundled catalog refresh',
    pages: snapshot.pages.map((p) => ({
      key: p.id,
      name: p.name,
      category: p.category,
    })),
    items: snapshot.items.map((i) => ({
      key: 'item-' + i.id,
      name: i.name,
      gameItemIds: i.gameItemIds,
      image: {
        sha256: images.get(i.iconPath)!.sha256,
        width: images.get(i.iconPath)!.width,
        height: images.get(i.iconPath)!.height,
      },
      pageKeys: snapshot.pages
        .filter((p) => p.itemIds.includes(i.id))
        .map((p) => p.id),
    })),
  };
  return installCatalogUpdate(client, batch, [...images.values()]);
}
