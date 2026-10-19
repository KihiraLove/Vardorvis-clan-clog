/** Public wire models, runtime payload checks and canonical-item display projections. */
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
export type Category = string;
export interface CatalogSection {
  id: string;
  name: string;
}
export const catalogSections = (catalog?: Catalog): readonly CatalogSection[] =>
  catalog?.sections ?? categories;
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
  sections?: CatalogSection[];
  revision: string;
  items: Item[];
  pages: Page[];
}
export interface Credit {
  collectionType?: import('@clog/domain').CollectionType;
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

/** Reject unsafe icon paths, duplicate identities and dangling page memberships. */
export function parseCatalog(value: unknown): Catalog {
  const data = record(value);
  const sections =
    data.sections === undefined
      ? [...categories]
      : array(data.sections).map((entry) => {
          const section = record(entry);
          return { id: text(section.id), name: text(section.name) };
        });
  unique(sections.map((section) => section.id));
  if (sections.length > 100) throw new Error('Too many catalog sections');
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
    if (!sections.some((tab) => tab.id === category))
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
  return {
    revision: text(data.revision),
    items,
    pages,
    ...(data.sections === undefined ? {} : { sections }),
  };
}

export function progressClass(collected: number, total: number): string {
  return collected === 0
    ? 'count-empty'
    : total > 0 && collected === total
      ? 'complete'
      : 'count-partial';
}

/** Normalize approved credits; older responses without hardcore default to ordinary. */
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
    if (
      credit.collectionType !== undefined &&
      credit.collectionType !== 'regular' &&
      credit.collectionType !== 'event'
    )
      throw new Error('Invalid collection type');
    if (credit.hardcore && credit.collectionType === 'event')
      throw new Error('Hardcore cannot have Event collections');
    credits.push({
      submissionId: text(credit.submissionId),
      itemId: id(credit.itemId),
      collectorName: text(credit.collectorName),
      collectedOn,
      hardcore: credit.hardcore === true,
      status: 'approved',
      ...(credit.collectionType === undefined
        ? {}
        : { collectionType: credit.collectionType as 'regular' | 'event' }),
    });
  }
  unique(credits.map((credit) => credit.submissionId));
  unique(
    credits.filter((c) => c.collectionType === 'event').map((c) => c.itemId),
  );
  return { revision: text(data.revision), credits };
}

/** Independently fetched catalog and credits must still form a valid relationship graph. */
export function validateLog(data: LogData): LogData {
  const ids = new Set(data.catalog.items.map((item) => item.id));
  if (data.collections.credits.some((credit) => !ids.has(credit.itemId)))
    throw new Error('Collection refers to an unknown catalog item');
  return data;
}

/** Hardcore is derived from surviving approved credits, never persisted on a page slot. */
export function modeCredits(
  credits: readonly Credit[],
  hardcore: boolean,
): Credit[] {
  return credits.filter(
    (credit) => credit.status === 'approved' && credit.hardcore === hardcore,
  );
}
export function itemState(itemId: number, credits: readonly Credit[]) {
  const state = collectionState(itemId, credits);
  const collectors = state.collectors as Credit[];
  return {
    collected: state.collected,
    collectors,
    hardcoreCollected: collectors.some((credit) => credit.hardcore),
    eventCollected: collectors.some(
      (credit) => !credit.hardcore && credit.collectionType === 'event',
    ),
  };
}
/** Count each canonical item once, even if callers combine overlapping page lists. */
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
/** Use the same collector/date wording for every occurrence of a shared item. */
export function creditLine(credit: Credit): string {
  return `Collected by ${credit.collectorName} on ${formatCollectionDate(credit.collectedOn)}${credit.hardcore ? ' on hardcore worlds' : ''}`;
}
