import { expect, test } from '@playwright/test';
import catalog from '../src/preview/catalog.json' with { type: 'json' };

test('page names distinguish zero, partial and complete collections in the current world mode', async ({
  page,
}) => {
  const items = catalog.items.slice(0, 2);
  const pages = [
    {
      id: 'empty',
      name: 'No collections',
      category: 'bosses',
      itemIds: [items[1]!.id],
    },
    {
      id: 'partial',
      name: 'Partial collections',
      category: 'bosses',
      itemIds: items.map((item) => item.id),
    },
    {
      id: 'complete',
      name: 'Full collections',
      category: 'bosses',
      itemIds: [items[0]!.id],
    },
  ];
  await page.route('**/api/v1/catalog', (route) =>
    route.fulfill({ json: { revision: 'color-catalog', items, pages } }),
  );
  await page.route('**/api/v1/collections', (route) =>
    route.fulfill({
      json: {
        revision: 'color-collections',
        credits: [
          {
            submissionId: 'credit',
            itemId: items[0]!.id,
            collectorName: 'Collector',
            collectedOn: '2026-10-01',
            hardcore: false,
            status: 'approved',
          },
        ],
      },
    }),
  );
  await page.goto('/');
  const list = page.locator('.page-list');
  await expect(
    list.getByRole('button', { name: 'No collections', exact: true }),
  ).toHaveCSS('color', 'rgb(255, 32, 32)');
  await expect(
    list.getByRole('button', { name: 'Partial collections', exact: true }),
  ).toHaveCSS('color', 'rgb(255, 152, 31)');
  await expect(
    list.getByRole('button', { name: 'Full collections', exact: true }),
  ).toHaveCSS('color', 'rgb(0, 255, 0)');
});

test('homepage uses the supplied default branding, 2x log and inline XP without public admin navigation', async ({
  page,
}) => {
  await page.goto('/?preview=1');
  await expect(page.locator('.clan-logo')).toHaveAttribute(
    'src',
    '/brand/clan-logo.png',
  );
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
    'href',
    '/favicon.png',
  );
  await expect(
    page.getByRole('button', { name: 'Hardcore worlds', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: 'Admin', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveCount(5);
  const log = await page.locator('.game-window').boundingBox();
  expect(log!.width).toBe(1000);
  expect(log!.height).toBe(628);
  const xp = await page.locator('.event-tracker').boundingBox();
  expect(xp!.y).toBeGreaterThan(log!.y + log!.height);
  await page.getByRole('tab', { name: 'Bosses', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(
    page.getByRole('tab', { name: 'Raids', exact: true }),
  ).toBeFocused();
  await page.screenshot({
    path: test.info().outputPath('homepage-desktop.png'),
    fullPage: true,
  });
});
test('uncollected items never open menus on hover focus or click; icons and page navigation work', async ({
  page,
}) => {
  await page.goto('/?preview=1');
  const item = page.getByRole('button', {
    name: 'Virtus mask: not collected',
    exact: true,
  });
  await item.hover();
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await item.focus();
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await item.click();
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  for (const category of ['Bosses', 'Raids', 'Clues', 'Minigames', 'Other']) {
    await page.getByRole('tab', { name: category, exact: true }).click();
    const first = page.locator('.page-list button').first();
    if (await first.count()) await first.click();
  }
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
  // The window is fixed on the homepage; only search remains in its titlebar.
  const titlebar = page.locator('.game-titlebar');
  await expect(
    titlebar.getByRole('heading', { name: /Collection Log/ }),
  ).toBeVisible();
  await expect(titlebar.locator('.log-book, .game-close')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Close collection log' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Open collection log' }),
  ).toHaveCount(0);
  await titlebar.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByPlaceholder('Search pages...')).toBeVisible();
  await titlebar.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByPlaceholder('Search pages...')).toHaveCount(0);
  await expect(page.locator('.game-window')).toBeVisible();
});
test('admin release switch reveals skull; normal and hardcore menus and contours stay independent', async ({
  page,
}) => {
  await page.goto('/admin?preview=1');
  await page
    .getByRole('link', { name: 'Hardcore worlds', exact: true })
    .click();
  await page.getByLabel('Enable hardcore worlds', { exact: true }).check();
  await page.getByRole('button', { name: 'Save hardcore settings' }).click();
  await expect(page.getByText('Hardcore worlds settings saved.')).toBeVisible();
  await page.locator('header a.clan-brand').click();
  await page.locator('.preview-options').first().locator('summary').click();
  await page.getByLabel('Review scenario').selectOption('hardcore');
  await page
    .getByRole('button', { name: 'Virtus mask: collected', exact: true })
    .hover();
  await expect(page.getByRole('tooltip')).toContainText('03/10/26');
  await expect(page.getByRole('tooltip')).not.toContainText('hardcore worlds');
  await page
    .getByRole('button', { name: 'Hardcore worlds', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Hardcore worlds', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  const item = page.getByRole('button', {
    name: 'Virtus mask: collected, hardcore',
    exact: true,
  });
  await item.hover();
  await expect(page.getByRole('tooltip')).toContainText(
    '05/10/26 on hardcore worlds',
  );
  await expect(page.getByRole('tooltip')).not.toContainText('03/10/26');
  expect(
    await item
      .locator('img')
      .evaluate((image) => getComputedStyle(image).filter),
  ).toContain('hardcore-outline');
  expect(
    await item.evaluate((node) => getComputedStyle(node).borderColor),
  ).toBe('rgba(0, 0, 0, 0)');
  await page
    .getByRole('button', { name: 'Duke Sucellus', exact: true })
    .click();
  await expect(item).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('hardcore-desktop.png'),
    fullPage: true,
  });
  await page.goBack();
  await page
    .getByRole('link', { name: 'Hardcore worlds', exact: true })
    .click();
  await page.getByLabel('Enable hardcore worlds', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Save hardcore settings' }).click();
  await expect(page.getByText('Hardcore worlds settings saved.')).toBeVisible();
  await page.locator('header a.clan-brand').click();
  await expect(
    page.getByRole('button', { name: 'Hardcore worlds', exact: true }),
  ).toHaveCount(0);
});
test('320px viewport contains log scrolling and touch menus', async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 320, height: 850 },
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto('/?preview=1');
  await page.locator('.preview-options').first().locator('summary').click();
  await page.getByLabel('Review scenario').selectOption('collected');
  await page
    .getByRole('button', { name: 'Virtus mask: collected', exact: true })
    .tap();
  const box = await page.getByRole('tooltip').boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await page.locator('.clan-logo').tap();
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath('homepage-mobile.png'),
    fullPage: true,
  });
  await context.close();
});
test('live flag fails closed and public read failures never invent collected items', async ({
  page,
}) => {
  await page.route('**/api/v1/**', (route) => route.fulfill({ status: 503 }));
  await page.goto('/');
  await expect(
    page.getByText('Collection log unavailable', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Hardcore worlds', exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('.item-slot--collected')).toHaveCount(0);
  await page.route('**/api/v1/catalog', (route) =>
    route.fulfill({ json: catalog }),
  );
  await page.route('**/api/v1/collections', (route) =>
    route.fulfill({ json: { revision: 'empty', credits: [] } }),
  );
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(
    page.getByRole('button', {
      name: 'Virtus mask: not collected',
      exact: true,
    }),
  ).toBeVisible();
});
