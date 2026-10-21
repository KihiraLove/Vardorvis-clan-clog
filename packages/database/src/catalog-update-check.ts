/** Maintainer command: validate cumulative manifests and decode/hash every supplied WebP. */
import { readCatalogUpdates } from './catalog-update-bundle.js';
import type { CatalogUpdateItem } from '@clog/domain';
import { readBundledSnapshot } from './catalog-import.js';
import { prepareBundledCatalogImages } from './catalog-update-install.js';
await prepareBundledCatalogImages(await readBundledSnapshot());
const { batches, images } = await readCatalogUpdates();
const items = new Map<string, CatalogUpdateItem>(),
  pages = new Set<string>();
for (const batch of batches) {
  for (const page of batch.pages) pages.add(page.key);
  for (const item of batch.items) items.set(item.key, item);
  const ids = new Set<number>();
  for (const item of items.values()) {
    for (const id of item.gameItemIds) {
      if (ids.has(id))
        throw new Error('Game ID is assigned to multiple release identities.');
      ids.add(id);
    }
    if (item.pageKeys.some((k: string) => !pages.has(k)))
      throw new Error('Missing page definition in catalog update.');
  }
}
console.log(
  'Catalog updates verified: ' +
    batches.length +
    ' batches, ' +
    items.size +
    ' items, ' +
    images.length +
    ' images.',
);
