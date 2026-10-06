import { expect, test } from '@playwright/test';
import catalog from '../src/preview/catalog.json' with { type: 'json' };

test('all-uncollected preview, native geometry and five keyboard-operable tabs', async ({
  page,
}) => {
  await page.goto('/?preview=1');
  await expect(
    page.getByText('Frontend preview', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(5);
  await expect(
    page.getByRole('heading', {
      name: `Collection Log - 0/${catalog.items.length}`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator('.item-slot--collected')).toHaveCount(0);
  await page.getByRole('button', { name: 'Native 1×' }).click();
  const box = await page.locator('.game-window').boundingBox();
  expect(box?.width).toBe(500);
  expect(box?.height).toBe(314);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath('native-uncollected.png'),
    fullPage: true,
  });
  await page.getByRole('tab', { name: 'Bosses', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(
    page.getByRole('tab', { name: 'Raids', exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole('heading', { name: 'Chambers of Xeric', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('End');
  await expect(
    page.getByRole('tab', { name: 'Other', exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole('heading', { name: 'Slayer', exact: true }),
  ).toBeVisible();
});
test('mixed hardcore credits propagate across pages; revocation clears only hardcore state', async ({
  page,
}) => {
  await page.goto('/?preview=1');
  await page.getByLabel('Review scenario').selectOption('hardcore');
  const mask = page.getByRole('button', {
    name: 'Virtus mask: collected, hardcore',
    exact: true,
  });
  await mask.hover();
  await expect(page.getByRole('tooltip')).toHaveClass(/item-menu--hardcore/);
  await expect(
    page
      .getByRole('tooltip')
      .getByText('Collected by KihiraVD on 03/10/26', { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('tooltip')
      .getByText('Collected by KihiraVD on 05/10/26 on hardcore worlds', {
        exact: true,
      }),
  ).toBeVisible();
  await expect(page.getByLabel('Hardcore collection')).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('hardcore-desktop.png'),
    fullPage: true,
  });
  await page
    .getByRole('button', { name: 'Duke Sucellus', exact: true })
    .click();
  await expect(
    page.getByRole('button', {
      name: 'Virtus mask: collected, hardcore',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', {
      name: `Collection Log - 1/${catalog.items.length}`,
      exact: true,
    }),
  ).toBeVisible();
  await page.getByLabel('Review scenario').selectOption('collected');
  await expect(page.locator('.item-slot--hardcore')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Virtus mask: collected', exact: true })
    .focus();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await page.getByLabel('Review scenario').selectOption('uncollected');
  await expect(page.locator('.item-slot--collected')).toHaveCount(0);
});
test('each preview page has real local icons; search and closing/reopening work', async ({
  page,
}) => {
  await page.goto('/?preview=1');
  for (const category of ['bosses', 'raids', 'clues', 'minigames', 'other']) {
    await page
      .getByRole('tab', {
        name: category[0]!.toUpperCase() + category.slice(1),
        exact: true,
      })
      .click();
    for (const entry of catalog.pages.filter(
      (entry) => entry.category === category,
    )) {
      await page.getByRole('button', { name: entry.name, exact: true }).click();
      await expect(page.locator('.item-slot')).toHaveCount(
        entry.itemIds.length,
      );
      await expect
        .poll(() =>
          page
            .locator('.item-slot img')
            .evaluateAll((images) =>
              images.every(
                (image) =>
                  (image as HTMLImageElement).complete &&
                  (image as HTMLImageElement).naturalWidth > 0,
              ),
            ),
        )
        .toBe(true);
      await expect(page.locator('.icon-missing')).toHaveCount(0);
    }
  }
  await page.getByRole('tab', { name: 'Bosses', exact: true }).click();
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search pages' }).fill('Vardorvis');
  await expect(page.locator('.page-list button')).toHaveCount(1);
  await page
    .getByRole('textbox', { name: 'Search pages' })
    .fill('nothing-matches');
  await expect(page.getByText('No matching pages.')).toBeVisible();
  await page.getByRole('textbox', { name: 'Search pages' }).press('Escape');
  await page.getByRole('button', { name: 'Close collection log' }).click();
  await expect(page.locator('.game-window')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open collection log' }).click();
  await expect(page.locator('.game-window')).toBeVisible();
});
test('touch menus remain inside a narrow viewport and outside taps dismiss', async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto('/?preview=1');
  await page.getByLabel('Review scenario').selectOption('hardcore');
  await page
    .getByRole('button', {
      name: 'Virtus mask: collected, hardcore',
      exact: true,
    })
    .tap();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toBeVisible();
  const box = await tooltip.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(844);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: test.info().outputPath('hardcore-mobile.png'),
    fullPage: true,
  });
  await page.getByText('Frontend preview', { exact: true }).tap();
  await expect(tooltip).toHaveCount(0);
  await context.close();
});
test('live errors do not show fixture credit; refresh adds and revokes real API credits', async ({
  page,
}) => {
  page.on('pageerror', (error) =>
    console.error('Live page error:', error.message),
  );
  page.on('requestfailed', (request) =>
    console.error(
      'Live request failed:',
      request.url(),
      request.failure()?.errorText,
    ),
  );
  let status = 503;
  let credits: unknown[] = [];
  let conditionals = 0;
  await page.route('**/api/v1/catalog', async (route) => {
    if (route.request().headers()['if-none-match']) conditionals++;
    await route.fulfill({
      status,
      json: status === 200 ? catalog : { error: { code: 'NOT_READY' } },
      headers: { ETag: 'catalog-one' },
    });
  });
  await page.route('**/api/v1/collections', (route) =>
    route.fulfill({
      status,
      json:
        status === 200
          ? { revision: `credits-${credits.length}`, credits }
          : {},
      headers: { ETag: `credits-${credits.length}` },
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText(
    'Collection log unavailable',
  );
  await expect(page.getByLabel('Review scenario')).toHaveCount(0);
  status = 200;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  try {
    await expect(
      page.getByRole('heading', {
        name: `Collection Log - 0/${catalog.items.length}`,
        exact: true,
      }),
    ).toBeVisible();
  } catch (failure) {
    console.error('Live retry page:', await page.locator('main').innerText());
    throw failure;
  }
  const itemId = catalog.items.find((item) => item.name === 'Virtus mask')!.id;
  credits = [
    {
      submissionId: 'approved',
      itemId,
      collectorName: 'Real collector',
      collectedOn: '2026-10-05',
      hardcore: true,
    },
  ];
  await page.evaluate(() =>
    document.dispatchEvent(new Event('visibilitychange')),
  );
  await expect(
    page.getByRole('button', {
      name: 'Virtus mask: collected, hardcore',
      exact: true,
    }),
  ).toBeVisible();
  status = 503;
  await page.evaluate(() =>
    document.dispatchEvent(new Event('visibilitychange')),
  );
  await expect(
    page.getByText(/Showing the last successful update/),
  ).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: 'Virtus mask: collected, hardcore',
      exact: true,
    }),
  ).toBeVisible();
  status = 200;
  credits = [];
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.item-slot--collected')).toHaveCount(0);
  expect(conditionals).toBeGreaterThan(0);
});
