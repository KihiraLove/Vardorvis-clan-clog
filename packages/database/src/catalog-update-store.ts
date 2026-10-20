/** Release additions and reviewed corrections preserve installation-local identities. */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type {
  CatalogUpdateBatch,
  CatalogUpdateProposal,
  CatalogUpdateReview,
  CatalogUpdateSelection,
} from '@clog/domain';
import {
  matchCatalogUpdate,
  parseCatalogUpdate,
  suppliedImagePath,
  updateHash,
  type UpdateCatalog,
} from './catalog-update-model.js';
import {
  validateUpdateImage,
  type UpdateImage,
} from './catalog-update-bundle.js';

type Client = Pick<pg.Client, 'query'>;
interface BatchRow {
  id: string;
  hash: string;
  manifest: CatalogUpdateBatch;
  summary: { addedItems: string[]; addedPages: string[] };
  review_required: boolean;
}
export class CatalogUpdateError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function updateCatalog(client: Client): Promise<UpdateCatalog> {
  return {
    items: (
      await client.query(
        'SELECT i.id,i.name,i.active,i.icon_path AS "iconPath",a.sha256 AS "iconHash",ARRAY(SELECT game_item_id FROM game_item_ids WHERE item_id=i.id ORDER BY game_item_id) AS "gameItemIds" FROM items i LEFT JOIN catalog_assets a ON a.id=i.icon_asset_id ORDER BY i.id LIMIT 10001',
      )
    ).rows,
    pages: (
      await client.query(
        'SELECT id,name,category,active,ARRAY(SELECT item_id FROM page_items WHERE page_id=p.id ORDER BY slot) AS "itemIds" FROM pages p ORDER BY id LIMIT 2001',
      )
    ).rows,
    bindings: (
      await client.query(
        'SELECT kind,source_key,local_id FROM catalog_update_bindings',
      )
    ).rows,
  };
}
const batches = async (client: Client): Promise<BatchRow[]> =>
  (
    await client.query(
      'SELECT id,hash,manifest,summary,review_required FROM catalog_update_batches ORDER BY sequence LIMIT 501',
    )
  ).rows;
function effective(rows: BatchRow[]) {
  if (rows.length > 500)
    throw new CatalogUpdateError(503, 'Catalog update capacity exceeded.');
  const items = new Map<string, CatalogUpdateBatch['items'][number]>(),
    pages = new Map<string, CatalogUpdateBatch['pages'][number]>();
  for (const row of rows) {
    for (const item of row.manifest.items) items.set(item.key, item);
    for (const page of row.manifest.pages) pages.set(page.key, page);
  }
  const batch = { items: [...items.values()], pages: [...pages.values()] };
  if (
    batch.items.length > 10000 ||
    batch.pages.length > 2000 ||
    new Set(batch.items.flatMap((i) => i.gameItemIds)).size !==
      batch.items.flatMap((i) => i.gameItemIds).length
  )
    throw new CatalogUpdateError(
      422,
      'Release identities conflict across catalog updates.',
    );
  if (batch.items.some((i) => i.pageKeys.some((k) => !pages.has(k))))
    throw new CatalogUpdateError(
      422,
      'Every supplied page key needs a page definition.',
    );
  return batch;
}
async function bind(client: Client, kind: string, key: string, id: string) {
  await client.query(
    'INSERT INTO catalog_update_bindings(kind,source_key,local_id) VALUES($1,$2,$3) ON CONFLICT(kind,source_key) DO NOTHING',
    [kind, key, id],
  );
}
async function audit(
  client: Client,
  actor: string,
  revision: string,
  changes: unknown,
) {
  await client.query(
    'INSERT INTO catalog_update_audit(id,actor_id,revision,changes) VALUES($1,$2,$3,$4)',
    [randomUUID(), actor, revision, JSON.stringify(changes)],
  );
}
async function addMissingCatalogEntries(
  client: Client,
  merged: Pick<CatalogUpdateBatch, 'items' | 'pages'>,
) {
  const catalog = await updateCatalog(client),
    matches = matchCatalogUpdate(merged, catalog);
  if (catalog.items.length > 10000 || catalog.pages.length > 2000)
    throw new Error('Catalog capacity exceeded.');
  const summary = { addedItems: [] as string[], addedPages: [] as string[] };
  const newPages = new Set<string>();
  for (const page of merged.pages) {
    const match = matches.find((m) => m.kind === 'page' && m.key === page.key)!;
    if (match.conflict) continue;
    if (match.localId === null) {
      if (catalog.pages.length + summary.addedPages.length >= 2000)
        throw new Error('Catalog page capacity exceeded.');
      if (
        !(
          await client.query(
            'SELECT 1 FROM catalog_sections WHERE id=$1 AND active',
            [page.category],
          )
        ).rowCount
      )
        throw new Error('Supplied page category does not exist.');
      await client.query(
        'INSERT INTO pages(id,name,category,sort_order) SELECT $1,$2,$3,COALESCE(max(sort_order),-1)+1 FROM pages WHERE category=$3',
        [page.key, page.name, page.category],
      );
      match.localId = page.key;
      newPages.add(page.key);
      summary.addedPages.push(page.name);
    }
    if (!match.candidate) await bind(client, 'page', page.key, match.localId);
  }
  for (const item of merged.items) {
    const match = matches.find((m) => m.kind === 'item' && m.key === item.key)!;
    const pages = item.pageKeys.map((k) =>
      matches.find((m) => m.kind === 'page' && m.key === k)!,
    );
    if (
      match.conflict ||
      pages.some((p) => p.conflict || p.localId === null || p.candidate)
    )
      continue;
    if (match.localId === null) {
      if (catalog.items.length + summary.addedItems.length >= 10000)
        throw new Error('Catalog item capacity exceeded.');
      const image = (
        await client.query(
          'SELECT bytes,width,height FROM catalog_update_images WHERE sha256=$1',
          [item.image.sha256],
        )
      ).rows[0];
      if (!image)
        throw new CatalogUpdateError(503, 'Supplied image is unavailable.');
      await validateUpdateImage(image.bytes, item.image);
      let id: number;
      do {
        id = (
          await client.query(
            "SELECT nextval('canonical_item_id_seq')::int AS id",
          )
        ).rows[0].id;
      } while (
        (await client.query('SELECT 1 FROM items WHERE id=$1', [id])).rowCount
      );
      await client.query(
        'INSERT INTO items(id,name,icon_path) VALUES($1,$2,$3)',
        [id, item.name, suppliedImagePath(item.image.sha256)],
      );
      await client.query(
        'INSERT INTO game_item_ids(game_item_id,item_id) SELECT unnest($1::int[]),$2',
        [item.gameItemIds, id],
      );
      for (const page of pages)
        await client.query(
          'INSERT INTO page_items(page_id,item_id,slot) SELECT $1,$2,COALESCE(max(slot),-1)+1 FROM page_items WHERE page_id=$1',
          [page.localId, id],
        );
      match.localId = String(id);
      summary.addedItems.push(item.name);
    } else if (!match.candidate) {
      for (const page of pages.filter((p) => newPages.has(p.localId!)))
        await client.query(
          'INSERT INTO page_items(page_id,item_id,slot) SELECT $1,$2,COALESCE(max(slot),-1)+1 FROM page_items WHERE page_id=$1',
          [page.localId, match.localId],
        );
    }
    if (!match.candidate) await bind(client, 'item', item.key, match.localId);
  }
  if (
    (await client.query('SELECT count(*)::int AS n FROM page_items')).rows[0]
      .n > 50000
  )
    throw new CatalogUpdateError(422, 'Catalog item-slot capacity exceeded.');
  return summary;
}
/** The owner supplies verified immutable batches; no user requests reach this operation. */
export async function installCatalogUpdate(
  client: Client,
  input: CatalogUpdateBatch,
  images: UpdateImage[],
  fresh = false,
): Promise<'installed' | 'unchanged'> {
  const batch = parseCatalogUpdate(input),
    hash = updateHash(batch);
  for (const item of batch.items) {
    const image = images.find((i) => i.sha256 === item.image.sha256);
    if (!image) throw new Error('Missing catalog update image.');
    await validateUpdateImage(image.bytes, item.image);
  }
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(74261005)');
    const prior = (
      await client.query(
        'SELECT hash FROM catalog_update_batches WHERE id=$1',
        [batch.id],
      )
    ).rows[0];
    if (prior) {
      if (prior.hash !== hash)
        throw new Error(
          'A shipped catalog update is immutable. Publish a new batch ID.',
        );
      const added = await addMissingCatalogEntries(
        client,
        effective(await batches(client)),
      );
      if (added.addedItems.length || added.addedPages.length)
        await audit(client, 'catalog-upgrade', hash, {
          rescan: true,
          ...added,
        });
      await client.query('COMMIT');
      return 'unchanged';
    }
    const rows = await batches(client);
    const merged = effective([
      ...rows,
      {
        id: batch.id,
        hash,
        manifest: batch,
        summary: { addedItems: [], addedPages: [] },
        review_required: !fresh,
      },
    ]);
    for (const image of images)
      if (batch.items.some((i) => i.image.sha256 === image.sha256))
        await client.query(
          'INSERT INTO catalog_update_images(sha256,bytes,width,height) VALUES($1,$2,$3,$4) ON CONFLICT(sha256) DO NOTHING',
          [image.sha256, image.bytes, image.width, image.height],
        );
    const summary = await addMissingCatalogEntries(client, merged);
    await client.query(
      'INSERT INTO catalog_update_batches(id,sequence,hash,manifest,summary,review_required) SELECT $1,COALESCE(max(sequence),0)+1,$2,$3,$4,$5 FROM catalog_update_batches',
      [batch.id, hash, JSON.stringify(batch), JSON.stringify(summary), !fresh],
    );
    await audit(client, 'catalog-upgrade', hash, {
      batchId: batch.id,
      ...summary,
    });
    await client.query('COMMIT');
    return 'installed';
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function review(
  client: Client,
  actor: string,
): Promise<CatalogUpdateReview> {
  const rows = await batches(client),
    merged = effective(rows),
    catalog = await updateCatalog(client),
    matches = matchCatalogUpdate(merged, catalog);
  const revision = updateHash(
    rows.filter((r) => r.review_required).map((r) => [r.id, r.hash]),
  );
  const decisions = new Set(
    (
      await client.query('SELECT proposal_hash FROM catalog_update_decisions')
    ).rows.map((r) => r.proposal_hash as string),
  );
  const proposals: CatalogUpdateProposal[] = [],
    conflicts: CatalogUpdateReview['conflicts'] = [],
    currentImages: CatalogUpdateReview['currentImages'] = [];
  const propose = (p: Omit<CatalogUpdateProposal, 'id'>) => {
    if (p.before === p.after) return;
    const id = updateHash({
      kind: p.kind,
      entityKey: p.entityKey,
      localId: p.localId,
      before: p.before,
      after: p.after,
    });
    if (!decisions.has(id)) proposals.push({ ...p, id });
  };
  const requiredItems = new Set(
      rows
        .filter((r) => r.review_required)
        .flatMap((r) => r.manifest.items.map((i) => i.key)),
    ),
    requiredPages = new Set(
      rows
        .filter((r) => r.review_required)
        .flatMap((r) => r.manifest.pages.map((p) => p.key)),
    );
  for (const page of merged.pages) {
    if (!requiredPages.has(page.key)) continue;
    const m = matches.find((m) => m.kind === 'page' && m.key === page.key)!;
    if (m.conflict) {
      conflicts.push(m.conflict);
      continue;
    }
    if (m.localId === null) {
      conflicts.push({
        entityKey: page.key,
        kind: 'page',
        label: page.name,
        reason: 'The page is missing. Run catalog upgrade processing again.',
        candidates: [],
      });
      continue;
    }
    const local = catalog.pages.find((p) => p.id === m.localId)!;
    const common = { entityKey: page.key, localId: local.id, label: page.name };
    if (m.candidate)
      propose({
        ...common,
        kind: 'adopt',
        before: 'Unlinked local page',
        after: 'Use this local page for ' + page.key,
      });
    propose({
      ...common,
      kind: 'pageName',
      before: local.name,
      after: page.name,
    });
    propose({
      ...common,
      kind: 'pageCategory',
      before: local.category,
      after: page.category,
    });
  }
  for (const item of merged.items) {
    if (!requiredItems.has(item.key)) continue;
    const m = matches.find((m) => m.kind === 'item' && m.key === item.key)!;
    if (m.conflict) {
      conflicts.push(m.conflict);
      continue;
    }
    if (m.localId === null) {
      conflicts.push({
        entityKey: item.key,
        kind: 'item',
        label: item.name,
        reason:
          'A required page is unresolved. Resolve the page and rerun catalog upgrade processing.',
        candidates: [],
      });
      continue;
    }
    const local = catalog.items.find((i) => String(i.id) === m.localId)!;
    const common = {
      entityKey: item.key,
      localId: m.localId,
      label: item.name,
    };
    if (m.candidate)
      propose({
        ...common,
        kind: 'adopt',
        before: 'Unlinked local item',
        after: 'Use this local item for ' + item.key,
      });
    propose({ ...common, kind: 'name', before: local.name, after: item.name });
    propose({
      ...common,
      kind: 'gameIds',
      before: local.gameItemIds.join(', '),
      after: item.gameItemIds.join(', '),
    });
    const path = suppliedImagePath(item.image.sha256);
    const identical =
      local.iconPath === path || local.iconHash === item.image.sha256;
    currentImages.push({
      name: item.name,
      path: local.iconPath ?? '',
      suppliedPath: path,
      identical,
    });
    if (!identical)
      propose({
        ...common,
        kind: 'image',
        before: local.iconPath ?? '',
        after: path,
      });
    for (const pageKey of item.pageKeys) {
      const pm = matches.find((p) => p.kind === 'page' && p.key === pageKey)!;
      if (pm.conflict || pm.localId === null) continue;
      const page = catalog.pages.find((p) => p.id === pm.localId)!;
      if (!page.itemIds.includes(local.id))
        propose({ ...common, kind: 'addLink', before: '', after: page.id });
    }
    const expected = new Set(
      item.pageKeys.map(
        (k) => matches.find((p) => p.kind === 'page' && p.key === k)?.localId,
      ),
    );
    for (const page of catalog.pages.filter(
      (p) => p.active && p.itemIds.includes(local.id) && !expected.has(p.id),
    ))
      propose({ ...common, kind: 'removeLink', before: page.id, after: '' });
  }
  const prompt = (
    await client.query(
      'SELECT revision FROM catalog_update_prompts WHERE actor_id=$1',
      [actor],
    )
  ).rows[0];
  const rescans = (
    await client.query<{
      id: string;
      changes: { addedItems: string[]; addedPages: string[] };
    }>(
      "SELECT id,changes FROM catalog_update_audit WHERE changes->>'rescan'='true' AND (jsonb_array_length(changes->'addedItems')>0 OR jsonb_array_length(changes->'addedPages')>0) ORDER BY created_at DESC,id LIMIT 500",
    )
  ).rows;
  return {
    revision,
    catalogRevision:
      'catalog-' +
      (
        await client.query(
          'SELECT version::text FROM catalog_state WHERE singleton',
        )
      ).rows[0].version,
    autoOpen:
      rows.some((r) => r.review_required) && prompt?.revision !== revision,
    releases: [
      ...rows
        .filter((r) => r.review_required)
        .map((r) => ({ id: r.id, title: r.manifest.title, ...r.summary })),
      ...rescans.map((r) => ({
        id: 'rescan-' + r.id,
        title: 'Additional content installed after resolving identities',
        addedItems: r.changes.addedItems,
        addedPages: r.changes.addedPages,
      })),
    ],
    proposals,
    conflicts,
    currentImages,
  };
}
export class PgCatalogUpdates {
  constructor(private readonly pool: pg.Pool) {}
  private async transaction<T>(
    write: boolean,
    action: (c: pg.PoolClient) => Promise<T>,
  ) {
    const client = await this.pool.connect();
    let committing = false;
    let discard = false;
    try {
      await client.query(
        write ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      if (write) await client.query('SELECT pg_advisory_xact_lock(74261005)');
      const result = await action(client);
      committing = true;
      await client.query('COMMIT');
      committing = false;
      return result;
    } catch (error) {
      discard = committing;
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }
  preview(actor: string) {
    return this.transaction(false, (c) => review(c, actor));
  }
  rescan(actor: string, revision: string, key: string) {
    return this.transaction(true, async (c) => {
      const payload = updateHash({ rescan: revision });
      const replay = (
        await c.query(
          'SELECT payload_hash,result FROM catalog_update_receipts WHERE actor_id=$1 AND request_key=$2',
          [actor, key],
        )
      ).rows[0];
      if (replay) {
        if (replay.payload_hash !== payload)
          throw new CatalogUpdateError(409, 'Request key already used.');
        return replay.result as { addedItems: string[]; addedPages: string[] };
      }
      const current = await review(c, actor);
      if (current.revision !== revision)
        throw new CatalogUpdateError(
          409,
          'A newer catalog update is available. Reload the review.',
        );
      const summary = await addMissingCatalogEntries(
        c,
        effective(await batches(c)),
      );
      await audit(c, actor, revision, { rescan: true, ...summary });
      await c.query(
        'INSERT INTO catalog_update_receipts(actor_id,request_key,payload_hash,result) VALUES($1,$2,$3,$4)',
        [actor, key, payload, JSON.stringify(summary)],
      );
      return summary;
    });
  }
  seen(actor: string, revision: string) {
    return this.transaction(true, async (c) => {
      const current = await review(c, actor);
      if (current.revision !== revision)
        throw new CatalogUpdateError(
          409,
          'A newer catalog update is available. Reload the review.',
        );
      await c.query(
        'INSERT INTO catalog_update_prompts(actor_id,revision) VALUES($1,$2) ON CONFLICT(actor_id) DO UPDATE SET revision=$2,updated_at=now()',
        [actor, revision],
      );
      return { revision };
    });
  }
  apply(actor: string, key: string, selection: CatalogUpdateSelection) {
    return this.transaction(true, async (c) => {
      const payloadHash = updateHash(selection);
      const prior = (
        await c.query(
          'SELECT payload_hash,result FROM catalog_update_receipts WHERE actor_id=$1 AND request_key=$2',
          [actor, key],
        )
      ).rows[0];
      if (prior) {
        if (prior.payload_hash !== payloadHash)
          throw new CatalogUpdateError(
            409,
            'This request key was used for different catalog choices.',
          );
        return prior.result as {
          applied: number;
          kept: number;
          catalogRevision: string;
        };
      }
      const current = await review(c, actor);
      if (
        selection.revision !== current.revision ||
        selection.catalogRevision !== current.catalogRevision
      )
        throw new CatalogUpdateError(
          409,
          'The catalog changed. Reload and review the new differences.',
        );
      const ids = [...selection.apply, ...selection.keep];
      if (
        !ids.length ||
        ids.length > 5000 ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !current.proposals.some((p) => p.id === id))
      )
        throw new CatalogUpdateError(
          422,
          'Select distinct current catalog proposals.',
        );
      const changes = [];
      const rows = await batches(c),
        merged = effective(rows),
        catalog = await updateCatalog(c),
        matches = matchCatalogUpdate(merged, catalog);
      for (const id of selection.apply) {
        const p = current.proposals.find((p) => p.id === id)!;
        const isPage =
          p.kind === 'pageName' ||
          p.kind === 'pageCategory' ||
          (p.kind === 'adopt' && p.before === 'Unlinked local page');
        const kind = isPage ? 'page' : 'item';
        await bind(c, kind, p.entityKey, p.localId);
        if (p.kind === 'name')
          await c.query(
            "UPDATE items SET name=$2,overrides=ARRAY(SELECT DISTINCT unnest(overrides||ARRAY['name'])) WHERE id=$1",
            [p.localId, p.after],
          );
        if (p.kind === 'gameIds') {
          const item = merged.items.find((i) => i.key === p.entityKey)!;
          if (
            (
              await c.query(
                'SELECT 1 FROM game_item_ids WHERE game_item_id=ANY($1::int[]) AND item_id<>$2',
                [item.gameItemIds, p.localId],
              )
            ).rowCount
          )
            throw new CatalogUpdateError(
              409,
              'A supplied game ID belongs to another local item. Resolve it first.',
            );
          await c.query('DELETE FROM game_item_ids WHERE item_id=$1', [
            p.localId,
          ]);
          await c.query(
            'INSERT INTO game_item_ids(game_item_id,item_id) SELECT unnest($1::int[]),$2',
            [item.gameItemIds, p.localId],
          );
          await c.query(
            "UPDATE items SET overrides=ARRAY(SELECT DISTINCT unnest(overrides||ARRAY['game_ids'])) WHERE id=$1",
            [p.localId],
          );
        }
        if (p.kind === 'image') {
          const sha = merged.items.find((i) => i.key === p.entityKey)!.image
            .sha256;
          const image = (
            await c.query(
              'SELECT bytes,width,height FROM catalog_update_images WHERE sha256=$1',
              [sha],
            )
          ).rows[0];
          if (!image)
            throw new CatalogUpdateError(503, 'Supplied image is unavailable.');
          await validateUpdateImage(image.bytes, {
            sha256: sha,
            width: image.width,
            height: image.height,
          });
          await c.query(
            "UPDATE items SET icon_path=$2,icon_asset_id=NULL,overrides=ARRAY(SELECT DISTINCT unnest(overrides||ARRAY['icon'])) WHERE id=$1",
            [p.localId, p.after],
          );
        }
        if (p.kind === 'pageName')
          await c.query('UPDATE pages SET name=$2 WHERE id=$1', [
            p.localId,
            p.after,
          ]);
        if (p.kind === 'pageCategory') {
          if (
            !(
              await c.query(
                'SELECT 1 FROM catalog_sections WHERE id=$1 AND active',
                [p.after],
              )
            ).rowCount
          )
            throw new CatalogUpdateError(
              422,
              'The supplied page section is unavailable.',
            );
          await c.query(
            "UPDATE pages SET category=$2,sort_order=(SELECT COALESCE(max(sort_order),-1)+1 FROM pages WHERE category=$2),position_origin='manual' WHERE id=$1",
            [p.localId, p.after],
          );
        }
        if (p.kind === 'addLink') {
          const pageKey = merged.items
            .find((i) => i.key === p.entityKey)!
            .pageKeys.find((k) =>
              matches.some(
                (m) =>
                  m.kind === 'page' && m.key === k && m.localId === p.after,
              ),
            );
          if (!pageKey)
            throw new CatalogUpdateError(
              409,
              'The supplied page mapping changed.',
            );
          await bind(c, 'page', pageKey, p.after);
          await c.query(
            "INSERT INTO page_items(page_id,item_id,slot,origin) SELECT $1,$2,COALESCE(max(slot),-1)+1,'manual' FROM page_items WHERE page_id=$1",
            [p.after, p.localId],
          );
        }
        if (p.kind === 'removeLink')
          await c.query(
            'DELETE FROM page_items WHERE page_id=$1 AND item_id=$2',
            [p.before, p.localId],
          );
        if (p.kind === 'addLink' || p.kind === 'removeLink')
          await c.query(
            "UPDATE items SET overrides=ARRAY(SELECT DISTINCT unnest(overrides||ARRAY['pages'])) WHERE id=$1",
            [p.localId],
          );
        changes.push(p);
      }
      if (
        (await c.query('SELECT count(*)::int AS n FROM page_items')).rows[0].n >
        50000
      )
        throw new CatalogUpdateError(
          422,
          'Catalog item-slot capacity exceeded.',
        );
      for (const id of ids)
        await c.query(
          'INSERT INTO catalog_update_decisions(proposal_hash,actor_id,decision) VALUES($1,$2,$3)',
          [id, actor, selection.apply.includes(id) ? 'applied' : 'kept'],
        );
      await audit(c, actor, current.revision, {
        applied: changes,
        kept: selection.keep,
      });
      const result = {
        applied: changes.length,
        kept: selection.keep.length,
        catalogRevision:
          'catalog-' +
          (
            await c.query(
              'SELECT version::text FROM catalog_state WHERE singleton',
            )
          ).rows[0].version,
      };
      await c.query(
        'INSERT INTO catalog_update_receipts(actor_id,request_key,payload_hash,result) VALUES($1,$2,$3,$4)',
        [actor, key, payloadHash, JSON.stringify(result)],
      );
      return result;
    });
  }
  async image(sha: string) {
    const row = (
      await this.pool.query(
        'SELECT bytes,width,height FROM catalog_update_images WHERE sha256=$1',
        [sha],
      )
    ).rows[0];
    if (!row)
      throw new CatalogUpdateError(404, 'Catalog update image not found.');
    await validateUpdateImage(row.bytes, {
      sha256: sha,
      width: row.width,
      height: row.height,
    });
    return row.bytes as Buffer;
  }
}
