/** Populated upgrade, reviewed adoption/corrections, durable bytes and real runtime grants. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, type TestContext } from 'node:test';
import pg from 'pg';
import sharp from 'sharp';
import Fastify from 'fastify';
import type {
  CatalogUpdateBatch,
  CatalogUpdateReview,
  CatalogUpdateProposal,
} from '@clog/domain';
import { migrate } from '@clog/database/dist/migrate.js';
import {
  importCatalog,
  importBundledCatalog,
  readBundledSnapshot,
} from '@clog/database/dist/catalog-import.js';
import { provisionRuntimeRole } from '@clog/database/dist/runtime-role.js';
import {
  PgCatalogUpdates,
  installCatalogUpdate,
} from '@clog/database/dist/catalog-update-store.js';
import { suppliedImagePath } from '@clog/database/dist/catalog-update-model.js';
import { updateHash } from '@clog/database/dist/catalog-update-model.js';
import {
  validateUpdateImage,
  type UpdateImage,
} from '@clog/database/dist/catalog-update-bundle.js';
import { catalogUpdateRoutes } from './catalog-update-routes.js';

const skip = !process.env.TEST_DATABASE_URL;
test(
  'the shipped Fractured Archive batch installs on fresh and populated released catalogs and preserves a renamed manual page',
  { skip },
  async (t) => {
    const baseline = await readBundledSnapshot();
    for (const mode of ['fresh', 'interrupted', 'existing']) {
      const fresh = mode !== 'existing';
      const root = new pg.Client({
        connectionString: process.env.TEST_DATABASE_URL!,
      });
      await root.connect();
      const schema = 'archive_content_' + randomUUID().replaceAll('-', '');
      await root.query('CREATE SCHEMA ' + schema);
      const url = new URL(process.env.TEST_DATABASE_URL!);
      url.searchParams.set('options', '-c search_path=' + schema);
      const client = new pg.Client({ connectionString: url.href }),
        pool = new pg.Pool({ connectionString: url.href });
      await client.connect();
      t.after(async () => {
        await client.end();
        await pool.end();
        await root.query('DROP SCHEMA ' + schema + ' CASCADE');
        await root.end();
      });
      await migrate(url.href);
      if (mode === 'interrupted') await importCatalog(client, baseline);
      if (!fresh) {
        await importCatalog(client, baseline);
        await client.query('UPDATE catalog_bootstrap_state SET complete=true');
        await client.query(
          "INSERT INTO items(id,name,icon_path,origin) VALUES(9000000,'Orion','/catalog/items/1249.webp','manual'); INSERT INTO game_item_ids(game_item_id,item_id) VALUES(34646,9000000); INSERT INTO pages(id,name,category,sort_order) VALUES('our-archive','Our raid loot','raids',10); INSERT INTO page_items(page_id,item_id,slot) VALUES('our-archive',9000000,0); INSERT INTO submissions(id,source,raw_item_text,item_id,collector_name,collected_on,date_source,proof_url,status,reviewed_by,reviewed_at) VALUES('00000000-0000-4000-8000-000000000099','manual','Orion',9000000,'Original collector','2026-10-20','admin','','approved','owner',now())",
        );
      }
      await importBundledCatalog(url.href);
      const store = new PgCatalogUpdates(pool);
      let review = await store.preview('owner');
      assert.equal(review.autoOpen, !fresh);
      if (!fresh) {
        assert.equal(
          (
            await client.query(
              "SELECT 1 FROM pages WHERE id='the_fractured_archive'",
            )
          ).rowCount,
          0,
        );
        const adoption = review.proposals.find(
          (p) => p.kind === 'adoptPage' && p.localId === 'our-archive',
        )!;
        assert.ok(adoption);
        await store.apply('owner', randomUUID(), {
          revision: review.revision,
          catalogRevision: review.catalogRevision,
          apply: [adoption.id],
          keep: [],
        });
        await store.rescan('owner', review.revision, randomUUID());
        review = await store.preview('owner');
        assert.ok(
          review.proposals.some(
            (p) => p.kind === 'image' && p.localId === '9000000',
          ),
        );
        assert.equal(
          (
            await client.query(
              "SELECT collector_name,item_id FROM submissions WHERE id='00000000-0000-4000-8000-000000000099'",
            )
          ).rows[0].collector_name,
          'Original collector',
        );
        assert.equal(
          (await client.query("SELECT name FROM pages WHERE id='our-archive'"))
            .rows[0].name,
          'Our raid loot',
        );
      }
      if (!fresh) {
        await store.apply('owner', randomUUID(), {
          revision: review.revision,
          catalogRevision: review.catalogRevision,
          apply: review.proposals
            .filter((p) => ['createItem', 'addLink'].includes(p.kind))
            .map((p) => p.id),
          keep: [],
        });
      }
      const page = fresh ? 'the_fractured_archive' : 'our-archive';
      assert.equal(
        (
          await client.query(
            'SELECT count(*)::int AS n FROM page_items WHERE page_id=$1',
            [page],
          )
        ).rows[0].n,
        17,
      );
      assert.equal(
        (await client.query('SELECT count(*)::int AS n FROM items')).rows[0].n,
        baseline.items.length + 17,
      );
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM pages WHERE category='raids'",
          )
        ).rows[0].n,
        baseline.pages.filter((p) => p.category === 'raids').length + 1,
      );
      if (fresh) {
        assert.equal(
          (
            await client.query(
              "SELECT 1 FROM page_items p JOIN game_item_ids g ON g.item_id=p.item_id WHERE p.page_id='all_pets' AND g.game_item_id=34646",
            )
          ).rowCount,
          1,
        );
        assert.equal(
          (
            await client.query(
              'SELECT 1 FROM game_item_ids WHERE game_item_id=ANY($1::int[])',
              [[34646, 34648, 34715, 34717, 34722, 34723, 34725, 34727]],
            )
          ).rowCount,
          8,
        );
        assert.equal(review.proposals.length, 0);
      }
      await store.seen('owner', review.revision);
      await importBundledCatalog(url.href);
      assert.equal((await store.preview('owner')).autoOpen, false);
      assert.equal(
        (await client.query('SELECT count(*)::int AS n FROM items')).rows[0].n,
        baseline.items.length + 17,
      );
    }
  },
);

async function image(background: string): Promise<UpdateImage> {
  const bytes = await sharp({
    create: { width: 3, height: 3, channels: 4, background },
  })
    .webp({ lossless: true })
    .toBuffer();
  return validateUpdateImage(bytes, {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    width: 3,
    height: 3,
  });
}
async function fixture(t: TestContext) {
  const url = new URL(process.env.TEST_DATABASE_URL!),
    schema = 'catalog_update_' + randomUUID().replaceAll('-', '');
  const root = new pg.Client({ connectionString: url.href });
  await root.connect();
  await root.query('CREATE SCHEMA ' + schema);
  url.searchParams.set('options', '-c search_path=' + schema);
  const pool = new pg.Pool({ connectionString: url.href }),
    client = new pg.Client({ connectionString: url.href });
  await client.connect();
  t.after(async () => {
    await client.end();
    await pool.end();
    await root.query('DROP SCHEMA ' + schema + ' CASCADE');
    await root.end();
  });
  // Exercise the actual released schema and migration ledger before the new migration.
  for (const file of [
    '001_baseline.sql',
    '002_custom_competition_metrics.sql',
    '003_catalog_updates.sql',
  ]) {
    const sql = await readFile(
      new URL('../../../packages/database/migrations/' + file, import.meta.url),
      'utf8',
    );
    await client.query(sql);
    if (file === '001_baseline.sql')
      await client.query(
        'CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
      );
    await client.query(
      'INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',
      [file, createHash('sha256').update(sql).digest('hex')],
    );
  }
  await client.query(
    "INSERT INTO items(id,name,origin) VALUES(99,'Original credited item','manual'); INSERT INTO pages(id,name,category,sort_order) VALUES('original','Original page','other',0); INSERT INTO page_items(page_id,item_id,slot) VALUES('original',99,0); INSERT INTO submissions(id,source,raw_item_text,item_id,collector_name,collected_on,date_source,proof_url,status,reviewed_by,reviewed_at) VALUES('00000000-0000-4000-8000-000000000001','manual','Original credited item',99,'Collector','2026-10-20','admin','','approved','owner',now());",
  );
  const before = (
    await client.query('SELECT to_jsonb(s) AS row FROM submissions s')
  ).rows;
  await migrate(url.href);
  await migrate(url.href);
  assert.deepEqual(
    (await client.query('SELECT to_jsonb(s) AS row FROM submissions s')).rows,
    before,
  );
  assert.equal(
    (await client.query('SELECT count(*)::int AS n FROM schema_migrations'))
      .rows[0].n,
    4,
  );
  const supplied = await image('#f0c000'),
    old = await image('#ff0000');
  const batch: CatalogUpdateBatch = {
    id: 'archive-content',
    title: 'Archive content',
    pages: [{ key: 'archive', name: 'Fractured Archive', category: 'raids' }],
    items: [
      {
        key: 'relic',
        name: 'Archive relic',
        gameItemIds: [50001],
        image: supplied,
        pageKeys: ['archive'],
      },
    ],
  };
  // The wire contract contains metadata, never image bytes.
  batch.items[0]!.image = { sha256: supplied.sha256, width: 3, height: 3 };
  const store = new PgCatalogUpdates(pool);
  const choose = async (
    review: CatalogUpdateReview,
    pick: (p: CatalogUpdateProposal) => boolean,
    keep = false,
    key = randomUUID(),
  ) =>
    store.apply('owner', key, {
      revision: review.revision,
      catalogRevision: review.catalogRevision,
      apply: keep ? [] : review.proposals.filter(pick).map((p) => p.id),
      keep: keep ? review.proposals.filter(pick).map((p) => p.id) : [],
    });
  return { client, pool, store, supplied, old, batch, choose };
}
test(
  'catalog upgrade inserts missing content once, uses exact manual identities and preserves credited data',
  { skip },
  async (t) => {
    const { client, pool, store, supplied, batch, choose } = await fixture(t);
    const second = await pool.connect();
    try {
      const outcomes = await Promise.all([
        installCatalogUpdate(client, batch, [supplied]),
        installCatalogUpdate(second, batch, [supplied]),
      ]);
      assert.deepEqual(outcomes.sort(), ['installed', 'unchanged']);
    } finally {
      second.release();
    }
    let review = await store.preview('owner');
    assert.equal(review.autoOpen, true);
    assert.deepEqual(review.releases[0]!.addedItems, []);
    assert.equal(
      (await client.query('SELECT count(*)::int AS n FROM items')).rows[0].n,
      1,
    );
    await store.rescan('owner', review.revision, randomUUID());
    await installCatalogUpdate(client, batch, [supplied]);
    assert.equal(
      (await client.query('SELECT count(*)::int AS n FROM items')).rows[0].n,
      1,
    );
    await assert.rejects(
      choose(review, (p) => p.kind === 'createItem' || p.kind === 'createPage'),
      { status: 422 },
    );
    assert.equal(
      (await client.query('SELECT count(*)::int AS n FROM items')).rows[0].n,
      1,
    );
    await choose(review, (p) =>
      ['createPage', 'createItem', 'addLink'].includes(p.kind),
    );
    review = await store.preview('owner');
    assert.equal(review.proposals.length, 0);
    assert.equal(review.currentImages[0]!.identical, true);
    assert.deepEqual(await store.image(supplied.sha256), supplied.bytes);
    const id = (
      await client.query(
        'SELECT item_id FROM game_item_ids WHERE game_item_id=50001',
      )
    ).rows[0].item_id;
    assert.notEqual(id, 99);
    assert.equal(
      (await client.query('SELECT count(*)::int AS n FROM submissions')).rows[0]
        .n,
      1,
    );
    await store.seen('owner', review.revision);
    assert.equal(
      (await new PgCatalogUpdates(pool).preview('owner')).autoOpen,
      false,
    );
    assert.equal((await store.preview('another-admin')).autoOpen, false);
    await assert.rejects(
      installCatalogUpdate(
        client,
        { ...batch, title: 'Changed bytes under old ID' },
        [supplied],
      ),
      /immutable/,
    );
    const next = {
      ...batch,
      id: 'later-content',
      title: 'Later content',
      items: [{ ...batch.items[0]!, name: 'New canonical name' }],
    };
    await installCatalogUpdate(client, next, [supplied]);
    review = await store.preview('owner');
    assert.equal(review.autoOpen, true);
    assert.ok(review.proposals.some((p) => p.kind === 'name'));
    assert.equal(
      (
        await client.query(
          'SELECT count(*)::int AS n FROM game_item_ids WHERE game_item_id=50001',
        )
      ).rows[0].n,
      1,
    );
  },
);
test(
  'name/ID fixes, page fixes and images are independently reviewed without changing local IDs or history',
  { skip },
  async (t) => {
    const { client, store, supplied, old, batch, choose } = await fixture(t);
    await client.query(
      'INSERT INTO catalog_update_images(sha256,bytes,width,height) VALUES($1,$2,3,3)',
      [old.sha256, old.bytes],
    );
    await client.query(
      "INSERT INTO items(id,name,icon_path,origin) VALUES(7,'Archive relic',$1,'manual'),(8,'Wrong name',$1,'manual')",
      [suppliedImagePath(old.sha256)],
    );
    await client.query(
      "INSERT INTO pages(id,name,category,sort_order) VALUES('archive','Wrong page name','bosses',0),('extra','Local extra','other',1); INSERT INTO game_item_ids(game_item_id,item_id) VALUES(99999,7),(50002,8); INSERT INTO page_items(page_id,item_id,slot,origin) VALUES('extra',7,0,'manual')",
    );
    batch.items.push({
      ...batch.items[0]!,
      key: 'shard',
      name: 'Temporal shard',
      gameItemIds: [50002],
    });
    await installCatalogUpdate(client, batch, [supplied]);
    let review = await store.preview('owner');
    assert.ok(
      review.proposals.some((p) => p.kind === 'addGameId' && p.localId === '7'),
    );
    assert.ok(
      review.proposals.some((p) => p.kind === 'name' && p.localId === '8'),
    );
    assert.ok(review.proposals.some((p) => p.kind === 'pageName'));
    assert.ok(review.proposals.some((p) => p.kind === 'removeLink'));
    await choose(review, (p) => p.kind === 'image');
    assert.equal(
      (await client.query('SELECT name FROM items WHERE id=8')).rows[0].name,
      'Wrong name',
    );
    assert.equal(
      (
        await client.query(
          'SELECT game_item_id FROM game_item_ids WHERE item_id=7',
        )
      ).rows[0].game_item_id,
      99999,
    );
    review = await store.preview('owner');
    await choose(review, (p) =>
      [
        'addGameId',
        'removeGameId',
        'name',
        'pageName',
        'pageCategory',
        'addLink',
        'adopt',
      ].includes(p.kind),
    );
    assert.deepEqual(
      (
        await client.query(
          'SELECT game_item_id FROM game_item_ids WHERE item_id=7',
        )
      ).rows,
      [{ game_item_id: 50001 }],
    );
    assert.equal(
      (await client.query('SELECT name FROM items WHERE id=8')).rows[0].name,
      'Temporal shard',
    );
    assert.deepEqual(
      (await client.query("SELECT name,category FROM pages WHERE id='archive'"))
        .rows[0],
      { name: 'Fractured Archive', category: 'raids' },
    );
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM page_items WHERE page_id='extra' AND item_id=7",
        )
      ).rows[0].n,
      1,
    );
    review = await store.preview('owner');
    await choose(review, (p) => p.kind === 'removeLink');
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM page_items WHERE page_id='extra' AND item_id=7",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await client.query(
          'SELECT count(*)::int AS n FROM submissions WHERE item_id=99',
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await client.query(
          'SELECT count(*)::int AS n FROM items WHERE id IN (7,8)',
        )
      ).rows[0].n,
      2,
    );
  },
);
test(
  'declines and image bytes survive later releases; stale reviews and uncertain retries have durable outcomes',
  { skip },
  async (t) => {
    const { client, pool, store, supplied, old, batch, choose } =
      await fixture(t);
    await client.query(
      'INSERT INTO catalog_update_images(sha256,bytes,width,height) VALUES($1,$2,3,3)',
      [old.sha256, old.bytes],
    );
    await client.query(
      "INSERT INTO items(id,name,icon_path) VALUES(7,'Local relic',$1)",
      [suppliedImagePath(old.sha256)],
    );
    await client.query(
      'INSERT INTO game_item_ids(game_item_id,item_id) VALUES(50001,7)',
    );
    await installCatalogUpdate(client, batch, [supplied]);
    const preview = await store.preview('owner'),
      key = randomUUID();
    const receipt = await choose(preview, (p) => p.kind === 'name', false, key);
    assert.deepEqual(
      await choose(preview, (p) => p.kind === 'name', false, key),
      receipt,
    );
    await assert.rejects(
      choose(preview, (p) => p.kind === 'image', false, key),
      { status: 409 },
    );
    await assert.rejects(
      choose(preview, (p) => p.kind === 'image'),
      { status: 409 },
    );
    let current = await store.preview('owner');
    await choose(current, (p) => p.kind === 'image', true);
    const next = {
      ...batch,
      id: 'next-release',
      title: 'Next release',
      items: [{ ...batch.items[0]!, name: 'Newly named relic' }],
    };
    await installCatalogUpdate(client, next, [supplied]);
    current = await new PgCatalogUpdates(pool).preview('owner');
    assert.equal(
      current.proposals.some((p) => p.kind === 'image'),
      false,
    );
    assert.deepEqual(await store.image(old.sha256), old.bytes);
    await installCatalogUpdate(
      client,
      {
        ...batch,
        id: 'changed-image',
        items: [
          {
            ...batch.items[0]!,
            image: { sha256: old.sha256, width: 3, height: 3 },
          },
        ],
      },
      [old],
    );
    assert.equal(
      (await store.preview('owner')).currentImages[0]!.identical,
      true,
    );
  },
);
test(
  'ambiguous and retired candidates are not duplicated; reviewed page adoption supports a safe rescan',
  { skip },
  async (t) => {
    const { client, store, supplied, batch, choose } = await fixture(t);
    await client.query(
      "INSERT INTO items(id,name,active) VALUES(7,'Archive relic',true),(8,'Other',true),(9,'Retired treasure',false); INSERT INTO game_item_ids(game_item_id,item_id) VALUES(50001,8); INSERT INTO pages(id,name,category,sort_order) VALUES('manual-page','Fractured Archive','other',1)",
    );
    batch.items.push(
      {
        ...batch.items[0]!,
        key: 'retired',
        name: 'Retired treasure',
        gameItemIds: [50003],
      },
      {
        ...batch.items[0]!,
        key: 'missing',
        name: 'New treasure',
        gameItemIds: [50004],
      },
    );
    await installCatalogUpdate(client, batch, [supplied]);
    let review = await store.preview('owner');
    assert.equal(review.conflicts.length, 2);
    assert.equal(
      (await client.query('SELECT count(*)::int AS n FROM items')).rows[0].n,
      4,
    );
    await choose(
      review,
      (p) => p.kind === 'adopt' || p.kind === 'pageCategory',
    );
    review = await store.preview('owner');
    const added = await store.rescan('owner', review.revision, randomUUID());
    assert.deepEqual(added.addedItems, []);
    await choose(review, (p) => ['createItem', 'addLink'].includes(p.kind));
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM items WHERE name='Retired treasure'",
        )
      ).rows[0].n,
      1,
    );
    await client.query('DELETE FROM game_item_ids WHERE item_id=8');
    review = await store.preview('owner');
    assert.ok(review.proposals.some((p) => p.localId === '7'));
  },
);
test(
  'content-based page adoption preserves the local page and defers dependent additions without duplicates',
  { skip },
  async (t) => {
    const { client, store, supplied, batch, choose } = await fixture(t);
    await client.query(
      "INSERT INTO items(id,name) VALUES(7,'Archive relic'); INSERT INTO game_item_ids(game_item_id,item_id) VALUES(50001,7); INSERT INTO pages(id,name,category,sort_order) VALUES('our-loot','Our raid loot','raids',1); INSERT INTO page_items(page_id,item_id,slot) VALUES('our-loot',7,0)",
    );
    batch.items.push({
      ...batch.items[0]!,
      key: 'missing',
      name: 'Missing treasure',
      gameItemIds: [50002],
    });
    await installCatalogUpdate(client, batch, [supplied]);
    let review = await store.preview('owner');
    assert.equal(
      (await client.query("SELECT 1 FROM pages WHERE id='archive'")).rowCount,
      0,
    );
    assert.equal(
      (await client.query("SELECT 1 FROM items WHERE name='Missing treasure'"))
        .rowCount,
      0,
    );
    assert.deepEqual(review.pageMatches![0]!.candidates[0]!.matchedItems, [
      'Archive relic',
    ]);
    assert.deepEqual(review.pageMatches![0]!.candidates[0]!.missingItems, [
      'Missing treasure',
    ]);
    await assert.rejects(
      choose(review, (p) => p.kind === 'adoptPage' || p.kind === 'createPage'),
      { status: 422 },
    );
    await choose(review, (p) => p.kind === 'adoptPage');
    await assert.rejects(
      store.apply('another-admin', randomUUID(), {
        revision: review.revision,
        catalogRevision: review.catalogRevision,
        apply: review.proposals
          .filter((p) => p.kind === 'adoptPage')
          .map((p) => p.id),
        keep: [],
      }),
      { status: 409 },
    );
    review = await store.preview('owner');
    assert.ok(
      review.proposals.some(
        (p) => p.kind === 'pageName' && p.localId === 'our-loot',
      ),
    );
    const result = await store.rescan('owner', review.revision, randomUUID());
    assert.deepEqual(result.addedItems, []);
    await choose(review, (p) => ['createItem', 'addLink'].includes(p.kind));
    assert.deepEqual(
      (await client.query("SELECT name FROM pages WHERE id='our-loot'")).rows,
      [{ name: 'Our raid loot' }],
    );
    assert.equal(
      (await client.query("SELECT 1 FROM pages WHERE id='archive'")).rowCount,
      0,
    );
    await installCatalogUpdate(client, batch, [supplied]);
    assert.equal(
      (await client.query("SELECT 1 FROM page_items WHERE page_id='our-loot'"))
        .rowCount,
      2,
    );
  },
);

test(
  'shared page evidence requires an explicit choice and separate-page creation is durable',
  { skip },
  async (t) => {
    const { client, store, supplied, batch, choose } = await fixture(t);
    await client.query(
      "INSERT INTO items(id,name) VALUES(7,'Archive relic'); INSERT INTO game_item_ids(game_item_id,item_id) VALUES(50001,7); INSERT INTO pages(id,name,category,sort_order) VALUES('one','Shared one','raids',1),('two','Shared two','other',2); INSERT INTO page_items(page_id,item_id,slot) VALUES('one',7,0),('two',7,0)",
    );
    await installCatalogUpdate(client, batch, [supplied]);
    const review = await store.preview('owner');
    assert.equal(review.pageMatches![0]!.candidates.length, 2);
    assert.equal(
      (await client.query("SELECT 1 FROM pages WHERE id='archive'")).rowCount,
      0,
    );
    await choose(review, (p) => p.kind === 'createPage');
    const next = await store.preview('owner');
    await choose(next, (p) => p.kind === 'addLink');
    await installCatalogUpdate(client, batch, [supplied]);
    assert.equal(
      (await client.query('SELECT 1 FROM page_items WHERE item_id=7')).rowCount,
      3,
    );
    assert.equal(
      (
        await client.query(
          "SELECT 1 FROM catalog_update_bindings WHERE kind='page' AND source_key='archive' AND local_id='archive'",
        )
      ).rowCount,
      1,
    );
  },
);

test(
  'per-ID repairs retain valid variants, reject invalid dependencies and preserve legacy decisions and receipts',
  { skip },
  async (t) => {
    const { client, store, supplied, batch, choose } = await fixture(t);
    await client.query(
      "INSERT INTO items(id,name) VALUES(7,'Archive relic'); INSERT INTO game_item_ids(game_item_id,item_id) VALUES(50002,7),(99999,7); INSERT INTO pages(id,name,category,sort_order) VALUES('archive','Fractured Archive','raids',1)",
    );
    await installCatalogUpdate(client, batch, [supplied]);
    let review = await store.preview('owner');
    assert.equal(
      review.proposals.filter((p) => p.kind === 'addGameId').length,
      1,
    );
    assert.equal(
      review.proposals.filter((p) => p.kind === 'removeGameId').length,
      2,
    );
    await assert.rejects(
      choose(review, (p) => p.kind === 'removeGameId' && p.before === '99999'),
      { status: 422 },
    );
    await assert.rejects(
      choose(review, (p) => p.kind === 'adopt' || p.kind === 'removeGameId'),
      { status: 422 },
    );
    const key = randomUUID();
    const selection = {
      revision: review.revision,
      catalogRevision: review.catalogRevision,
      apply: review.proposals
        .filter(
          (p) =>
            p.kind === 'adopt' ||
            p.kind === 'addGameId' ||
            (p.kind === 'removeGameId' && p.before === '99999'),
        )
        .map((p) => p.id),
      keep: review.proposals
        .filter((p) => p.kind === 'removeGameId' && p.before === '50002')
        .map((p) => p.id),
    };
    const receipt = await store.apply('owner', key, selection);
    assert.deepEqual(
      (
        await client.query(
          'SELECT game_item_id FROM game_item_ids WHERE item_id=7 ORDER BY game_item_id',
        )
      ).rows,
      [{ game_item_id: 50001 }, { game_item_id: 50002 }],
    );
    assert.deepEqual(await store.apply('owner', key, selection), receipt);
    assert.ok(
      !(await store.preview('owner')).proposals.some(
        (p) => p.kind === 'removeGameId',
      ),
    );
    // A pre-granular whole-list decline suppresses exactly the same repair.
    await client.query('DELETE FROM game_item_ids WHERE game_item_id=50001');
    await client.query(
      'INSERT INTO game_item_ids(game_item_id,item_id) VALUES(88888,7)',
    );
    const legacy = updateHash({
      kind: 'gameIds',
      entityKey: 'relic',
      localId: '7',
      before: '50002, 88888',
      after: '50001',
    });
    await client.query(
      "INSERT INTO catalog_update_decisions(proposal_hash,actor_id,decision) VALUES($1,'owner','kept')",
      [legacy],
    );
    review = await store.preview('owner');
    assert.ok(
      !review.proposals.some((p) =>
        ['addGameId', 'removeGameId'].includes(p.kind),
      ),
    );
    assert.deepEqual(await store.apply('owner', key, selection), receipt);
  },
);

test(
  'failed audit rolls back selected catalog changes; concurrent admins cannot overwrite a review',
  { skip },
  async (t) => {
    const { client, store, supplied, batch } = await fixture(t);
    await client.query(
      "INSERT INTO items(id,name) VALUES(7,'Local name'); INSERT INTO game_item_ids(game_item_id,item_id) VALUES(50001,7)",
    );
    await installCatalogUpdate(client, batch, [supplied]);
    const p = await store.preview('owner'),
      selection = {
        revision: p.revision,
        catalogRevision: p.catalogRevision,
        apply: p.proposals.filter((p) => p.kind === 'name').map((p) => p.id),
        keep: [],
      };
    await client.query(
      "CREATE FUNCTION fail_catalog_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$; CREATE TRIGGER fail_catalog_update BEFORE INSERT ON catalog_update_audit FOR EACH ROW EXECUTE FUNCTION fail_catalog_update()",
    );
    await assert.rejects(store.apply('owner', randomUUID(), selection));
    assert.equal(
      (await client.query('SELECT name FROM items WHERE id=7')).rows[0].name,
      'Local name',
    );
    await client.query(
      'DROP TRIGGER fail_catalog_update ON catalog_update_audit',
    );
    const results = await Promise.allSettled([
      store.apply('owner', randomUUID(), selection),
      store.apply('other', randomUUID(), selection),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
  },
);
test(
  'catalog review API authorizes discovery and every write; public image bytes are immutable',
  { skip },
  async (t) => {
    const { client, store, supplied, batch } = await fixture(t);
    await installCatalogUpdate(client, batch, [supplied]);
    const app = Fastify();
    t.after(() => app.close());
    app.setErrorHandler((error, _r, reply) => {
      const e = error as {
        status?: number;
        statusCode?: number;
        message: string;
      };
      reply.code(e.status ?? e.statusCode ?? 500).send({ error: e.message });
    });
    catalogUpdateRoutes(app, store, async (r, write) => {
      const role = r.headers['x-role'];
      if (!role) throw Object.assign(new Error('Sign in'), { status: 401 });
      if (write && r.headers['x-csrf-token'] !== 'valid')
        throw Object.assign(new Error('CSRF'), { status: 403 });
      return {
        id: 'owner',
        displayName: 'Owner',
        role: role === 'admin' ? 'admin' : 'moderator',
      };
    });
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/admin/catalog-updates',
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/admin/catalog-updates',
          headers: { 'x-role': 'moderator' },
        })
      ).statusCode,
      403,
    );
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/catalog-updates',
      headers: { 'x-role': 'admin' },
    });
    assert.equal(r.statusCode, 200);
    assert.match(r.headers['cache-control']!, /no-store/);
    const seen = {
      method: 'POST' as const,
      url: '/api/v1/admin/catalog-updates/seen',
      headers: { 'x-role': 'admin' },
      payload: { revision: r.json().revision },
    };
    assert.equal((await app.inject(seen)).statusCode, 403);
    assert.equal(
      (
        await app.inject({
          ...seen,
          headers: { ...seen.headers, 'x-csrf-token': 'valid' },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/catalog-updates/apply',
          headers: {
            'x-role': 'admin',
            'x-csrf-token': 'valid',
            'idempotency-key': randomUUID(),
          },
          payload: {
            revision: r.json().revision,
            catalogRevision: r.json().catalogRevision,
            apply: ['f'.repeat(64)],
            keep: [],
          },
        })
      ).statusCode,
      422,
    );
    const icon = await app.inject({
      method: 'GET',
      url: suppliedImagePath(supplied.sha256),
    });
    assert.equal(icon.statusCode, 200);
    assert.deepEqual(icon.rawPayload, supplied.bytes);
    assert.match(icon.headers['cache-control']!, /immutable/);
  },
);
test(
  'fresh installs suppress upgrade prompts and real runtime grants allow review while protecting release evidence',
  { skip },
  async (t) => {
    const { client, supplied, batch, store: initialStore } = await fixture(t);
    await installCatalogUpdate(client, batch, [supplied], true);
    assert.equal((await initialStore.preview('owner')).autoOpen, false);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.search = '';
    const root = new pg.Client({ connectionString: url.href });
    await root.connect();
    const database = 'catalog_update_role_' + randomUUID().replaceAll('-', '');
    await root.query('CREATE DATABASE ' + database);
    url.pathname = '/' + database;
    let pool: pg.Pool | undefined;
    try {
      await migrate(url.href);
      const owner = new pg.Client({ connectionString: url.href });
      await owner.connect();
      await owner.query(
        "INSERT INTO items(id,name) VALUES(7,'Local name');INSERT INTO game_item_ids(game_item_id,item_id) VALUES(50001,7)",
      );
      await installCatalogUpdate(owner, batch, [supplied]);
      await owner.end();
      await provisionRuntimeRole(url.href, 'f'.repeat(64));
      url.username = 'clog_runtime';
      url.password = 'f'.repeat(64);
      pool = new pg.Pool({ connectionString: url.href });
      const store = new PgCatalogUpdates(pool),
        review = await store.preview('owner');
      await store.seen('owner', review.revision);
      await store.apply('owner', randomUUID(), {
        revision: review.revision,
        catalogRevision: review.catalogRevision,
        apply: review.proposals
          .filter((p) => p.kind === 'name')
          .map((p) => p.id),
        keep: [],
      });
      await assert.rejects(
        pool.query("UPDATE catalog_update_batches SET hash='tampered'"),
        { code: '42501' },
      );
      await assert.rejects(pool.query('DELETE FROM catalog_update_decisions'), {
        code: '42501',
      });
      await assert.rejects(pool.query('DELETE FROM catalog_update_images'), {
        code: '42501',
      });
    } finally {
      await pool?.end();
      await root.query('DROP DATABASE ' + database);
      await root.end();
    }
  },
);

test(
  'relationship repairs distinguish source keys from local IDs and retain legacy keep decisions',
  { skip },
  async (t) => {
    const { client, store, supplied, batch, choose } = await fixture(t);
    await client.query(
      "INSERT INTO items(id,name) VALUES(7,'Archive relic'); INSERT INTO game_item_ids(game_item_id,item_id) VALUES(50001,7); INSERT INTO pages(id,name,category,sort_order) VALUES('local-page','One','other',1),('other-page','Two','other',2); INSERT INTO catalog_update_bindings(kind,source_key,local_id) VALUES('page','source-one','local-page'),('page','local-page','other-page')",
    );
    batch.pages = [
      { key: 'source-one', name: 'One', category: 'other' },
      { key: 'local-page', name: 'Two', category: 'other' },
    ];
    batch.items[0]!.pageKeys = ['local-page', 'source-one'];
    await installCatalogUpdate(client, batch, [supplied]);
    const review = await store.preview('owner');
    assert.equal(
      review.proposals.filter((p) => p.kind === 'addLink').length,
      2,
    );
    await choose(
      review,
      (p) => p.kind === 'addLink' && p.pageKey === 'source-one',
    );
    assert.deepEqual(
      (await client.query('SELECT page_id FROM page_items WHERE item_id=7'))
        .rows,
      [{ page_id: 'local-page' }],
    );
    const legacy = updateHash({
      kind: 'addLink',
      entityKey: 'relic',
      localId: '7',
      before: '',
      after: 'other-page',
    });
    await client.query(
      "INSERT INTO catalog_update_decisions(proposal_hash,actor_id,decision) VALUES($1,'owner','kept')",
      [legacy],
    );
    assert.equal(
      (await store.preview('owner')).proposals.some(
        (p) => p.kind === 'addLink',
      ),
      false,
    );
  },
);
