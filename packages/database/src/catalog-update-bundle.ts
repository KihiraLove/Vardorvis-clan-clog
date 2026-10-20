/** Immutable local WebP bytes are retained in PostgreSQL, including after image upgrades. */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { CatalogUpdateBatch } from '@clog/domain';
import { parseCatalogUpdate } from './catalog-update-model.js';

export interface UpdateImage {
  sha256: string;
  bytes: Buffer;
  width: number;
  height: number;
}
export async function validateUpdateImage(
  bytes: Buffer,
  expected: { sha256: string; width: number; height: number },
): Promise<UpdateImage> {
  if (
    !bytes.length ||
    bytes.length > 2097152 ||
    createHash('sha256').update(bytes).digest('hex') !== expected.sha256
  )
    throw new Error('Catalog update image checksum/size mismatch.');
  const decoder = sharp(bytes, {
    limitInputPixels: 512 * 512,
    failOn: 'warning',
    animated: true,
  });
  const meta = await decoder.metadata();
  if (
    meta.format !== 'webp' ||
    meta.width !== expected.width ||
    meta.height !== expected.height ||
    (meta.pages ?? 1) !== 1
  )
    throw new Error(
      'Catalog update requires a still WebP with the declared dimensions.',
    );
  await decoder.raw().toBuffer();
  return { ...expected, bytes };
}
export async function readCatalogUpdates(
  root = new URL('../../../catalog/updates/', import.meta.url),
): Promise<{ batches: CatalogUpdateBatch[]; images: UpdateImage[] }> {
  const index = JSON.parse(
    await readFile(new URL('index.json', root), 'utf8'),
  ) as { schemaVersion?: number; batches?: unknown };
  if (
    index.schemaVersion !== 1 ||
    Object.keys(index).sort().join() !== 'batches,schemaVersion' ||
    !Array.isArray(index.batches) ||
    index.batches.length > 500 ||
    index.batches.some(
      (b) => typeof b !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,99}$/u.test(b),
    ) ||
    new Set(index.batches).size !== index.batches.length
  )
    throw new Error('Invalid catalog update index.');
  const batches: CatalogUpdateBatch[] = [],
    images = new Map<string, UpdateImage>();
  for (const id of index.batches as string[]) {
    const batch = parseCatalogUpdate(
      JSON.parse(await readFile(new URL(id + '.json', root), 'utf8')),
    );
    if (batch.id !== id)
      throw new Error('Catalog update filename does not match its identity.');
    batches.push(batch);
    for (const item of batch.items)
      if (!images.has(item.image.sha256))
        images.set(
          item.image.sha256,
          await validateUpdateImage(
            await readFile(
              new URL('assets/' + item.image.sha256 + '.webp', root),
            ),
            item.image,
          ),
        );
  }
  return { batches, images: [...images.values()] };
}
