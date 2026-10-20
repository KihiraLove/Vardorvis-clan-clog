/** Private upgrade transport stays outside the public entry bundle. */
import type {
  CatalogUpdateReview,
  CatalogUpdateSelection,
  CatalogUpdateProposal,
} from '@clog/domain';
import { AdminRequestError } from './admin-api.ts';
import { object, list, text, unique } from './xp-model.ts';

const hash = (v: unknown) => {
  const value = text(v);
  if (!/^[a-f0-9]{64}$/u.test(value))
    throw new Error('Invalid catalog update hash.');
  return value;
};
const path = (v: unknown) => {
  const value = typeof v === 'string' ? v : '';
  if (
    value &&
    !/^\/(?:catalog\/items\/[1-9]\d*|api\/v1\/catalog\/(?:icons\/[a-f0-9-]{36}|update-images\/[a-f0-9]{64}))\.webp$/u.test(
      value,
    )
  )
    throw new Error('Invalid catalog image path.');
  return value;
};
export function parseCatalogUpdateReview(value: unknown): CatalogUpdateReview {
  const row = object(value);
  const revision = hash(row.revision),
    catalogRevision = text(row.catalogRevision);
  if (
    !/^catalog-[1-9][0-9]*$/u.test(catalogRevision) ||
    typeof row.autoOpen !== 'boolean'
  )
    throw new Error('Invalid catalog update revision.');
  const proposals = list(row.proposals).map((value) => {
    const p = object(value);
    if (
      ![
        'name',
        'gameIds',
        'addGameId',
        'removeGameId',
        'image',
        'pageName',
        'pageCategory',
        'addLink',
        'removeLink',
        'adopt',
        'adoptPage',
        'createPage',
      ].includes(String(p.kind)) ||
      typeof p.before !== 'string' ||
      typeof p.after !== 'string'
    )
      throw new Error('Invalid catalog proposal.');
    const result = {
      id: hash(p.id),
      kind: p.kind as CatalogUpdateProposal['kind'],
      entityKey: text(p.entityKey),
      localId: text(p.localId),
      label: text(p.label),
      before: p.before,
      after: p.after,
    };
    if (result.kind === 'image') {
      path(result.before);
      path(result.after);
    }
    return result;
  });
  if (proposals.length > 20000) throw new Error('Catalog review is too large.');
  unique(proposals.map((p) => p.id));
  const releases = list(row.releases).map((value) => {
    const r = object(value);
    return {
      id: text(r.id),
      title: text(r.title),
      addedItems: list(r.addedItems).map(text),
      addedPages: list(r.addedPages).map(text),
    };
  });
  const conflicts = list(row.conflicts).map((value) => {
    const c = object(value);
    if (!['item', 'page'].includes(String(c.kind)))
      throw new Error('Invalid catalog conflict.');
    return {
      kind: c.kind as 'item' | 'page',
      entityKey: text(c.entityKey),
      label: text(c.label),
      reason: text(c.reason),
      candidates: list(c.candidates).map((value) => {
        const c = object(value);
        return { id: text(c.id), name: text(c.name) };
      }),
    };
  });
  const currentImages = list(row.currentImages).map((value) => {
    const i = object(value);
    if (typeof i.identical !== 'boolean')
      throw new Error('Invalid catalog image status.');
    return {
      name: text(i.name),
      path: path(i.path),
      suppliedPath: path(i.suppliedPath),
      identical: i.identical,
    };
  });
  const gameIds = (value: unknown) =>
    list(value).map((id) => {
      if (
        !Number.isSafeInteger(id) ||
        Number(id) < 1 ||
        Number(id) > 2147483647
      )
        throw new Error('Invalid game item ID.');
      return Number(id);
    });
  const pageMatches = list(row.pageMatches ?? []).map((value) => {
    const m = object(value);
    return {
      entityKey: text(m.entityKey),
      label: text(m.label),
      candidates: list(m.candidates).map((value) => {
        const c = object(value);
        if (typeof c.active !== 'boolean')
          throw new Error('Invalid page candidate.');
        return {
          id: text(c.id),
          name: text(c.name),
          category: text(c.category),
          active: c.active,
          matchedItems: list(c.matchedItems).map(text),
          missingItems: list(c.missingItems).map(text),
          extraItems: list(c.extraItems).map(text),
        };
      }),
    };
  });
  const gameIdReviews = list(row.gameIdReviews ?? []).map((value) => {
    const r = object(value);
    return {
      entityKey: text(r.entityKey),
      localId: text(r.localId),
      label: text(r.label),
      localIds: gameIds(r.localIds),
      suppliedIds: gameIds(r.suppliedIds),
    };
  });
  if (
    releases.length > 1000 ||
    conflicts.length > 12000 ||
    currentImages.length > 10000
  )
    throw new Error('Catalog review limit exceeded.');
  return {
    revision,
    catalogRevision,
    autoOpen: row.autoOpen,
    releases,
    proposals,
    conflicts,
    currentImages,
    pageMatches,
    gameIdReviews,
  };
}
async function request(
  operation: string,
  signal: AbortSignal,
  csrf?: string,
  body?: unknown,
  key?: string,
) {
  const response = await fetch('/api/v1/admin/catalog-updates' + operation, {
    signal,
    cache: 'no-store',
    credentials: 'same-origin',
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrf!,
            ...(key ? { 'Idempotency-Key': key } : {}),
          },
          body: JSON.stringify(body),
        }),
  });
  if (!response.ok) {
    let message: string | undefined;
    try {
      const r = object(await response.json());
      if (typeof r.error === 'string' && r.error.length < 300)
        message = r.error;
    } catch {
      /* Status remains authoritative for HTML proxy errors. */
    }
    const error = new AdminRequestError(response.status);
    if (message && [409, 422, 503].includes(response.status))
      error.message = message;
    throw error;
  }
  return response.json() as Promise<unknown>;
}
export async function catalogUpdates(signal: AbortSignal) {
  return parseCatalogUpdateReview(await request('', signal));
}
export async function catalogUpdateSeen(
  revision: string,
  csrf: string,
  signal: AbortSignal,
) {
  const r = object(await request('/seen', signal, csrf, { revision }));
  if (hash(r.revision) !== revision)
    throw new Error('Unexpected catalog review receipt.');
}
export async function applyCatalogUpdate(
  selection: CatalogUpdateSelection,
  key: string,
  csrf: string,
  signal: AbortSignal,
) {
  const r = object(await request('/apply', signal, csrf, selection, key));
  if (
    !Number.isInteger(r.applied) ||
    r.applied !== selection.apply.length ||
    r.kept !== selection.keep.length ||
    !/^catalog-[1-9][0-9]*$/u.test(text(r.catalogRevision))
  )
    throw new Error(
      'Could not confirm catalog changes. Retry the same choices.',
    );
  return { applied: Number(r.applied), kept: Number(r.kept) };
}
export async function rescanCatalogUpdate(
  revision: string,
  key: string,
  csrf: string,
  signal: AbortSignal,
) {
  const r = object(await request('/rescan', signal, csrf, { revision }, key));
  return {
    addedItems: list(r.addedItems).map(text),
    addedPages: list(r.addedPages).map(text),
  };
}
