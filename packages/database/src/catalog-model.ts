/** The offline import contract. Runtime state and preview credits cannot enter this file. */
import { createHash } from 'node:crypto';
import { validateCatalog } from '@clog/domain';

export const categories = [
  'bosses',
  'raids',
  'clues',
  'minigames',
  'other',
] as const;
export interface CatalogSnapshot {
  schemaVersion: 1;
  source: { url: string; revision: string; retrievedAt: string };
  items: {
    id: number;
    name: string;
    gameItemIds: number[];
    iconPath: string;
  }[];
  pages: {
    id: string;
    category: string;
    name: string;
    sortOrder: number;
    itemIds: number[];
  }[];
}
export const sha256 = (bytes: string | Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  Number(value) > 0 &&
  Number(value) <= 2147483647;

/** Validate untrusted JSON before opening a transaction; reject unsupported fields, too. */
export function validateSnapshot(
  value: unknown,
): asserts value is CatalogSnapshot {
  if (
    !record(value) ||
    Object.keys(value).sort().join() !== 'items,pages,schemaVersion,source' ||
    value.schemaVersion !== 1 ||
    !record(value.source) ||
    Object.keys(value.source).sort().join() !== 'retrievedAt,revision,url' ||
    !text(value.source.url) ||
    value.source.url !==
      'https://templeosrs.com/api/collection-log/categories.php' ||
    typeof value.source.revision !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.source.revision) ||
    !text(value.source.retrievedAt) ||
    !Number.isFinite(Date.parse(value.source.retrievedAt)) ||
    !Array.isArray(value.items) ||
    !value.items.length ||
    value.items.length > 10000 ||
    !Array.isArray(value.pages) ||
    !value.pages.length ||
    value.pages.length > 2000
  )
    throw new Error('Invalid catalog snapshot');
  for (const item of value.items) {
    if (
      !record(item) ||
      Object.keys(item).sort().join() !== 'gameItemIds,iconPath,id,name' ||
      !integer(item.id) ||
      !text(item.name) ||
      !Array.isArray(item.gameItemIds) ||
      !item.gameItemIds.length ||
      !item.gameItemIds.every(integer) ||
      typeof item.iconPath !== 'string' ||
      !/^\/catalog\/items\/[1-9]\d*\.webp$/u.test(item.iconPath)
    )
      throw new Error('Invalid imported item');
  }
  let slots = 0;
  for (const page of value.pages) {
    if (
      !record(page) ||
      Object.keys(page).sort().join() !==
        'category,id,itemIds,name,sortOrder' ||
      typeof page.id !== 'string' ||
      !/^[a-z][a-z0-9_]*$/u.test(page.id) ||
      !text(page.name) ||
      !categories.some((category) => category === page.category) ||
      !Number.isSafeInteger(page.sortOrder) ||
      Number(page.sortOrder) < 0 ||
      !Array.isArray(page.itemIds) ||
      !page.itemIds.length ||
      !page.itemIds.every(integer)
    )
      throw new Error('Invalid imported page');
    slots += page.itemIds.length;
  }
  if (slots > 50000) throw new Error('Catalog slot limit exceeded');
  const snapshot = value as unknown as CatalogSnapshot;
  validateCatalog(snapshot.items, snapshot.pages);
}

/** Hash semantic contents, not platform-specific newline formatting. */
export function snapshotId(snapshot: CatalogSnapshot): string {
  validateSnapshot(snapshot);
  return 'sha256:' + sha256(JSON.stringify(snapshot));
}
