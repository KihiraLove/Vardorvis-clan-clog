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
      gameItemIds: [1900000001],
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
  const createPage = async (name, itemIds, key) => {
    const current = await request('/api/v1/admin/catalog');
    return request('/api/v1/admin/catalog/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({
        name,
        category: 'bosses',
        itemIds,
        expectedRevision: current.revision,
      }),
    });
  };
  const removedPage = await createPage(
    'CI removed page',
    [],
    'ci-removed-page',
  );
  const deleted = await request(
    '/api/v1/admin/catalog/pages/' + removedPage.page.id,
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: removedPage.catalogRevision,
        expectedVersion: removedPage.page.version,
      }),
    },
  );
  assert.deepEqual(deleted.retiredItemIds, []);
  const retainedPage = await createPage(
    'CI shared page',
    [created.item.id],
    'ci-shared-page',
  );
  const withPage = await request('/api/v1/admin/catalog');
  const pageIds = withPage.pages
    .filter((page) => page.category === 'bosses')
    .map((page) => page.id);
  await request('/api/v1/admin/catalog/pages/order', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      category: 'bosses',
      orderedPageIds: [
        retainedPage.page.id,
        ...pageIds.filter((id) => id !== retainedPage.page.id),
      ],
      expectedRevision: withPage.revision,
    }),
  });
  const publicCatalog = await request('/api/v1/catalog');
  assert.equal(
    publicCatalog.pages.filter((page) => page.category === 'bosses')[0].id,
    retainedPage.page.id,
  );
  assert.ok(
    !publicCatalog.pages.some((page) => page.id === removedPage.page.id),
  );
  const search = await request('/api/v1/catalog/search?q=CI%20manual');
  assert.equal(search.items[0].id, created.item.id);
  const credits = await request('/api/v1/collections');
  assert.deepEqual(credits.credits, []);
  // Exercise new catalog operations with the actual least-privilege service account.
  const mutate = async (path, method, fields = {}) =>
    request('/api/v1/admin/catalog/' + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(method === 'POST'
          ? { 'Idempotency-Key': 'ci-section-editor' }
          : {}),
      },
      body: JSON.stringify({
        ...fields,
        expectedRevision: (await request('/api/v1/admin/catalog')).revision,
      }),
    });
  const section = await mutate('sections', 'POST', {
    name: 'CI temporary section',
  });
  await mutate('sections/' + section.section.id, 'PATCH', {
    name: 'CI renamed section',
  });
  const temporaryPage = await mutate('pages', 'POST', {
    name: 'CI temporary page',
    category: section.section.id,
    itemIds: [],
  });
  await mutate('pages/' + temporaryPage.page.id, 'PATCH', {
    name: 'CI renamed page',
  });
  await mutate(
    'pages/' + temporaryPage.page.id + '/items/' + created.item.id,
    'PUT',
  );
  const afterSections = await request('/api/v1/admin/catalog');
  await mutate('sections/order', 'PUT', {
    orderedSectionIds: afterSections.sections.map((s) => s.id).reverse(),
  });
  await mutate('items/' + created.item.id, 'PATCH', {
    name: created.item.name,
    gameItemIds: [1900000001, 1900000002],
  });
  const editedCatalog = await request('/api/v1/admin/catalog');
  assert.deepEqual(
    editedCatalog.items.find((item) => item.id === created.item.id).gameItemIds,
    [1900000001, 1900000002],
  );
  const temporaryVersion = editedCatalog.pages.find(
    (page) => page.id === temporaryPage.page.id,
  ).version;
  await mutate('pages/' + temporaryPage.page.id, 'DELETE', {
    expectedVersion: temporaryVersion,
  });
  await mutate('sections/' + section.section.id, 'DELETE');
  const restoredSections = await request('/api/v1/admin/catalog');
  await mutate('sections/order', 'PUT', {
    orderedSectionIds: restoredSections.sections.map((s) => s.id).reverse(),
  });
  console.log(
    JSON.stringify({
      iconPath: created.item.iconPath,
      itemId: created.item.id,
      pageId: retainedPage.page.id,
      deletedPageId: removedPage.page.id,
    }),
  );
} finally {
  const logout = await fetch('http://127.0.0.1:3000/api/v1/auth/logout', {
    method: 'POST',
    headers,
  });
  assert.equal(logout.status, 204);
}
