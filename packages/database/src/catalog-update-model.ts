/** Offline release validation and conservative identity discovery. */
import { createHash } from 'node:crypto';
import type {
  CatalogUpdateBatch,
  CatalogUpdateConflict,
  CatalogUpdateItem,
  CatalogUpdatePage,
  CatalogUpdateReview,
} from '@clog/domain';

export const updateHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const suppliedImagePath = (sha: string) =>
  '/api/v1/catalog/update-images/' + sha + '.webp';
export const normalizeCatalogName = (name: string) =>
  name.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();
const key = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,99}$/u.test(value);
const name = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim() === value &&
  value.length > 0 &&
  value.length <= 200 &&
  !Array.from(value).some(
    (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
  );
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const fields = (row: Record<string, unknown>, names: string) =>
  Object.keys(row).sort().join() === names;
export function parseCatalogUpdate(value: unknown): CatalogUpdateBatch {
  if (
    !record(value) ||
    !fields(value, 'id,items,pages,title') ||
    !key(value.id) ||
    !name(value.title) ||
    !Array.isArray(value.items) ||
    !Array.isArray(value.pages) ||
    value.items.length > 10000 ||
    value.pages.length > 2000 ||
    (!value.items.length && !value.pages.length)
  )
    throw new Error('Invalid catalog update batch.');
  const pages: CatalogUpdatePage[] = value.pages.map((p) => {
    if (
      !record(p) ||
      !fields(p, 'category,key,name') ||
      !key(p.key) ||
      !name(p.name) ||
      !key(p.category)
    )
      throw new Error('Invalid update page.');
    return { key: p.key, name: p.name, category: p.category };
  });
  const items: CatalogUpdateItem[] = value.items.map((i) => {
    if (
      !record(i) ||
      !fields(i, 'gameItemIds,image,key,name,pageKeys') ||
      !key(i.key) ||
      !name(i.name) ||
      !Array.isArray(i.gameItemIds) ||
      !i.gameItemIds.length ||
      i.gameItemIds.length > 100 ||
      i.gameItemIds.some(
        (n) => !Number.isSafeInteger(n) || n < 1 || n > 2147483647,
      ) ||
      new Set(i.gameItemIds).size !== i.gameItemIds.length ||
      !Array.isArray(i.pageKeys) ||
      !i.pageKeys.length ||
      i.pageKeys.length > 200 ||
      i.pageKeys.some((p) => !key(p)) ||
      new Set(i.pageKeys).size !== i.pageKeys.length ||
      !record(i.image) ||
      !fields(i.image, 'height,sha256,width') ||
      typeof i.image.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(i.image.sha256) ||
      !Number.isInteger(i.image.width) ||
      Number(i.image.width) < 1 ||
      Number(i.image.width) > 512 ||
      !Number.isInteger(i.image.height) ||
      Number(i.image.height) < 1 ||
      Number(i.image.height) > 512
    )
      throw new Error('Invalid update item or image.');
    return {
      key: i.key,
      name: i.name,
      gameItemIds: [...(i.gameItemIds as number[])].sort((a, b) => a - b),
      image: {
        sha256: i.image.sha256,
        width: Number(i.image.width),
        height: Number(i.image.height),
      },
      pageKeys: [...(i.pageKeys as string[])].sort(),
    };
  });
  if (
    new Set(items.map((i) => i.key)).size !== items.length ||
    new Set(pages.map((p) => p.key)).size !== pages.length ||
    new Set(items.flatMap((i) => i.gameItemIds)).size !==
      items.flatMap((i) => i.gameItemIds).length
  )
    throw new Error('Duplicate update identities.');
  return { id: value.id, title: value.title, items, pages };
}
export interface UpdateLocalItem {
  id: number;
  name: string;
  gameItemIds: number[];
  iconPath: string | null;
  iconHash?: string | null;
  active: boolean;
}
export interface UpdateLocalPage {
  id: string;
  name: string;
  category: string;
  itemIds: number[];
  active: boolean;
}
export interface UpdateCatalog {
  items: UpdateLocalItem[];
  pages: UpdateLocalPage[];
  bindings: { kind: 'item' | 'page'; source_key: string; local_id: string }[];
}
export interface UpdateMatch {
  kind: 'item' | 'page';
  key: string;
  localId: string | null;
  candidate: boolean;
  conflict?: CatalogUpdateConflict;
  pageChoices?: NonNullable<
    CatalogUpdateReview['pageMatches']
  >[number]['candidates'];
}
export function matchCatalogUpdate(
  batch: Pick<CatalogUpdateBatch, 'items' | 'pages'>,
  catalog: UpdateCatalog,
): UpdateMatch[] {
  const matches: UpdateMatch[] = [];
  const trustedItem = (
    m: UpdateMatch | undefined,
  ): m is UpdateMatch & { localId: string } =>
    !!m &&
    !m.candidate &&
    !m.conflict &&
    m.localId !== null &&
    matches.filter(
      (other) => other.kind === 'item' && other.localId === m.localId,
    ).length === 1;
  for (const [kind, entries] of [
    ['item', batch.items],
    ['page', batch.pages],
  ] as const) {
    for (const entry of entries) {
      const binding = catalog.bindings.find(
        (b) => b.kind === kind && b.source_key === entry.key,
      );
      const rows = kind === 'item' ? catalog.items : catalog.pages;
      let candidates = rows.filter(
        (r) => binding && String(r.id) === binding.local_id,
      );
      let candidate = false;
      if (!binding) {
        if (kind === 'item') {
          const item = entry as CatalogUpdateItem;
          const ids = catalog.items.filter((r) =>
            r.gameItemIds.some((id) => item.gameItemIds.includes(id)),
          );
          const names = catalog.items.filter(
            (r) =>
              normalizeCatalogName(r.name) === normalizeCatalogName(entry.name),
          );
          candidates = [
            ...new Map([...ids, ...names].map((r) => [r.id, r])).values(),
          ];
          candidate = ids.length === 0 && candidates.length === 1;
        } else {
          candidates = catalog.pages.filter(
            (r) =>
              r.id === entry.key ||
              normalizeCatalogName(r.name) === normalizeCatalogName(entry.name),
          );
          candidate =
            candidates.length === 1 &&
            String(candidates[0]!.id) !== entry.key &&
            (candidates[0] as UpdateLocalPage).category !==
              (entry as CatalogUpdatePage).category;
          if (!candidates.length) {
            const supplied = batch.items.filter((i) =>
              i.pageKeys.includes(entry.key),
            );
            const trusted = supplied.flatMap((i) => {
              const match = matches.find(
                (m) => m.kind === 'item' && m.key === i.key,
              );
              return match?.localId !== null && match?.localId !== undefined
                ? [Number(match.localId)]
                : (match?.conflict?.candidates.map((c) => Number(c.id)) ?? []);
            });
            candidates = catalog.pages.filter(
              (p) =>
                !catalog.bindings.some(
                  (b) => b.kind === 'page' && b.local_id === p.id,
                ) && p.itemIds.some((id) => trusted.includes(id)),
            );
            candidate = candidates.length > 0;
          }
        }
      }
      const match: UpdateMatch = {
        kind,
        key: entry.key,
        localId: candidates.length === 1 ? String(candidates[0]!.id) : null,
        candidate,
      };
      if (
        kind === 'page' &&
        !binding &&
        candidate &&
        !catalog.pages.some(
          (p) =>
            p.id === entry.key ||
            normalizeCatalogName(p.name) === normalizeCatalogName(entry.name),
        )
      ) {
        const supplied = batch.items.filter((i) =>
          i.pageKeys.includes(entry.key),
        );
        const resolved = supplied.map((i) => ({
          item: i,
          match: matches.find((m) => m.kind === 'item' && m.key === i.key)!,
        }));
        match.pageChoices = (candidates as UpdateLocalPage[]).map((p) => {
          const matched = resolved.filter(
            ({ match: m }) =>
              trustedItem(m) && p.itemIds.includes(Number(m.localId)),
          );
          return {
            id: p.id,
            name: p.name,
            category: p.category,
            active: p.active,
            matchedItems: matched.map(({ item }) => item.name),
            missingItems: supplied
              .filter((i) => !matched.some((m) => m.item.key === i.key))
              .map((i) => i.name),
            extraItems: p.itemIds
              .filter(
                (id) =>
                  !matched.some(({ match: m }) => Number(m.localId) === id),
              )
              .map(
                (id) =>
                  catalog.items.find((i) => i.id === id)?.name ?? String(id),
              ),
          };
        });
      }
      const stolen =
        kind === 'item' &&
        match.localId !== null &&
        catalog.items.some(
          (r) =>
            String(r.id) !== match.localId &&
            r.gameItemIds.some((id) =>
              (entry as CatalogUpdateItem).gameItemIds.includes(id),
            ),
        );
      if (
        (binding && !candidates.length) ||
        candidates.length > 1 ||
        candidates.some((r) => !r.active) ||
        stolen
      )
        match.conflict = {
          entityKey: entry.key,
          kind,
          label: entry.name,
          reason: candidates.some((r) => !r.active)
            ? 'A matching entry was retired. Resolve it in Items catalog before adopting it.'
            : 'Conflicting identity evidence. Resolve game IDs or duplicate entries in Items catalog, then rescan.',
          candidates: candidates.map((r) => ({
            id: String(r.id),
            name: r.name,
          })),
        };
      matches.push(match);
    }
  }
  for (const m of matches) {
    if (
      m.localId !== null &&
      matches.some(
        (other) =>
          other !== m && other.kind === m.kind && other.localId === m.localId,
      )
    )
      m.conflict = {
        entityKey: m.key,
        kind: m.kind,
        label: m.key,
        reason:
          'Several supplied entries match the same local identity. Explicitly resolve the catalog before continuing.',
        candidates: [],
      };
  }
  return matches.sort((a, b) =>
    a.kind === b.kind ? 0 : a.kind === 'page' ? -1 : 1,
  );
}
