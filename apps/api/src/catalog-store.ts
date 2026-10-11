/** Catalog writes share the import lock; each receipt, audit and membership change commits together. */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { ApiError } from './types.js';
import { iconPath, type IconRecord } from './icon-storage.js';
export interface AdminItem {
  id: number;
  name: string;
  iconPath: string;
  origin: 'source' | 'manual';
  overrides: string[];
}
export interface AdminPage {
  id: string;
  name: string;
  category: string;
  itemIds: number[];
  version: string;
  orderOrigin: 'source' | 'manual';
}
export interface AdminCatalog {
  revision: string;
  sourceRevision: string | null;
  items: AdminItem[];
  pages: AdminPage[];
}
export interface NewItem {
  name: string;
  iconAssetId: string;
  pageIds: string[];
}
export interface CreatedItem {
  item: AdminItem;
  pageIds: string[];
  catalogRevision: string;
}
export interface CatalogAsset extends IconRecord {
  actor: string;
  expiresAt: Date;
  itemId: number | null;
}
export class PgCatalogStore {
  constructor(private readonly pool: pg.Pool) {}
  private async transaction<T>(
    write: boolean,
    action: (client: pg.PoolClient) => Promise<T>,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query(
        write ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      if (write) await client.query('SELECT pg_advisory_xact_lock(74261005)');
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  private async revision(client: pg.PoolClient) {
    return (
      await client.query<{ revision: string }>(
        "SELECT 'catalog-' || version AS revision FROM catalog_state WHERE singleton",
      )
    ).rows[0]!.revision;
  }
  private async page(client: pg.PoolClient, id: string): Promise<AdminPage> {
    const page = (
      await client.query<Omit<AdminPage, 'itemIds'>>(
        'SELECT id, name, category, \'page-\' || version AS version, order_origin AS "orderOrigin" FROM pages WHERE id=$1',
        [id],
      )
    ).rows[0];
    if (!page) throw new ApiError(400, 'Choose existing collection-log pages.');
    const rows = (
      await client.query<{ item_id: number }>(
        'SELECT item_id FROM page_items WHERE page_id=$1 ORDER BY slot',
        [id],
      )
    ).rows;
    return { ...page, itemIds: rows.map((row) => row.item_id) };
  }
  async catalog(): Promise<AdminCatalog> {
    return this.transaction(false, async (client) => {
      const items = (
        await client.query<AdminItem>(
          'SELECT id, name, icon_path AS "iconPath", origin, overrides FROM items WHERE active ORDER BY id LIMIT 10001',
        )
      ).rows;
      const pageRows = (
        await client.query<Omit<AdminPage, 'itemIds'>>(
          'SELECT id,name,category,\'page-\' || version AS version,order_origin AS "orderOrigin" FROM pages ORDER BY sort_order,id LIMIT 2001',
        )
      ).rows;
      if (items.length > 10000 || pageRows.length > 2000)
        throw new ApiError(503, 'Catalog exceeds the supported size.');
      const slots = (
        await client.query<{ page_id: string; item_id: number }>(
          'SELECT p.page_id,p.item_id FROM page_items p JOIN items i ON i.id=p.item_id WHERE i.active ORDER BY p.page_id,p.slot LIMIT 50001',
        )
      ).rows;
      if (slots.length > 50000)
        throw new ApiError(503, 'Catalog exceeds the supported size.');
      const membership = new Map<string, number[]>();
      for (const slot of slots) {
        const ids = membership.get(slot.page_id) ?? [];
        ids.push(slot.item_id);
        membership.set(slot.page_id, ids);
      }
      const pages: AdminPage[] = pageRows.map((row) => ({
        ...row,
        itemIds: membership.get(row.id) ?? [],
      }));
      const source = (
        await client.query<{ source_revision: string }>(
          'SELECT source_revision FROM catalog_versions ORDER BY imported_at DESC,id LIMIT 1',
        )
      ).rows[0];
      return {
        revision: await this.revision(client),
        sourceRevision: source?.source_revision ?? null,
        items,
        pages,
      };
    });
  }
  async stage(icon: IconRecord, actor: string) {
    return this.transaction(true, async (client) => {
      const pending = (
        await client.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM catalog_assets WHERE actor_discord_id=$1 AND item_id IS NULL AND expires_at>now()',
          [actor],
        )
      ).rows[0]!.n;
      if (pending >= 20)
        throw new ApiError(
          429,
          'Too many unused icon uploads. Wait for them to expire.',
        );
      const expiresAt = (
        await client.query<{ expires_at: Date }>(
          `INSERT INTO catalog_assets(id,sha256,byte_size,width,height,actor_discord_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '30 minutes') RETURNING expires_at`,
          [icon.id, icon.sha256, icon.byteSize, icon.width, icon.height, actor],
        )
      ).rows[0]!.expires_at;
      return {
        assetId: icon.id,
        iconPath: iconPath(icon.id),
        expiresAt: expiresAt.toISOString(),
      };
    });
  }
  async asset(id: string): Promise<CatalogAsset | null> {
    return (
      (
        await this.pool.query<CatalogAsset>(
          'SELECT id,sha256,byte_size AS "byteSize",width,height,actor_discord_id AS actor,expires_at AS "expiresAt",item_id AS "itemId" FROM catalog_assets WHERE id=$1',
          [id],
        )
      ).rows[0] ?? null
    );
  }
  async create(
    fields: NewItem,
    actor: string,
    key: string,
    verifyAsset: (asset: IconRecord) => Promise<unknown>,
  ): Promise<CreatedItem> {
    const payloadHash = createHash('sha256')
      .update(
        JSON.stringify({ ...fields, pageIds: [...fields.pageIds].sort() }),
      )
      .digest('hex');
    return this.transaction(true, async (client) => {
      const prior = (
        await client.query<{ payload_hash: string; result: CreatedItem }>(
          'SELECT payload_hash,result FROM catalog_requests WHERE actor_discord_id=$1 AND request_key=$2',
          [actor, key],
        )
      ).rows[0];
      if (prior) {
        if (prior.payload_hash !== payloadHash)
          throw new ApiError(
            409,
            'This request key was already used for different fields.',
          );
        return prior.result;
      }
      const pages = (
        await client.query<{ id: string }>(
          'SELECT id FROM pages WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',
          [fields.pageIds],
        )
      ).rows;
      if (
        !fields.pageIds.length ||
        new Set(fields.pageIds).size !== fields.pageIds.length ||
        pages.length !== fields.pageIds.length
      )
        throw new ApiError(
          400,
          'Choose distinct existing collection-log pages.',
        );
      const asset = (
        await client.query<CatalogAsset>(
          'SELECT id,sha256,byte_size AS "byteSize",width,height,actor_discord_id AS actor,expires_at AS "expiresAt",item_id AS "itemId" FROM catalog_assets WHERE id=$1 FOR UPDATE',
          [fields.iconAssetId],
        )
      ).rows[0];
      if (
        !asset ||
        asset.actor !== actor ||
        asset.itemId !== null ||
        asset.expiresAt.getTime() <= Date.now()
      )
        throw new ApiError(
          409,
          'Upload a fresh icon before creating this item.',
        );
      await verifyAsset(asset);
      const limits = (
        await client.query<{ items: number; slots: number }>(
          'SELECT (SELECT count(*)::int FROM items) AS items,(SELECT count(*)::int FROM page_items) AS slots',
        )
      ).rows[0]!;
      if (limits.items >= 10000 || limits.slots + pages.length > 50000)
        throw new ApiError(409, 'Catalog capacity reached.');
      // Explicit IDs in a newly imported snapshot may be ahead of the sequence.
      await client.query(
        "SELECT setval('canonical_item_id_seq', GREATEST((SELECT COALESCE(max(id),0)+1 FROM items), nextval('canonical_item_id_seq')), false)",
      );
      const item = (
        await client.query<AdminItem>(
          `INSERT INTO items(name,icon_path,origin,overrides,icon_asset_id) VALUES($1,$2,'manual',ARRAY['name','icon','pages'],$3) RETURNING id,name,icon_path AS "iconPath",origin,overrides`,
          [fields.name, iconPath(asset.id), asset.id],
        )
      ).rows[0]!;
      await client.query('UPDATE catalog_assets SET item_id=$1 WHERE id=$2', [
        item.id,
        asset.id,
      ]);
      for (const page of pages)
        await client.query(
          "INSERT INTO page_items(page_id,item_id,slot,origin) SELECT $1,$2,COALESCE(max(slot),-1)+1,'manual' FROM page_items WHERE page_id=$1",
          [page.id, item.id],
        );
      const result = {
        item,
        pageIds: fields.pageIds,
        catalogRevision: await this.revision(client),
      };
      await client.query(
        "INSERT INTO catalog_audit(actor_discord_id,action,item_id,after_value) VALUES($1,'create',$2,$3)",
        [actor, item.id, JSON.stringify(result)],
      );
      await client.query(
        'INSERT INTO catalog_requests(actor_discord_id,request_key,payload_hash,result) VALUES($1,$2,$3,$4)',
        [actor, key, payloadHash, JSON.stringify(result)],
      );
      return result;
    });
  }
  async reorder(
    pageId: string,
    ids: number[],
    expectedVersion: string,
    actor: string,
  ) {
    return this.transaction(true, async (client) => {
      await client.query('SELECT id FROM pages WHERE id=$1 FOR UPDATE', [
        pageId,
      ]);
      const before = await this.page(client, pageId);
      if (before.version !== expectedVersion)
        throw new ApiError(
          409,
          'Page membership or order changed. Reload before saving.',
        );
      if (
        ids.length !== before.itemIds.length ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !before.itemIds.includes(id))
      )
        throw new ApiError(400, 'Supply every current page item exactly once.');
      // Delete/reinsert within this transaction avoids the immediate UNIQUE(page,slot)
      // constraint without changing membership provenance, items or collection credits.
      const memberships = (
        await client.query<{ item_id: number; origin: string }>(
          'DELETE FROM page_items WHERE page_id=$1 RETURNING item_id,origin',
          [pageId],
        )
      ).rows;
      const origins = new Map(
        memberships.map((row) => [row.item_id, row.origin]),
      );
      await client.query(
        `INSERT INTO page_items(page_id,item_id,slot,origin) SELECT $1,item_id,slot,origin FROM jsonb_to_recordset($2::jsonb) AS x(item_id integer,slot integer,origin text)`,
        [
          pageId,
          JSON.stringify(
            ids.map((id, slot) => ({
              item_id: id,
              slot,
              origin: origins.get(id),
            })),
          ),
        ],
      );
      await client.query("UPDATE pages SET order_origin='manual' WHERE id=$1", [
        pageId,
      ]);
      const page = await this.page(client, pageId);
      await client.query(
        "INSERT INTO catalog_audit(actor_discord_id,action,page_id,before_value,after_value) VALUES($1,'reorder',$2,$3,$4)",
        [actor, pageId, JSON.stringify(before), JSON.stringify(page)],
      );
      return { page, catalogRevision: await this.revision(client) };
    });
  }
  /** Remove active memberships and visibility while preserving stable IDs and claim history. */
  async deleteItem(id: number, expectedRevision: string, actor: string) {
    return this.transaction(true, async (client) => {
      if ((await this.revision(client)) !== expectedRevision)
        throw new ApiError(
          409,
          'The catalog changed. Reload before deleting an item.',
        );
      const before = (
        await client.query(
          'SELECT id,name,origin,active FROM items WHERE id=$1 AND active FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (!before) throw new ApiError(404, 'Catalog item not found.');
      const memberships = (
        await client.query<{ page_id: string }>(
          'SELECT page_id FROM page_items WHERE item_id=$1 ORDER BY page_id',
          [id],
        )
      ).rows;
      await client.query(
        'SELECT id FROM pages WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',
        [memberships.map((row) => row.page_id)],
      );
      for (const { page_id: pageId } of memberships) {
        const rows = (
          await client.query<{ item_id: number; origin: string; slot: number }>(
            'DELETE FROM page_items WHERE page_id=$1 RETURNING item_id,origin,slot',
            [pageId],
          )
        ).rows;
        // Preserve every remaining origin and relative order, compacting slots without collisions.
        const ordered = rows
          .sort((a, b) => a.slot - b.slot)
          .filter((row) => row.item_id !== id);
        await client.query(
          `INSERT INTO page_items(page_id,item_id,slot,origin) SELECT $1,item_id,slot,origin FROM jsonb_to_recordset($2::jsonb) AS x(item_id integer,slot integer,origin text)`,
          [
            pageId,
            JSON.stringify(
              ordered.map((row, slot) => ({
                item_id: row.item_id,
                origin: row.origin,
                slot,
              })),
            ),
          ],
        );
      }
      await client.query('UPDATE items SET active=false WHERE id=$1', [id]);
      await client.query(
        "INSERT INTO catalog_audit(actor_discord_id,action,item_id,before_value,after_value) VALUES($1,'delete',$2,$3,$4)",
        [
          actor,
          id,
          JSON.stringify({
            ...before,
            pageIds: memberships.map((row) => row.page_id),
          }),
          JSON.stringify({ id, active: false, pageIds: [] }),
        ],
      );
      return { itemId: id, catalogRevision: await this.revision(client) };
    });
  }
  /** Explicit identity reconciliation for a future source entry; never reassign another item's alias. */
  async reconcile(
    itemId: number,
    gameItemIds: number[],
    expectedRevision: string,
    reason: string,
    actor: string,
  ) {
    return this.transaction(true, async (client) => {
      if ((await this.revision(client)) !== expectedRevision)
        throw new ApiError(409, 'Catalog changed. Review the latest mapping.');
      const item = (
        await client.query(
          'SELECT id FROM items WHERE id=$1 AND active FOR UPDATE',
          [itemId],
        )
      ).rows[0];
      if (!item)
        throw new ApiError(400, 'Choose an existing active canonical item.');
      const before = (
        await client.query<{ game_item_id: number }>(
          'SELECT game_item_id FROM game_item_ids WHERE item_id=$1 ORDER BY game_item_id',
          [itemId],
        )
      ).rows.map((row) => row.game_item_id);
      const conflicts = await client.query(
        'SELECT game_item_id FROM game_item_ids WHERE game_item_id=ANY($1::integer[]) AND item_id<>$2',
        [gameItemIds, itemId],
      );
      if (conflicts.rowCount)
        throw new ApiError(
          409,
          'A game ID already belongs to another canonical item. No identities were merged.',
        );
      for (const id of gameItemIds)
        await client.query(
          'INSERT INTO game_item_ids(game_item_id,item_id) VALUES($1,$2) ON CONFLICT(game_item_id) DO NOTHING',
          [id, itemId],
        );
      const aliases = [...new Set([...before, ...gameItemIds])].sort(
        (a, b) => a - b,
      );
      await client.query(
        "INSERT INTO catalog_audit(actor_discord_id,action,item_id,before_value,after_value,reason) VALUES($1,'reconcile',$2,$3,$4,$5)",
        [
          actor,
          itemId,
          JSON.stringify({ gameItemIds: before }),
          JSON.stringify({ gameItemIds: aliases }),
          reason,
        ],
      );
      return {
        itemId,
        gameItemIds: aliases,
        catalogRevision: await this.revision(client),
      };
    });
  }
}
