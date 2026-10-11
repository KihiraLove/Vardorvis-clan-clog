/** Disposable Compose acceptance check, invoked only by CI with an explicit opt-in. */
import assert from 'node:assert/strict';
import sharp from 'sharp';
if (process.env.CATALOG_SMOKE_TEST !== '1')
  throw new Error('For disposable CI databases only');
const origin = process.env.PUBLIC_ORIGIN;
const login = await fetch('http://127.0.0.1:3000/api/v1/auth/login', {
  method: 'POST',
  headers: { Origin: origin, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: 'admin',
    password: 'ci-only-test-admin-password',
  }),
});
assert.equal(login.status, 200, 'CI admin password login must succeed');
const session = await login.json();
const headers = {
  Origin: origin,
  Cookie: login.headers.get('set-cookie').split(';')[0],
  'X-CSRF-Token': session.csrfToken,
};
const request = async (path, options = {}) => {
  const response = await fetch('http://127.0.0.1:3000' + path, {
    ...options,
    headers: { ...headers, ...options.headers },
  });
  const body = await response.json();
  assert.ok(response.ok, `HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
};
try {
  const png = await sharp({
    create: { width: 36, height: 32, channels: 4, background: '#ff000080' },
  })
    .png()
    .toBuffer();
  const form = new FormData();
  form.set('icon', new Blob([png], { type: 'image/png' }), 'fixture.png');
  const asset = await request('/api/v1/admin/catalog/icons', {
    method: 'POST',
    body: form,
  });
  const created = await request('/api/v1/admin/catalog/items', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'ci-catalog-fixture',
    },
    body: JSON.stringify({
      name: 'CI manual trophy',
      iconAssetId: asset.assetId,
      pageIds: ['abyssal_sire', 'general_graardor'],
    }),
  });
  const catalog = await request('/api/v1/admin/catalog');
  const page = catalog.pages.find((page) => page.id === 'abyssal_sire');
  const ordered = await request(
    '/api/v1/admin/catalog/pages/abyssal_sire/order',
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderedItemIds: [...page.itemIds].reverse(),
        expectedVersion: page.version,
      }),
    },
  );
  assert.equal(ordered.page.itemIds[0], created.item.id);
  const search = await request('/api/v1/catalog/search?q=CI%20manual');
  assert.equal(search.items[0].id, created.item.id);
  const credits = await request('/api/v1/collections');
  assert.deepEqual(credits.credits, []);
  console.log(
    JSON.stringify({
      iconPath: created.item.iconPath,
      itemId: created.item.id,
    }),
  );
} finally {
  const logout = await fetch('http://127.0.0.1:3000/api/v1/auth/logout', {
    method: 'POST',
    headers,
  });
  assert.equal(logout.status, 204);
}
