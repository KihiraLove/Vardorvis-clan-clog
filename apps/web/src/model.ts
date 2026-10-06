import {
  collectionState,
  formatCollectionDate,
  validateCollectionDate,
} from '@clog/domain';

export const categories = [
  { id: 'bosses', name: 'Bosses' },
  { id: 'raids', name: 'Raids' },
  { id: 'clues', name: 'Clues' },
  { id: 'minigames', name: 'Minigames' },
  { id: 'other', name: 'Other' },
] as const;
export type Category = (typeof categories)[number]['id'];
export interface Item {
  id: number;
  name: string;
  iconPath: string;
}
export interface Page {
  id: string;
  name: string;
  category: Category;
  itemIds: number[];
}
export interface Catalog {
  revision: string;
  items: Item[];
  pages: Page[];
}
export interface Credit {
  submissionId: string;
  itemId: number;
  collectorName: string;
  collectedOn: string;
  hardcore: boolean;
  status: 'approved';
}
export interface Collections {
  revision: string;
  credits: Credit[];
}
export interface LogData {
  catalog: Catalog;
  collections: Collections;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid public log response');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error('Missing public log text');
  return value;
}
function id(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new Error('Invalid canonical item ID');
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Missing public log list');
  return value;
}
function unique<T>(values: T[]): void {
  if (new Set(values).size !== values.length)
    throw new Error('Duplicate public log identity');
}

export function parseCatalog(value: unknown): Catalog {
  const data = record(value);
  const items = array(data.items).map((entry): Item => {
    const item = record(entry);
    const iconPath = text(item.iconPath);
    if (
      !iconPath.startsWith('/') ||
      iconPath.startsWith('//') ||
      /[\\\s?#]/u.test(iconPath)
    )
      throw new Error('Icons must use a same-origin asset path');
    return { id: id(item.id), name: text(item.name), iconPath };
  });
  unique(items.map((item) => item.id));
  const itemIds = new Set(items.map((item) => item.id));
  const pages = array(data.pages).map((entry): Page => {
    const page = record(entry);
    const category = text(page.category);
    if (!categories.some((tab) => tab.id === category))
      throw new Error('Unknown collection log category');
    const ids = array(page.itemIds).map(id);
    unique(ids);
    if (ids.some((itemId) => !itemIds.has(itemId)))
      throw new Error('Unknown page item');
    return {
      id: text(page.id),
      name: text(page.name),
      category: category as Category,
      itemIds: ids,
    };
  });
  unique(pages.map((page) => page.id));
  return { revision: text(data.revision), items, pages };
}

export function parseCollections(value: unknown): Collections {
  const data = record(value);
  const credits: Credit[] = [];
  for (const entry of array(data.credits)) {
    const credit = record(entry);
    // Public reads are approved-only; defend against accidentally supplied queue rows.
    if (credit.status !== undefined && credit.status !== 'approved') continue;
    const collectedOn = text(credit.collectedOn);
    validateCollectionDate(collectedOn);
    if (credit.hardcore !== undefined && typeof credit.hardcore !== 'boolean')
      throw new Error('Invalid hardcore credit');
    credits.push({
      submissionId: text(credit.submissionId),
      itemId: id(credit.itemId),
      collectorName: text(credit.collectorName),
      collectedOn,
      hardcore: credit.hardcore === true,
      status: 'approved',
    });
  }
  unique(credits.map((credit) => credit.submissionId));
  return { revision: text(data.revision), credits };
}

export function validateLog(data: LogData): LogData {
  const ids = new Set(data.catalog.items.map((item) => item.id));
  if (data.collections.credits.some((credit) => !ids.has(credit.itemId)))
    throw new Error('Collection refers to an unknown catalog item');
  return data;
}

export function itemState(itemId: number, credits: readonly Credit[]) {
  const state = collectionState(itemId, credits);
  const collectors = state.collectors as Credit[];
  return {
    collected: state.collected,
    collectors,
    hardcoreCollected: collectors.some((credit) => credit.hardcore),
  };
}
export function progress(
  itemIds: readonly number[],
  credits: readonly Credit[],
) {
  const collected = new Set(
    credits
      .filter((credit) => credit.status === 'approved')
      .map((credit) => credit.itemId),
  );
  const uniqueIds = new Set(itemIds);
  return {
    collected: [...uniqueIds].filter((itemId) => collected.has(itemId)).length,
    total: uniqueIds.size,
  };
}
export function creditLine(credit: Credit): string {
  return `Collected by ${credit.collectorName} on ${formatCollectionDate(credit.collectedOn)}${credit.hardcore ? ' on hardcore worlds' : ''}`;
}
