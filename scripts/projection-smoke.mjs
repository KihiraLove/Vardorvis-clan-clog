/** Production proxy and cross-instance cache acceptance on the disposable local stack. */
import assert from 'node:assert/strict';
import pg from 'pg';
import { PgStore } from './apps/api/dist/store.js';
if (process.env.PROJECTION_SMOKE_DISPOSABLE !== 'true')
  throw new Error('Disposable stack only.');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const read = (path, etag) =>
  fetch('http://127.0.0.1:8080/api/v1/' + path, {
    headers: etag ? { 'If-None-Match': etag } : {},
    cache: 'no-store',
  });
try {
  assert.equal(
    (await pool.query('SELECT current_user AS role')).rows[0].role,
    'clog_runtime',
  );
  for (const path of [
    'catalog',
    'collections',
    'xp/tracker',
    'competitions/activities',
    'settings',
    'branding',
    'branding/hardcore',
  ]) {
    const response = await read(path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('Cache-Control'), /must-revalidate/u);
    const etag = response.headers.get('ETag');
    assert.ok(etag, path);
    await response.json();
    const unchanged = await read(path, etag);
    assert.equal(unchanged.status, 304, path);
    assert.equal(await unchanged.text(), '');
    if (path === 'competitions/activities') {
      assert.match(etag, /^W\//u);
      assert.ok(
        Number.isFinite(Date.parse(unchanged.headers.get('X-Server-Now'))),
      );
    }
  }
  const receipts = async () =>
    (
      await pool.query(
        "SELECT kind,receipt FROM (SELECT 'catalog' AS kind,to_jsonb(r) AS receipt FROM catalog_requests r UNION ALL SELECT 'xp',to_jsonb(r) FROM xp_import_history r UNION ALL SELECT 'competition',to_jsonb(r) FROM competition_import_history r) receipts ORDER BY kind,receipt::text",
      )
    ).rows;
  const preserved = await receipts();
  const stores = [new PgStore(pool), new PgStore(pool)];
  const before = await Promise.all(
    stores.map((store) => store.publicSnapshot('catalog')),
  );
  const response = await read('catalog'),
    etag = response.headers.get('ETag');
  const item = (await response.json()).items[0];
  try {
    await pool.query('UPDATE items SET name=$1 WHERE id=$2', [
      item.name + ' cache smoke',
      item.id,
    ]);
    for (const store of stores) {
      const next = await store.publicSnapshot('catalog');
      assert.notEqual(next.revision, before[0].revision);
      assert.equal(
        JSON.parse(next.body).items.find((row) => row.id === item.id).name,
        item.name + ' cache smoke',
      );
    }
    const changed = await read('catalog', etag);
    assert.equal(changed.status, 200);
    assert.equal(
      (await changed.json()).items.find((row) => row.id === item.id).name,
      item.name + ' cache smoke',
    );
    assert.deepEqual(await receipts(), preserved);
  } finally {
    await pool.query('UPDATE items SET name=$1 WHERE id=$2', [
      item.name,
      item.id,
    ]);
  }
  assert.equal(
    (await (await read('catalog')).json()).items.find(
      (row) => row.id === item.id,
    ).name,
    item.name,
  );
  console.log(
    'Public conditional responses, fresh activity clocks, cross-instance invalidation and durable receipts passed.',
  );
} finally {
  await pool.end();
}
