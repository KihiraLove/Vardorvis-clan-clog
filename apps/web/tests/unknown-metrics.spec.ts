import { test, expect, type Page } from './test.ts';
import { mockApi } from './mock-api.ts';

async function install(page: Page, keys = ['unknown_raid']) {
  const { admin } = await mockApi(page);
  const catalog = await admin.catalog(new AbortController().signal);
  const pageChoice = catalog.pages[0]!;
  const sourceUrl = 'https://wiseoldman.net/competitions/76543';
  const state = {
    saved: false,
    saves: [] as {
      key: string;
      body: {
        definitions: {
          metric: string;
          name: string;
          type: string;
          pageIds: string[];
        }[];
      };
    }[],
    applies: 0,
    previews: 0,
    failSave: false,
    failResume: false,
  };
  const resolution = {
    id: 76543,
    title: 'New raid week',
    sourceUrl,
    metrics: keys.map((metric) => ({ metric, weight: '1' })),
    unknownMetrics: keys,
    startsAt: '2098-01-01T00:00:00Z',
    endsAt: '2099-01-01T00:00:00Z',
    resolutionToken: 'A'.repeat(43),
    revision: 'metrics-1',
    expiresAt: '2099-01-01T00:00:00Z',
    pages: [{ id: pageChoice.id, name: pageChoice.name }],
  };
  await page.route('**/api/v1/admin/competitions/preview', (route) => {
    state.previews++;
    if (!state.saved)
      return route.fulfill({
        status: 422,
        json: { code: 'UNKNOWN_WOM_METRICS', resolution },
      });
    if (state.failResume) {
      state.failResume = false;
      return route.fulfill({ status: 503, json: { error: 'WOM unavailable' } });
    }
    const definitions = state.saves.at(-1)!.body.definitions;
    return route.fulfill({
      json: {
        previewToken: 'saved-metric-preview',
        expectedRevision: 'xp-1',
        scheduleRevision: 'schedules-1',
        expiresAt: '2099-01-01T00:00:00Z',
        competition: {
          id: resolution.id,
          title: resolution.title,
          sourceUrl,
          kind: 'ACTIVITY',
          metrics: keys,
          metricDefinitions: definitions.map((definition) => ({
            metric: definition.metric,
            weight: '1',
            definition,
          })),
          startsAt: resolution.startsAt,
          endsAt: resolution.endsAt,
        },
        lifecycle: 'future',
        action: 'create-schedule',
        scheduleStartsAt: resolution.startsAt,
        pageIds: [pageChoice.id],
        pages: resolution.pages,
        participants: [],
        changes: [],
        warnings: [],
      },
    });
  });
  await page.route('**/api/v1/admin/competitions/metrics', (route) => {
    expect(route.request().headers()['x-csrf-token']).toBe('test-admin');
    state.saves.push({
      key: route.request().headers()['idempotency-key']!,
      body: route.request().postDataJSON(),
    });
    if (state.failSave) {
      state.failSave = false;
      return route.fulfill({
        status: 503,
        json: {
          error: 'Could not confirm metric save. Retry the same choices.',
        },
      });
    }
    state.saved = true;
    return route.fulfill({
      json: { revision: 'metrics-2', savedMetrics: keys },
    });
  });
  await page.route('**/api/v1/admin/competitions/imports', (route) => {
    state.applies++;
    return route.fulfill({
      json: { outcome: 'applied', revision: 'xp-2', scheduleId: 'saved' },
    });
  });
  await page.goto('/admin/schedules');
  const preview = async () => {
    await page.getByLabel('Wise Old Man competition link').fill(sourceUrl);
    await page
      .getByRole('button', { name: 'Preview competition', exact: true })
      .click();
    return page.getByRole('dialog', { name: /Unknown competition metric/ });
  };
  return { state, preview, pageChoice };
}

test('unknown metrics use a modal, require a type and persist before a separate Apply', async ({
  page,
}) => {
  const { state, preview, pageChoice } = await install(page);
  const dialog = await preview();
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((d) => d.matches(':modal'))).toBe(true);
  await expect(
    dialog.getByRole('combobox', { name: 'Metric type', exact: true }),
  ).toHaveValue('');
  await dialog
    .getByRole('button', { name: 'Save metric and continue', exact: true })
    .click();
  expect(state.saves.length).toBe(0);
  await dialog.getByLabel('Display name', { exact: true }).fill('Custom raid');
  await dialog
    .getByRole('combobox', { name: 'Metric type', exact: true })
    .selectOption('BOSS');
  await dialog
    .getByRole('checkbox', { name: pageChoice.name, exact: true })
    .check();
  await page.screenshot({
    path: test.info().outputPath('unknown-metric-dialog-desktop.png'),
  });
  await dialog
    .getByRole('button', { name: 'Save metric and continue', exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText(
      'Metric definitions saved. Review the competition before applying.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByLabel('Competition metrics')).toContainText(
    'Custom raid',
  );
  expect(state.saves[0]!.body.definitions).toEqual([
    {
      metric: 'unknown_raid',
      name: 'Custom raid',
      type: 'BOSS',
      pageIds: [pageChoice.id],
    },
  ]);
  expect(state.applies).toBe(0);
  await page.getByRole('button', { name: 'Apply import', exact: true }).click();
  await expect(
    page.getByText('Competition imported.', { exact: true }),
  ).toBeVisible();
  expect(state.applies).toBe(1);
  await preview();
  await expect(dialog).toHaveCount(0);
  expect(state.saves.length).toBe(1);
});

test('discard button, Escape and close save nothing and restore focus', async ({
  page,
}) => {
  const { state, preview } = await install(page);
  for (const method of ['discard', 'escape', 'close']) {
    const dialog = await preview();
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole('combobox', { name: 'Metric type', exact: true })
      .selectOption('BOSS');
    if (method === 'escape') await page.keyboard.press('Escape');
    else
      await dialog
        .getByRole('button', {
          name:
            method === 'discard'
              ? 'Discard import'
              : 'Discard import and close',
          exact: true,
        })
        .click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Preview competition', exact: true }),
    ).toBeFocused();
  }
  expect(state.saves.length).toBe(0);
  expect(state.applies).toBe(0);
});

test('multiple unknown metrics fit a mobile modal and keyboard focus stays inside it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { state, preview } = await install(page, ['new_raid_a', 'new_raid_b']);
  const dialog = await preview();
  await expect(dialog).toBeVisible();
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  expect(bounds.height).toBeLessThanOrEqual(844);
  const types = dialog.getByRole('combobox', {
    name: 'Metric type',
    exact: true,
  });
  await types.nth(0).selectOption('BOSS');
  await types.nth(1).selectOption('BOSS');
  await page.screenshot({
    path: test.info().outputPath('unknown-metric-dialog-mobile.png'),
  });
  const discard = dialog.getByRole('button', {
    name: 'Discard import',
    exact: true,
  });
  await discard.focus();
  await page.keyboard.press('Tab');
  expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(
    true,
  );
  await dialog
    .getByRole('button', { name: 'Save metrics and continue', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: test.info().outputPath('unknown-metric-dialog-mobile-bottom.png'),
  });
  await dialog
    .getByRole('button', { name: 'Save metrics and continue', exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(state.saves[0]!.body.definitions.length).toBe(2);
  expect(state.applies).toBe(0);
});

test('failed save retains choices and retry key; failed resume reports that definitions were saved', async ({
  page,
}) => {
  const { state, preview } = await install(page);
  state.failSave = true;
  const dialog = await preview();
  await dialog
    .getByRole('combobox', { name: 'Metric type', exact: true })
    .selectOption('BOSS');
  const save = dialog.getByRole('button', {
    name: 'Save metric and continue',
    exact: true,
  });
  await save.click();
  await expect(dialog.getByRole('alert')).toContainText(
    'Retry the same choices',
  );
  await expect(
    dialog.getByRole('combobox', { name: 'Metric type', exact: true }),
  ).toHaveValue('BOSS');
  state.failResume = true;
  await save.click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText(
      'Metric definitions were saved, but the competition preview could not be completed. Retry Preview competition.',
      { exact: true },
    ),
  ).toBeVisible();
  expect(state.saves[0]!.key).toBe(state.saves[1]!.key);
  expect(state.applies).toBe(0);
  await preview();
  await expect(
    page.getByRole('button', { name: 'Apply import', exact: true }),
  ).toBeEnabled();
  expect(state.saves.length).toBe(2);
});
