/** Catalog writes share the import lock; each receipt, audit and membership change commits together. */
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { transaction } from './transaction.js';
import { ApiError } from './types.js';
import { iconPath, type IconRecord } from './icon-storage.js';
import { removePermanentPage } from './scheduling-store.js';
export interface AdminItem {
  id: number;
  name: string;
  iconPath: string;
  origin: 'source' | 'manual';
  overrides: string[];
  gameItemIds?: number[];
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
  collectedItemIds?: number[];
  sections: { id: string; name: string }[];
  revision: string;
  sourceRevision: string | null;
  items: AdminItem[];
  pages: AdminPage[];
}
export interface NewItem {
  gameItemIds: number[];
  name: string;
  iconAssetId: string;
  pageIds: string[];
}
export interface CreatedItem {
  item: AdminItem;
  pageIds: string[];
  catalogRevision: string;
}
export interface NewPage {
  name: string;
  category: string;
  itemIds: number[];
  expectedRevision: string;
}
export interface CreatedPage {
  page: AdminPage;
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
    return transaction(
      this.pool,
      write ? 'write' : 'snapshot',
      async (client) => {
        if (write) await client.query('SELECT pg_advisory_xact_lock(74261005)');
        return action(client);
      },
    );
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
        'SELECT id, name, category, \'page-\' || version AS version, order_origin AS "orderOrigin" FROM pages WHERE id=$1 AND active',
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
          'SELECT id, name, icon_path AS "iconPath", origin, overrides, ARRAY(SELECT game_item_id FROM game_item_ids WHERE item_id=items.id ORDER BY game_item_id) AS "gameItemIds" FROM items WHERE active ORDER BY id LIMIT 10001',
        )
      ).rows;
      const pageRows = (
        await client.query<Omit<AdminPage, 'itemIds'>>(
          'SELECT id,name,category,\'page-\' || version AS version,order_origin AS "orderOrigin" FROM pages WHERE active ORDER BY sort_order,id LIMIT 2001',
        )
      ).rows;
      if (items.length > 10000 || pageRows.length > 2000)
        throw new ApiError(503, 'Catalog exceeds the supported size.');
      const slots = (
        await client.query<{ page_id: string; item_id: number }>(
          'SELECT p.page_id,p.item_id FROM page_items p JOIN items i ON i.id=p.item_id JOIN pages g ON g.id=p.page_id WHERE i.active AND g.active ORDER BY p.page_id,p.slot LIMIT 50001',
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
        collectedItemIds: (
          await client.query<{ item_id: number }>(
            'SELECT item_id FROM collection_credits WHERE NOT hardcore ORDER BY item_id',
          )
        ).rows.map((r) => r.item_id),
        sections: (
          await client.query<{ id: string; name: string }>(
            'SELECT id,name FROM catalog_sections WHERE active ORDER BY sort_order,id',
          )
        ).rows,
        revision: await this.revision(client),
        sourceRevision: source?.source_revision ?? null,
        items,
        pages,
      };
    });
  }
  async createPage(
    fields: NewPage,
    actor: string,
    key: string,
  ): Promise<CreatedPage> {
    return this.transaction(true, async (client) => {
      const payload = createHash('sha256')
        .update(
          JSON.stringify({
            name: fields.name,
            category: fields.category,
            itemIds: fields.itemIds,
          }),
        )
        .digest('hex');
      const prior = (
        await client.query(
          'SELECT payload_hash,result FROM catalog_page_requests WHERE actor_discord_id=$1 AND request_key=$2',
          [actor, key],
        )
      ).rows[0];
      if (prior) {
        if (prior.payload_hash !== payload)
          throw new ApiError(
            409,
            'This request key was used for different page details.',
          );
        return prior.result as CreatedPage;
      }
      if ((await this.revision(client)) !== fields.expectedRevision)
        throw new ApiError(
          409,
          'The catalog changed. Reload before adding a page.',
        );
      await this.section(client, fields.category);
      if (
        (
          await client.query(
            'SELECT 1 FROM pages WHERE active AND category=$1 AND lower(name)=lower($2)',
            [fields.category, fields.name],
          )
        ).rowCount
      )
        throw new ApiError(
          400,
          'A page with this name already exists in this category.',
        );
      const capacity = (
        await client.query(
          'SELECT (SELECT count(*) FROM pages WHERE active)::int AS pages,(SELECT count(*) FROM page_items)::int AS slots',
        )
      ).rows[0];
      if (
        capacity.pages >= 2000 ||
        capacity.slots + fields.itemIds.length > 50000
      )
        throw new ApiError(
          409,
          'The catalog has reached its page or item-slot limit.',
        );
      const items = (
        await client.query(
          'SELECT id FROM items WHERE id=ANY($1::integer[]) AND active ORDER BY id FOR UPDATE',
          [fields.itemIds],
        )
      ).rows;
      if (
        items.length !== fields.itemIds.length ||
        new Set(fields.itemIds).size !== fields.itemIds.length
      )
        throw new ApiError(400, 'Choose distinct active catalog items.');
      const id = 'manual-page-' + randomUUID();
      await client.query(
        "INSERT INTO pages(id,name,category,sort_order,order_origin,position_origin) SELECT $1,$2,$3,COALESCE(max(sort_order),-1)+1,'manual','manual' FROM pages",
        [id, fields.name, fields.category],
      );
      await client.query(
        "INSERT INTO page_items(page_id,item_id,slot,origin) SELECT $1,item_id,slot,'manual' FROM jsonb_to_recordset($2::jsonb) AS x(item_id integer,slot integer)",
        [
          id,
          JSON.stringify(
            fields.itemIds.map((item_id, slot) => ({ item_id, slot })),
          ),
        ],
      );
      const page = await this.page(client, id);
      await client.query(
        "INSERT INTO catalog_audit(actor_discord_id,action,page_id,after_value) VALUES($1,'create_page',$2,$3)",
        [actor, id, JSON.stringify(page)],
      );
      const result = { page, catalogRevision: await this.revision(client) };
      await client.query(
        'INSERT INTO catalog_page_requests(actor_discord_id,request_key,payload_hash,result) VALUES($1,$2,$3,$4)',
        [actor, key, payload, JSON.stringify(result)],
      );
      return result;
    });
  }
  async removePage(
    id: string,
    revision: string,
    version: string,
    actor: string,
  ) {
    return this.transaction(true, async (client) => {
      await removePermanentPage(client, id, actor);
      if ((await this.revision(client)) !== revision)
        throw new ApiError(
          409,
          'The catalog changed. Reload before deleting a page.',
        );
      // Match item-deletion lock order so review/intake cannot race retirement.
      await client.query(
        'SELECT i.id FROM items i JOIN page_items p ON p.item_id=i.id WHERE p.page_id=$1 ORDER BY i.id FOR UPDATE OF i',
        [id],
      );
      await client.query(
        'SELECT id FROM pages WHERE id=$1 AND active FOR UPDATE',
        [id],
      );
      const before = await this.page(client, id);
      if (before.version !== version)
        throw new ApiError(409, 'The page changed. Reload before deleting.');
      await client.query('DELETE FROM page_items WHERE page_id=$1', [id]);
      await client.query('UPDATE pages SET active=false WHERE id=$1', [id]);
      const retired: number[] = [];
      await client.query(
        "INSERT INTO catalog_audit(actor_discord_id,action,page_id,before_value,after_value) VALUES($1,'delete_page',$2,$3,$4)",
        [
          actor,
          id,
          JSON.stringify(before),
          JSON.stringify({ id, active: false, retiredItemIds: retired }),
        ],
      );
      return {
        pageId: id,
        retiredItemIds: retired,
        catalogRevision: await this.revision(client),
      };
    });
  }
  async reorderPages(
    category: string,
    orderedPageIds: string[],
    revision: string,
    actor: string,
  ) {
    return this.transaction(true, async (client) => {
      if ((await this.revision(client)) !== revision)
        throw new ApiError(
          409,
          'The catalog changed. Reload before reordering pages.',
        );
      const before = (
        await client.query<{ id: string }>(
          'SELECT id FROM pages WHERE active AND category=$1 ORDER BY sort_order,id FOR UPDATE',
          [category],
        )
      ).rows.map((row) => row.id);
      if (
        !before.length ||
        before.length !== orderedPageIds.length ||
        new Set(orderedPageIds).size !== before.length ||
        orderedPageIds.some((id) => !before.includes(id))
      )
        throw new ApiError(
          400,
          'Supply every active page in this category exactly once.',
        );
      await client.query(
        "UPDATE pages p SET sort_order=x.position,position_origin='manual' FROM jsonb_to_recordset($1::jsonb) AS x(id text,position integer) WHERE p.id=x.id",
        [
          JSON.stringify(
            orderedPageIds.map((id, position) => ({ id, position })),
          ),
        ],
      );
      await client.query(
        "INSERT INTO catalog_audit(actor_discord_id,action,before_value,after_value) VALUES($1,'reorder_pages',$2,$3)",
        [
          actor,
          JSON.stringify({ category, pageIds: before }),
          JSON.stringify({ category, pageIds: orderedPageIds }),
        ],
      );
      return {
        category,
        orderedPageIds,
        catalogRevision: await this.revision(client),
      };
    });
  }
  private async requireRevision(client: pg.PoolClient, revision: string) {
    if ((await this.revision(client)) !== revision)
      throw new ApiError(409, 'The catalog changed. Reload before saving.');
  }
  private async section(client: pg.PoolClient, id: string) {
    const row = (
      await client.query<{ id: string; name: string }>(
        'SELECT id,name FROM catalog_sections WHERE id=$1 AND active FOR UPDATE',
        [id],
      )
    ).rows[0];
    if (!row) throw new ApiError(400, 'Choose an existing section.');
    return row;
  }
  private async checkGameIds(
    client: pg.PoolClient,
    ids: number[],
    itemId?: number,
  ) {
    if (
      !ids.length ||
      ids.length > 100 ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !Number.isInteger(id) || id < 1 || id > 2147483647)
    )
      throw new ApiError(400, 'Enter distinct positive in-game item IDs.');
    if (
      (
        await client.query(
          'SELECT 1 FROM game_item_ids WHERE game_item_id=ANY($1::integer[]) AND ($2::integer IS NULL OR item_id<>$2)',
          [ids, itemId ?? null],
        )
      ).rowCount
    )
      throw new ApiError(
        409,
        'An in-game item ID already belongs to another item.',
      );
  }
  async createSection(
    name: string,
    revision: string,
    actor: string,
    key: string,
  ) {
    return this.transaction(true, async (client) => {
      const hash = createHash('sha256').update(name).digest('hex');
      const prior = (
        await client.query(
          'SELECT payload_hash,result FROM catalog_section_requests WHERE actor_discord_id=$1 AND request_key=$2',
          [actor, key],
        )
      ).rows[0];
      if (prior) {
        if (prior.payload_hash !== hash)
          throw new ApiError(
            409,
            'This request key was used for different section details.',
          );
        return prior.result as {
          section: { id: string; name: string };
          catalogRevision: string;
        };
      }
      await this.requireRevision(client, revision);
      if (
        (
          await client.query(
            'SELECT 1 FROM catalog_sections WHERE active AND lower(name)=lower($1)',
            [name],
          )
        ).rowCount
      )
        throw new ApiError(400, 'A section with this name already exists.');
      if (
        Number(
          (
            await client.query(
              'SELECT count(*) FROM catalog_sections WHERE active',
            )
          ).rows[0].count,
        ) >= 100
      )
        throw new ApiError(409, 'The catalog has reached its section limit.');
      const section = { id: 'section-' + randomUUID(), name };
      await client.query(
        'INSERT INTO catalog_sections(id,name,sort_order) SELECT $1,$2,COALESCE(max(sort_order),-1)+1 FROM catalog_sections',
        [section.id, name],
      );
      await client.query(
        "INSERT INTO catalog_audit(actor_discord_id,action,after_value) VALUES($1,'create_section',$2)",
        [actor, JSON.stringify(section)],
      );
      const result = { section, catalogRevision: await this.revision(client) };
      await client.query(
        'INSERT INTO catalog_section_requests(actor_discord_id,request_key,payload_hash,result) VALUES($1,$2,$3,$4)',
        [actor, key, hash, JSON.stringify(result)],
      );
      return result;
    });
  }
  async editSection(
    id: string,
    name: string | null,
    revision: string,
    actor: string,
  ) {
    return this.transaction(true, async (client) => {
      await this.requireRevision(client, revision);
      const before = await this.section(client, id);
      if (name === null) {
        if (
          (
            await client.query(
              'SELECT 1 FROM pages WHERE category=$1 AND active',
              [id],
            )
          ).rowCount
        )
          throw new ApiError(
            409,
            'Only sections with no pages can be deleted.',
          );
        await client.query(
          'UPDATE catalog_sections SET active=false WHERE id=$1',
          [id],
        );
      } else {
        if (
          (
            await client.query(
              'SELECT 1 FROM catalog_sections WHERE active AND id<>$1 AND lower(name)=lower($2)',
              [id, name],
            )
          ).rowCount
        )
          throw new ApiError(400, 'A section with this name already exists.');
        await client.query('UPDATE catalog_sections SET name=$2 WHERE id=$1', [
          id,
          name,
        ]);
      }
      await client.query(
        'INSERT INTO catalog_audit(actor_discord_id,action,before_value,after_value) VALUES($1,$2,$3,$4)',
        [
          actor,
          name === null ? 'delete_section' : 'edit_section',
          JSON.stringify(before),
          JSON.stringify({ id, name, active: name !== null }),
        ],
      );
      return { catalogRevision: await this.revision(client) };
    });
  }
  async reorderSections(ids: string[], revision: string, actor: string) {
    return this.transaction(true, async (client) => {
      await this.requireRevision(client, revision);
      const before = (
        await client.query<{ id: string }>(
          'SELECT id FROM catalog_sections WHERE active ORDER BY sort_order,id FOR UPDATE',
        )
      ).rows.map((r) => r.id);
      if (
        ids.length !== before.length ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !before.includes(id))
      )
        throw new ApiError(400, 'Supply every active section exactly once.');
      await client.query(
        'UPDATE catalog_sections s SET sort_order=x.position FROM jsonb_to_recordset($1::jsonb) AS x(id text,position integer) WHERE s.id=x.id',
        [JSON.stringify(ids.map((id, position) => ({ id, position })))],
      );
      await client.query(
        "INSERT INTO catalog_audit(actor_discord_id,action,before_value,after_value) VALUES($1,'reorder_sections',$2,$3)",
        [actor, JSON.stringify(before), JSON.stringify(ids)],
      );
      return { catalogRevision: await this.revision(client) };
    });
  }
  async renamePage(id: string, name: string, revision: string, actor: string) {
    return this.transaction(true, async (client) => {
      await this.requireRevision(client, revision);
      const before = await this.page(client, id);
      if (
        (
          await client.query(
            'SELECT 1 FROM pages WHERE active AND id<>$1 AND category=$2 AND lower(name)=lower($3)',
            [id, before.category, name],
          )
        ).rowCount
      )
        throw new ApiError(
          400,
          'A page with this name already exists in this section.',
        );
      await client.query('UPDATE pages SET name=$2 WHERE id=$1', [id, name]);
      await client.query(
        "INSERT INTO catalog_audit(actor_discord_id,action,page_id,before_value,after_value) VALUES($1,'edit_page',$2,$3,$4)",
        [
          actor,
          id,
          JSON.stringify(before),
          JSON.stringify(await this.page(client, id)),
        ],
      );
      return { catalogRevision: await this.revision(client) };
    });
  }
  async attachItem(
    pageId: string,
    itemId: number,
    revision: string,
    actor: string,
  ) {
    return this.transaction(true, async (client) => {
      await this.requireRevision(client, revision);
      if (
        !(
          await client.query(
            'SELECT id FROM items WHERE id=$1 AND active FOR UPDATE',
            [itemId],
          )
        ).rowCount
      )
        throw new ApiError(404, 'Catalog item not found.');
      const page = await this.page(client, pageId);
      if (page.itemIds.includes(itemId))
        return { catalogRevision: await this.revision(client) };
      if (
        Number(
          (await client.query('SELECT count(*) FROM page_items')).rows[0].count,
        ) >= 50000
      )
        throw new ApiError(409, 'Catalog capacity reached.');
      await client.query(
        "INSERT INTO page_items(page_id,item_id,slot,origin) SELECT $1,$2,COALESCE(max(slot),-1)+1,'manual' FROM page_items WHERE page_id=$1",
        [pageId, itemId],
      );
      await client.query(
        "INSERT INTO catalog_audit(actor_discord_id,action,item_id,page_id,after_value) VALUES($1,'attach_item',$2,$3,$4)",
        [actor, itemId, pageId, JSON.stringify({ itemId, pageId })],
      );
      return { catalogRevision: await this.revision(client) };
    });
  }
  async editItem(
    id: number,
    fields: { name: string; gameItemIds: number[]; iconAssetId?: string },
    revision: string,
    actor: string,
    verifyAsset: (asset: IconRecord) => Promise<unknown>,
  ) {
    return this.transaction(true, async (client) => {
      await this.requireRevision(client, revision);
      const before = (
        await client.query(
          'SELECT * FROM items WHERE id=$1 AND active FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (!before) throw new ApiError(404, 'Catalog item not found.');
      await this.checkGameIds(client, fields.gameItemIds, id);
      let asset: CatalogAsset | undefined;
      if (fields.iconAssetId) {
        asset = (
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
          throw new ApiError(409, 'Upload a fresh icon before saving.');
        await verifyAsset(asset);
        await client.query('UPDATE catalog_assets SET item_id=$1 WHERE id=$2', [
          id,
          asset.id,
        ]);
      }
      const gameIds = (
        await client.query<{ game_item_id: number }>(
          'SELECT game_item_id FROM game_item_ids WHERE item_id=$1 ORDER BY game_item_id',
          [id],
        )
      ).rows.map((r) => r.game_item_id);
      await client.query('DELETE FROM game_item_ids WHERE item_id=$1', [id]);
      await client.query(
        'INSERT INTO game_item_ids(game_item_id,item_id) SELECT unnest($1::integer[]),$2',
        [fields.gameItemIds, id],
      );
      await client.query(
        'UPDATE items SET name=$2,icon_path=COALESCE($3,icon_path),icon_asset_id=COALESCE($4,icon_asset_id),overrides=ARRAY(SELECT DISTINCT unnest(overrides || $5::text[])) WHERE id=$1',
        [
          id,
          fields.name,
          asset ? iconPath(asset.id) : null,
          asset?.id ?? null,
          ['name', 'game_ids', ...(asset ? ['icon'] : [])],
        ],
      );
      await client.query(
        "INSERT INTO catalog_audit(actor_discord_id,action,item_id,before_value,after_value) VALUES($1,'edit_item',$2,$3,$4)",
        [
          actor,
          id,
          JSON.stringify({ ...before, gameItemIds: gameIds }),
          JSON.stringify({ ...fields, id }),
        ],
      );
      return { catalogRevision: await this.revision(client) };
    });
  }
  async deleteItem(id: number, revision: string, actor: string) {
    return this.transaction(true, async (client) => {
      await this.requireRevision(client, revision);
      const before = (
        await client.query(
          'SELECT id,name FROM items WHERE id=$1 AND active FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (!before) throw new ApiError(404, 'Catalog item not found.');
      const pages = (
        await client.query<{ page_id: string }>(
          'SELECT page_id FROM page_items WHERE item_id=$1',
          [id],
        )
      ).rows.map((r) => r.page_id);
      await client.query('DELETE FROM page_items WHERE item_id=$1', [id]);
      await client.query('UPDATE items SET active=false WHERE id=$1', [id]);
      await client.query(
        "INSERT INTO catalog_audit(actor_discord_id,action,item_id,before_value,after_value) VALUES($1,'delete_item',$2,$3,$4)",
        [
          actor,
          id,
          JSON.stringify({ ...before, pageIds: pages }),
          JSON.stringify({ id, active: false }),
        ],
      );
      return { catalogRevision: await this.revision(client) };
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
      await this.checkGameIds(client, fields.gameItemIds);
      const pages = (
        await client.query<{ id: string }>(
          'SELECT id FROM pages WHERE id=ANY($1::text[]) AND active ORDER BY id FOR UPDATE',
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
      await client.query(
        'INSERT INTO game_item_ids(game_item_id,item_id) SELECT unnest($1::integer[]),$2',
        [fields.gameItemIds, item.id],
      );
      item.gameItemIds = fields.gameItemIds;
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
  /** Remove one membership while preserving the active, potentially pageless item. */
  async removePageItem(
    pageId: string,
    id: number,
    expectedRevision: string,
    expectedVersion: string,
    actor: string,
  ) {
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
          'SELECT p.page_id FROM page_items p JOIN pages g ON g.id=p.page_id WHERE p.item_id=$1 AND g.active ORDER BY p.page_id',
          [id],
        )
      ).rows;
      if (!memberships.some((row) => row.page_id === pageId))
        throw new ApiError(404, 'Item not found on this page.');
      await client.query('SELECT id FROM pages WHERE id=$1 FOR UPDATE', [
        pageId,
      ]);
      const pageBefore = await this.page(client, pageId);
      if (pageBefore.version !== expectedVersion)
        throw new ApiError(
          409,
          'Page membership or order changed. Reload before deleting.',
        );
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
      const remainingPageIds = memberships
        .filter((row) => row.page_id !== pageId)
        .map((row) => row.page_id);
      const retired = false;
      await client.query("UPDATE pages SET order_origin='manual' WHERE id=$1", [
        pageId,
      ]);
      await client.query(
        "INSERT INTO catalog_audit(actor_discord_id,action,item_id,page_id,before_value,after_value) VALUES($1,'delete',$2,$3,$4,$5)",
        [
          actor,
          id,
          pageId,
          JSON.stringify({
            ...before,
            pageIds: memberships.map((row) => row.page_id),
          }),
          JSON.stringify({ id, active: !retired, pageIds: remainingPageIds }),
        ],
      );
      return {
        itemId: id,
        pageId,
        retired,
        catalogRevision: await this.revision(client),
      };
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
