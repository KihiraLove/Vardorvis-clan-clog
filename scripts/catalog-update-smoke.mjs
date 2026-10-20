/** Opt-in only: exercise an isolated production container, including database restore. */
import assert from 'node:assert/strict';
import { readFile, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
if (process.env.CATALOG_UPDATE_SMOKE_TEST !== '1')
  throw Error('Requires an explicitly disposable production container.');
const require = createRequire('/app/apps/api/package.json'),
  pg = require('pg');
const { databaseUrl } = await import('/app/packages/database/dist/secrets.js');
const { installCatalogUpdate, PgCatalogUpdates } =
  await import('/app/packages/database/dist/catalog-update-store.js');
const { suppliedImagePath } =
  await import('/app/packages/database/dist/catalog-update-model.js');
const url = new URL(databaseUrl()),
  owner = new pg.Client({ connectionString: url.href });
await owner.connect();
let restored;
const restoreName =
  'catalog_update_restore_' + randomUUID().replaceAll('-', '');
const dump = '/tmp/' + restoreName + '.dump';
try {
  assert.equal(
    (await owner.query('SELECT count(*)::int AS n FROM submissions')).rows[0].n,
    0,
    'Requires a fresh disposable installation',
  );
  assert.equal(
    (await owner.query('SELECT count(*)::int AS n FROM catalog_update_batches'))
      .rows[0].n,
    0,
    'Requires no installed content updates',
  );
  const initialPassword = JSON.parse(
    await readFile('/data/bootstrap/administrator.json', 'utf8'),
  ).password;
  const origin = process.env.PUBLIC_ORIGIN;
  const base = 'http://127.0.0.1:8080';
  let cookie = '',
    csrf = '';
  const request = async (path, body, method = 'POST', extra = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        Origin: origin,
        Cookie: cookie,
        'X-CSRF-Token': csrf,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    if (response.headers.get('set-cookie'))
      cookie = response.headers.get('set-cookie').split(';')[0];
    if (data.csrfToken) csrf = data.csrfToken;
    return { status: response.status, data };
  };
  assert.equal(
    (
      await request('/api/v1/auth/login', {
        username: 'admin',
        password: initialPassword,
      })
    ).status,
    200,
  );
  assert.equal(
    (await request('/api/v1/admin/catalog-updates', undefined, 'GET')).status,
    403,
    'First password change precedes catalog access',
  );
  assert.equal(
    (
      await request(
        '/api/v1/auth/account',
        {
          currentPassword: initialPassword,
          newPassword: 'disposable-catalog-update-password',
        },
        'PATCH',
      )
    ).status,
    200,
  );
  const images = (
    await owner.query(
      'SELECT sha256,bytes,width,height FROM catalog_update_images ORDER BY sha256 LIMIT 2',
    )
  ).rows;
  assert.equal(images.length, 2);
  await owner.query(
    "INSERT INTO items(id,name,icon_path,origin) VALUES(9000001,'Upgrade fixture relic',$1,'manual')",
    [suppliedImagePath(images[0].sha256)],
  );
  await owner.query(
    "INSERT INTO game_item_ids(game_item_id,item_id) VALUES(1900000001,9000001);INSERT INTO page_items(page_id,item_id,slot,origin) SELECT 'abyssal_sire',9000001,max(slot)+1,'manual' FROM page_items WHERE page_id='abyssal_sire';INSERT INTO submissions(id,source,raw_item_text,item_id,collector_name,collected_on,date_source,proof_url,status,reviewed_by,reviewed_at) VALUES('00000000-0000-4000-8000-000000000117','manual','Upgrade fixture relic',9000001,'Fixture collector','2026-10-20','admin','','approved','fixture',now())",
  );
  const supplied = images[1];
  await installCatalogUpdate(
    owner,
    {
      id: 'disposable-catalog-update',
      title: 'Disposable catalog update',
      pages: [
        {
          key: 'upgrade_fixture_page',
          name: 'Upgrade fixture page',
          category: 'other',
        },
      ],
      items: [
        {
          key: 'upgrade-relic',
          name: 'Upgrade fixture relic',
          gameItemIds: [1900000002],
          pageKeys: ['upgrade_fixture_page'],
          image: {
            sha256: supplied.sha256,
            width: supplied.width,
            height: supplied.height,
          },
        },
      ],
    },
    [supplied],
  );
  const ready = await request(
    '/api/v1/admin/catalog-updates',
    undefined,
    'GET',
  );
  assert.equal(ready.status, 200);
  assert.equal(ready.data.autoOpen, true);
  const selection = {
    revision: ready.data.revision,
    catalogRevision: ready.data.catalogRevision,
    apply: ready.data.proposals
      .filter((p) => ['gameIds', 'image', 'adopt', 'addLink'].includes(p.kind))
      .map((p) => p.id),
    keep: [],
  };
  const key = randomUUID();
  assert.equal(
    (
      await request('/api/v1/admin/catalog-updates/apply', selection, 'POST', {
        'Idempotency-Key': key,
        Origin: 'https://wrong-origin.invalid',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request('/api/v1/admin/catalog-updates/apply', selection, 'POST', {
        'Idempotency-Key': key,
        'X-CSRF-Token': 'invalid',
      })
    ).status,
    403,
  );
  const applied = await request(
    '/api/v1/admin/catalog-updates/apply',
    selection,
    'POST',
    { 'Idempotency-Key': key },
  );
  assert.equal(applied.status, 200);
  assert.equal(applied.data.applied, selection.apply.length);
  assert.deepEqual(
    (
      await request('/api/v1/admin/catalog-updates/apply', selection, 'POST', {
        'Idempotency-Key': key,
      })
    ).data,
    applied.data,
  );
  assert.equal(
    (
      await request('/api/v1/admin/catalog-updates/seen', {
        revision: ready.data.revision,
      })
    ).status,
    200,
  );
  assert.equal(
    (await request('/api/v1/admin/catalog-updates', undefined, 'GET')).data
      .autoOpen,
    false,
  );
  const item = (
    await owner.query('SELECT id,name,icon_path FROM items WHERE id=9000001')
  ).rows[0];
  assert.equal(item.name, 'Upgrade fixture relic');
  assert.equal(item.icon_path, suppliedImagePath(supplied.sha256));
  assert.deepEqual(
    (
      await owner.query(
        'SELECT game_item_id FROM game_item_ids WHERE item_id=9000001',
      )
    ).rows,
    [{ game_item_id: 1900000002 }],
  );
  assert.equal(
    (
      await owner.query(
        'SELECT count(*)::int AS n FROM collection_credits WHERE item_id=9000001',
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await owner.query(
        "SELECT count(*)::int AS n FROM page_items WHERE page_id='abyssal_sire' AND item_id=9000001",
      )
    ).rows[0].n,
    1,
    'Unselected local memberships stay',
  );
  const binary = (cmd, args) => {
    const result = spawnSync(cmd, args, {
      env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, cmd + ' failed: ' + result.stderr);
  };
  binary('pg_dump', [
    '-h',
    url.hostname,
    '-p',
    url.port || '5432',
    '-U',
    decodeURIComponent(url.username),
    '-d',
    url.pathname.slice(1),
    '-Fc',
    '-f',
    dump,
  ]);
  await owner.query('CREATE DATABASE ' + restoreName);
  binary('pg_restore', [
    '-h',
    url.hostname,
    '-p',
    url.port || '5432',
    '-U',
    decodeURIComponent(url.username),
    '-d',
    restoreName,
    '--exit-on-error',
    dump,
  ]);
  const restoreUrl = new URL(url);
  restoreUrl.pathname = '/' + restoreName;
  restored = new pg.Pool({ connectionString: restoreUrl.href });
  const store = new PgCatalogUpdates(restored);
  const actor = (
    await owner.query("SELECT id FROM staff_accounts WHERE username='admin'")
  ).rows[0].id;
  assert.equal((await store.preview(actor)).autoOpen, false);
  assert.deepEqual(await store.image(images[0].sha256), images[0].bytes);
  assert.deepEqual(await store.image(images[1].sha256), images[1].bytes);
  assert.deepEqual(await store.apply(actor, key, selection), applied.data);
  assert.equal(
    (
      await restored.query(
        'SELECT count(*)::int AS n FROM collection_credits WHERE item_id=9000001',
      )
    ).rows[0].n,
    1,
  );
  console.log(
    JSON.stringify({
      status: 'passed',
      realAuth: true,
      csrfOrigin: true,
      localIdentityPreserved: true,
      applied: applied.data.applied,
      creditsPreserved: true,
      imagesRestored: true,
      decisionsAndReceiptsRestored: true,
    }),
  );
} finally {
  await restored?.end();
  await owner.query('DROP DATABASE IF EXISTS ' + restoreName);
  await owner.end();
  await unlink(dump).catch(() => {});
}
