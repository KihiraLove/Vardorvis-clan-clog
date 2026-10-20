import { test, expect, type Page } from './test.ts';
import { fileURLToPath } from 'node:url';
import type { CatalogUpdateReview, CatalogUpdateSelection } from '@clog/domain';
import { mockApi } from './mock-api.ts';

async function install(page: Page, initialReadFailure = false) {
  await mockApi(page);
  const image = '/api/v1/catalog/update-images/' + 'f'.repeat(64) + '.webp';
  const kinds = ['name', 'gameIds', 'image', 'addLink', 'removeLink'] as const;
  const data: CatalogUpdateReview = {
    revision: 'a'.repeat(64),
    catalogRevision: 'catalog-1',
    autoOpen: true,
    releases: [
      {
        id: 'archive',
        title: 'Archive update',
        addedItems: ['Missing treasure'],
        addedPages: ['Fractured Archive'],
      },
    ],
    proposals: kinds.map((kind, index) => ({
      id: String(index + 1).repeat(64),
      kind,
      entityKey: 'relic',
      localId: '77',
      label: 'Archive relic',
      before:
        kind === 'image'
          ? '/catalog/items/1249.webp'
          : kind === 'addLink'
            ? ''
            : kind === 'removeLink'
              ? 'custom-page'
              : kind === 'name'
                ? 'Local name'
                : '99999',
      after:
        kind === 'image'
          ? image
          : kind === 'removeLink'
            ? ''
            : kind === 'addLink'
              ? 'archive'
              : kind === 'name'
                ? 'Archive relic'
                : '50001',
    })),
    conflicts: [],
    currentImages: [
      {
        name: 'Already correct item',
        path: image,
        suppliedPath: image,
        identical: true,
      },
    ],
  };
  const state = {
    seen: false,
    saves: [] as { key: string; body: CatalogUpdateSelection }[],
    failSave: false,
    failResume: initialReadFailure,
    applied: 0,
    rescans: 0,
  };
  await page.route('**/api/v1/catalog/update-images/*.webp', (route) =>
    route.fulfill({
      path: fileURLToPath(new URL('./support/items/1.webp', import.meta.url)),
      contentType: 'image/webp',
    }),
  );
  await page.route('**/api/v1/admin/catalog-updates**', (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() === 'GET') {
      if (state.failResume) {
        state.failResume = false;
        return route.fulfill({
          status: 503,
          json: { error: 'Review unavailable' },
        });
      }
      return route.fulfill({ json: { ...data, autoOpen: !state.seen } });
    }
    expect(request.headers()['x-csrf-token']).toBe('test-admin');
    if (path.endsWith('/seen')) {
      state.seen = true;
      return route.fulfill({ json: { revision: data.revision } });
    }
    if (path.endsWith('/rescan')) {
      state.rescans++;
      return route.fulfill({ json: { addedItems: [], addedPages: [] } });
    }
    const body = request.postDataJSON() as CatalogUpdateSelection;
    state.saves.push({ body, key: request.headers()['idempotency-key']! });
    if (state.failSave) {
      state.failSave = false;
      return route.fulfill({
        status: 503,
        json: { error: 'Save could not be confirmed. Retry the same choices.' },
      });
    }
    state.applied += body.apply.length;
    data.proposals = data.proposals.filter(
      (p) => ![...body.apply, ...body.keep].includes(p.id),
    );
    data.catalogRevision = 'catalog-2';
    return route.fulfill({
      json: {
        applied: body.apply.length,
        kept: body.keep.length,
        catalogRevision: data.catalogRevision,
      },
    });
  });
  await page.goto('/admin/catalog');
  const dialog = page.getByRole('dialog', { name: 'Catalog update available' });
  if (!initialReadFailure) await expect(dialog).toBeVisible();
  return { state, data, dialog };
}
test('first-login catalog modal offers independent corrections/images and applies only explicit choices', async ({
  page,
}) => {
  const { dialog, state } = await install(page);
  await expect(
    dialog.getByText('Local IDs and collection history stay attached.', {
      exact: false,
    }),
  ).toBeVisible();
  await dialog
    .getByRole('combobox', {
      name: 'Decision for Archive relic: Supplied image',
      exact: true,
    })
    .selectOption('apply');
  await dialog
    .getByRole('combobox', {
      name: 'Decision for Archive relic: Item name',
      exact: true,
    })
    .selectOption('keep');
  await page.screenshot({
    path: test.info().outputPath('catalog-update-desktop.png'),
  });
  await dialog
    .getByRole('button', { name: 'Apply selected changes', exact: true })
    .click();
  await expect(dialog.getByRole('status')).toContainText(
    '1 changes applied; 1 kept',
  );
  expect(state.saves[0]!.body.apply).toEqual(['3'.repeat(64)]);
  expect(state.saves[0]!.body.keep).toEqual(['1'.repeat(64)]);
  await expect(
    dialog.getByRole('combobox', {
      name: 'Decision for Archive relic: Game item IDs',
      exact: true,
    }),
  ).toBeVisible();
  expect(state.applied).toBe(1);
});
test('Escape defers without changes, survives reload and permits reopening the review', async ({
  page,
}) => {
  const { state, dialog } = await install(page);
  await expect.poll(() => state.seen).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /Review catalog update/ }),
  ).toBeFocused();
  expect(state.saves).toHaveLength(0);
  await page.reload();
  await expect(
    page.getByRole('button', { name: /Review catalog update/ }),
  ).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: /Review catalog update/ }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Review later and close' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /Review catalog update/ }),
  ).toBeFocused();
});
test('uncertain save retains choices and key; resumed read failure reports the completed save', async ({
  page,
}) => {
  const { state, dialog } = await install(page);
  state.failSave = true;
  const choice = dialog.getByRole('combobox', {
    name: 'Decision for Archive relic: Item name',
    exact: true,
  });
  await choice.selectOption('apply');
  const save = dialog.getByRole('button', {
    name: 'Apply selected changes',
    exact: true,
  });
  await save.click();
  await expect(dialog.getByRole('alert')).toContainText(
    'Retry the same choices',
  );
  await expect(choice).toHaveValue('apply');
  state.failResume = true;
  await save.click();
  await expect(dialog.getByRole('status')).toContainText('1 changes applied');
  await expect(dialog.getByRole('alert')).toContainText('Review unavailable');
  expect(state.saves[1]!.key).toBe(state.saves[0]!.key);
  await dialog
    .getByRole('button', { name: 'Reload review', exact: true })
    .click();
  await expect(
    dialog.getByRole('combobox', {
      name: 'Decision for Archive relic: Item name',
      exact: true,
    }),
  ).toHaveCount(0);
});
test('catalog update modal fits 320px, scrolls and contains keyboard focus', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const { dialog, state } = await install(page);
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  expect(bounds.height).toBeLessThanOrEqual(740);
  expect(await dialog.evaluate((d) => d.scrollWidth <= d.clientWidth)).toBe(
    true,
  );
  const last = dialog.getByRole('button', {
    name: 'Review later',
    exact: true,
  });
  await last.focus();
  await page.keyboard.press('Tab');
  expect(
    await dialog.evaluate((el) => el.contains(document.activeElement)),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('catalog-update-mobile.png'),
  });
  await dialog.getByRole('button', { name: 'Rescan missing content' }).click();
  await expect.poll(() => state.rescans).toBe(1);
  await expect(dialog.getByRole('status')).toContainText('0 missing items');
});
test('moderators do not receive the administrator upgrade review', async ({
  page,
}) => {
  await mockApi(page);
  let reads = 0;
  await page.route('**/api/v1/admin/catalog-updates', (r) => {
    reads++;
    return r.fulfill({ status: 403, json: { error: 'Admin only' } });
  });
  await page.route('**/api/v1/auth/session', (r) =>
    r.fulfill({
      json: {
        authenticated: true,
        username: 'moderator',
        displayName: 'Moderator',
        role: 'moderator',
        csrfToken: 'test-admin',
        mustChangePassword: false,
        allowedPages: ['catalog'],
      },
    }),
  );
  await page.goto('/admin/catalog');
  await expect(
    page.getByRole('heading', { name: 'Clan administration' }),
  ).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(reads).toBe(0);
});
test('failed initial discovery stays unseen and can be retried without losing the first-login offer', async ({
  page,
}) => {
  const { state, dialog } = await install(page, true);
  await expect(page.getByRole('alert')).toContainText('Review unavailable');
  expect(state.seen).toBe(false);
  await page
    .getByRole('button', { name: 'Retry catalog updates', exact: true })
    .click();
  await expect(dialog).toBeVisible();
  await expect.poll(() => state.seen).toBe(true);
});
