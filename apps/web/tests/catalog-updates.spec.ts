import { test, expect, type Page } from './test.ts';
import { fileURLToPath } from 'node:url';
import type { CatalogUpdateReview, CatalogUpdateSelection } from '@clog/domain';
import { mockApi } from './mock-api.ts';

async function install(
  page: Page,
  initialReadFailure = false,
  configure?: (data: CatalogUpdateReview) => void,
) {
  await mockApi(page);
  const image = '/api/v1/catalog/update-images/' + 'f'.repeat(64) + '.webp';
  const kinds = [
    'name',
    'addGameId',
    'image',
    'addLink',
    'removeLink',
    'removeGameId',
  ] as const;
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
          : kind === 'addLink' || kind === 'addGameId'
            ? ''
            : kind === 'removeLink'
              ? 'custom-page'
              : kind === 'name'
                ? 'Local name'
                : '99999',
      after:
        kind === 'image'
          ? image
          : kind === 'removeLink' || kind === 'removeGameId'
            ? ''
            : kind === 'addLink'
              ? 'archive'
              : kind === 'name'
                ? 'Archive relic'
                : '50001',
    })),
    conflicts: [],
    gameIdReviews: [
      {
        entityKey: 'relic',
        localId: '77',
        label: 'Archive relic',
        localIds: [50002, 99999],
        suppliedIds: [50001],
      },
    ],
    currentImages: [
      {
        name: 'Already correct item',
        path: image,
        suppliedPath: image,
        identical: true,
      },
    ],
  };
  configure?.(data);
  const state = {
    seen: false,
    saves: [] as { key: string; body: CatalogUpdateSelection }[],
    failSave: false,
    staleSave: false,
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
    if (state.staleSave) {
      state.staleSave = false;
      data.catalogRevision = 'catalog-2';
      return route.fulfill({ status: 409, json: { error: 'Catalog changed' } });
    }
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
  if (!initialReadFailure && (data.proposals.length || data.conflicts.length))
    await expect(dialog).toBeVisible();
  return { state, data, dialog };
}

test('grouped review shows the seven requested groups and applies only checked groups', async ({
  page,
}) => {
  const { dialog, state } = await install(page, false, (data) => {
    for (const [kind, id] of [
      ['pageName', '7'],
      ['createPage', '8'],
      ['createItem', '9'],
    ] as const)
      data.proposals.push({
        id: id.repeat(64),
        kind,
        entityKey: kind,
        localId: kind,
        label: 'New archive content',
        before: kind === 'pageName' ? 'Local page' : '',
        after: kind === 'createItem' ? '34719' : 'Supplied content',
      });
    const pageName = data.proposals.find((p) => p.kind === 'pageName')!;
    pageName.label = 'The Fractured Archive';
    pageName.before = 'The Fractured Archives';
    pageName.after = 'The Fractured Archive';
  });
  await expect(dialog.getByRole('columnheader')).toHaveText([
    'Detected problem',
    'Fix?',
  ]);
  await expect(dialog.getByRole('heading', { level: 3 })).toHaveText([
    'Page name mismatches',
    'Missing pages',
    'Missing items',
    'Incorrect item names',
    'Incorrect item ids',
    'Missing item-page relationships',
    'Incorrect item-page relationships',
  ]);
  await expect(dialog.getByRole('button')).toHaveText(['Save', 'Cancel']);
  await expect(dialog.getByRole('listitem')).toHaveText([
    'The Fractured Archives → The Fractured Archive',
    'Missing → New archive content',
    'Missing → New archive content ID 34719',
    'Local name → Archive relic',
    'Local name ID 99999 → Archive relic ID 50001',
    'None → Archive relic / archive',
    'Archive relic / custom-page → None',
  ]);
  await page.screenshot({
    path: test.info().outputPath('catalog-groups-desktop.png'),
    fullPage: true,
  });
  await dialog
    .getByRole('checkbox', { name: 'Fix Incorrect item names', exact: true })
    .check();
  await dialog
    .getByRole('checkbox', {
      name: 'Use project supplied item icons (recommended)',
      exact: true,
    })
    .check();
  expect(state.saves).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.saves[0]!.body.apply).toEqual(['1'.repeat(64), '3'.repeat(64)]);
  expect(state.saves[0]!.body.keep).toEqual([]);
  await expect(
    page.getByRole('button', { name: /Review catalog update/ }),
  ).toBeVisible();
});

test('page candidate selection is explicit and group-level ID repairs include only their listed changes', async ({
  page,
}) => {
  const { dialog, state } = await install(page, false, (data) => {
    for (const p of data.proposals) {
      p.label = 'Rondache';
      if (p.kind === 'name') {
        p.before = 'Rondace';
        p.after = 'Rondache';
      }
      if (p.kind === 'addGameId' || p.kind === 'removeGameId') {
        p.beforeLabel = 'Rondace';
        p.afterLabel = 'Rondache';
        if (p.kind === 'addGameId') p.after = '34719';
        else p.before = '1';
      }
    }
    data.pageMatches = [
      {
        entityKey: 'archive',
        label: 'The Archive',
        candidates: [
          {
            id: 'our-loot',
            name: 'Our raid loot',
            category: 'raids',
            active: true,
            matchedItems: ['Archive relic'],
            missingItems: ['Other treasure'],
            extraItems: ['Local ornament'],
          },
        ],
      },
    ];
    for (const [kind, id, localId] of [
      ['adoptPage', '8', 'our-loot'],
      ['createPage', '9', 'archive'],
    ] as const)
      data.proposals.push({
        id: id.repeat(64),
        kind,
        entityKey: 'archive',
        localId,
        label: 'The Archive',
        before: 'Unlinked local page',
        after: localId,
      });
    data.conflicts.push({
      kind: 'page',
      entityKey: 'archive',
      label: 'The Archive',
      reason: 'Choose an existing page or create a separate page.',
      candidates: [],
    });
  });
  await dialog
    .getByRole('checkbox', { name: 'Fix Missing pages', exact: true })
    .check();
  const ids = dialog.getByRole('row').filter({
    has: page.getByRole('heading', { name: 'Incorrect item ids', exact: true }),
  });
  await expect(ids.getByRole('listitem')).toHaveText([
    'Rondace ID 1 → Rondache ID 34719',
  ]);
  await expect(
    dialog.getByRole('button', { name: 'Save', exact: true }),
  ).toBeDisabled();
  await dialog
    .getByLabel('Page identity for The Archive')
    .selectOption('8'.repeat(64));
  await expect(dialog).toContainText('Local ornament');
  await dialog
    .getByRole('checkbox', { name: 'Fix Incorrect item ids', exact: true })
    .check();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.saves).toHaveLength(1);
  expect(state.saves[0]!.body.apply).toEqual(
    ['2', '6', '8'].map((n) => n.repeat(64)),
  );
});

test('Cancel and Escape discard choices and allow reopening without applying fixes', async ({
  page,
}) => {
  const { dialog, state } = await install(page);
  await dialog
    .getByRole('checkbox', { name: 'Fix Incorrect item names' })
    .check();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.saves).toHaveLength(0);
  const reopen = page.getByRole('button', { name: /Review catalog update/ });
  await expect(reopen).toBeFocused();
  await reopen.click();
  await expect(
    dialog.getByRole('checkbox', { name: 'Fix Incorrect item names' }),
  ).not.toBeChecked();
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(dialog).toHaveCount(0);
  await expect(reopen).toBeVisible();
});

test('release history and identical icons alone show neither review button nor modal', async ({
  page,
}) => {
  const { dialog, state } = await install(page, false, (data) => {
    data.proposals = [];
  });
  await expect(
    page.getByRole('heading', { name: 'Items catalog', exact: true }),
  ).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /Review catalog update/ }),
  ).toHaveCount(0);
  expect(state.seen).toBe(false);
});

test('icons-only reviews omit all empty problem groups and disappear after Save', async ({
  page,
}) => {
  const { dialog } = await install(page, false, (data) => {
    data.proposals = data.proposals.filter((p) => p.kind === 'image');
  });
  await expect(dialog.getByRole('table')).toHaveCount(0);
  await dialog
    .getByRole('checkbox', {
      name: 'Use project supplied item icons (recommended)',
    })
    .check();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /Review catalog update/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('link', {
      name: 'Clan name clan collection log',
      exact: true,
    }),
  ).toBeFocused();
});

test('an uncertain Save freezes choices and retries the exact payload and receipt key', async ({
  page,
}) => {
  const { dialog, state } = await install(page);
  state.failSave = true;
  const checkbox = dialog.getByRole('checkbox', {
    name: 'Fix Incorrect item names',
  });
  await checkbox.check();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText(
    'Save could not be confirmed',
  );
  await expect(checkbox).toBeDisabled();
  await expect(
    dialog.getByRole('button', { name: 'Cancel', exact: true }),
  ).toBeDisabled();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.saves).toHaveLength(2);
  expect(state.saves[1]).toEqual(state.saves[0]);
});

test('stale Save refreshes problems and requires selecting fixes again', async ({
  page,
}) => {
  const { dialog, state } = await install(page);
  state.staleSave = true;
  const checkbox = dialog.getByRole('checkbox', {
    name: 'Fix Incorrect item names',
  });
  await checkbox.check();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText(
    'choose your fixes again',
  );
  await expect(checkbox).not.toBeChecked();
  await expect(
    dialog.getByRole('button', { name: 'Save', exact: true }),
  ).toBeDisabled();
});

test('catalog update table fits 320px, scrolls and contains keyboard focus', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const { dialog } = await install(page);
  expect(await dialog.evaluate((d) => d.scrollWidth <= d.clientWidth)).toBe(
    true,
  );
  for (let n = 0; n < 15; n++) {
    await page.keyboard.press('Tab');
    expect(
      await dialog.evaluate((d) => d.contains(document.activeElement)),
    ).toBe(true);
  }
  await page.screenshot({
    path: test.info().outputPath('catalog-groups-320.png'),
    fullPage: true,
  });
});

test('failed initial discovery can be retried without losing the first-login offer', async ({
  page,
}) => {
  const { dialog, state } = await install(page, true);
  await expect(page.getByRole('alert')).toContainText('Review unavailable');
  expect(state.seen).toBe(false);
  await page
    .getByRole('button', { name: 'Retry catalog updates', exact: true })
    .click();
  await expect(dialog).toBeVisible();
  await expect.poll(() => state.seen).toBe(true);
});

test('a completed Save reports a failed refreshed read without replaying the write', async ({
  page,
}) => {
  const { dialog, state } = await install(page);
  await dialog
    .getByRole('checkbox', { name: 'Fix Incorrect item names' })
    .check();
  state.failResume = true;
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('Changes saved');
  expect(state.saves).toHaveLength(1);
});

test('moderators do not receive catalog update discovery or review', async ({
  page,
}) => {
  await mockApi(page);
  let reads = 0;
  await page.route('**/api/v1/admin/catalog-updates**', (route) => {
    reads++;
    return route.fulfill({ status: 403 });
  });
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
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
    page.getByRole('heading', { name: 'Items catalog', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(reads).toBe(0);
});
