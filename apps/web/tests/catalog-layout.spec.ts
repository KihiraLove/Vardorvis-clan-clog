import { mockApi } from './mock-api.ts';
/** REVIEW-03/F07: verify equal panel geometry and bounded, usable catalog choices. */
import { expect, test, type Page } from './test.ts';
import { adminFixtures } from './admin-fixtures.ts';
import { defaultBranding } from '../src/branding.ts';
import type { AdminCatalog } from '../src/admin-model.ts';

test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

function catalogFixture(pages: number, items: number): AdminCatalog {
  const entries = Array.from({ length: items }, (_, i) => ({
    id: i + 1,
    name: `Item ${String(i + 1).padStart(3, '0')} ${'LongCatalogItemName'.repeat(3)}`,
    iconPath: '/skills/sailing.png',
    origin: 'manual' as const,
    overrides: [],
  }));
  return {
    revision: 'catalog-layout',
    sourceRevision: null,
    items: entries,
    pages: Array.from({ length: pages }, (_, i) => ({
      id: i === 0 ? 'vardorvis' : `page-${i + 1}`,
      name: `Page ${String(i + 1).padStart(3, '0')} ${'LongCollectionPageName'.repeat(3)}`,
      category: 'bosses',
      itemIds:
        i === pages - 1 && pages > 1 ? [] : entries.map((item) => item.id),
      version: 'page-layout',
      orderOrigin: 'manual',
    })),
  };
}

async function liveCatalog(page: Page, pages: number, items: number) {
  const { session } = await adminFixtures();
  const catalog = catalogFixture(pages, items);
  let writes = 0;
  await page.route('**/api/v1/**', (route) => {
    if (route.request().method() !== 'GET') writes++;
    const responses: Record<string, unknown> = {
      '/api/v1/auth/session': session,
      '/api/v1/admin/catalog': catalog,
      '/api/v1/settings': {
        revision: 'settings-layout',
        clanName: 'Example clan',
        hardcoreEnabled: false,
      },
      '/api/v1/branding': defaultBranding,
      '/api/v1/branding/hardcore': defaultBranding,
    };
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({
      status: path in responses ? 200 : 404,
      json: responses[path] ?? { error: 'Unmocked layout route' },
    });
  });
  await page.goto('/admin/catalog');
  await expect(
    page.getByRole('heading', { name: 'Items catalog', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return { catalog, writes: () => writes };
}

for (const width of [1440, 1100, 320]) {
  for (const { pages, items } of [
    { pages: 0, items: 0 },
    { pages: 3, items: 3 },
    { pages: 180, items: 80 },
  ]) {
    test(`catalog log and contextual editor fit at ${width}px with ${pages} pages and ${items} items`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1000 });
      const state = await liveCatalog(page, pages, items);
      await expect(
        page.getByRole('heading', { name: 'Item management', exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole('heading', { name: 'Page management', exact: true }),
      ).toHaveCount(0);
      await expect(page.locator('.catalog-page-row')).toHaveCount(pages);
      await expect(page.locator('.catalog-item')).toHaveCount(items);
      const before = await page.locator('.catalog-log').boundingBox();
      await page
        .getByRole('button', { name: '+ Add section', exact: true })
        .click();
      await expect(
        page.getByLabel('Section name', { exact: true }),
      ).toBeVisible();
      const geometry = await page.evaluate(() => {
        const log = document
            .querySelector('.catalog-log')!
            .getBoundingClientRect(),
          editor = document
            .querySelector('.catalog-inspector')!
            .getBoundingClientRect();
        return {
          log: { left: log.left, right: log.right, bottom: log.bottom },
          editor: { left: editor.left, top: editor.top },
          width: document.documentElement.scrollWidth,
        };
      });
      expect(geometry.width).toBeLessThanOrEqual(width);
      expect(geometry.log.right - geometry.log.left).toBeCloseTo(
        before!.width,
        0,
      );
      if (width > 1050)
        expect(geometry.editor.left).toBeGreaterThan(geometry.log.right);
      else expect(geometry.editor.top).toBeGreaterThan(geometry.log.bottom);
      if (pages === 180)
        expect(
          await page
            .locator('.catalog-page-list')
            .evaluate((el) => el.scrollHeight > el.clientHeight),
        ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`catalog-${width}-${pages}.png`),
        fullPage: true,
      });
      expect(state.writes()).toBe(0);
    });
  }
}
test('new-item editor uses its selected page and requires an in-game ID', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto('/admin/catalog');
  await page.getByRole('button', { name: '+ Add item', exact: true }).click();
  await page.getByRole('button', { name: 'Add new item', exact: true }).click();
  await expect(
    page.getByRole('group', { name: 'Collection-log pages (required)' }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel('In-game item ID (required)', { exact: true }),
  ).toHaveAttribute('required', '');
  await page.getByLabel('Item name', { exact: true }).fill('Layout drop');
  await page
    .getByLabel('In-game item ID (required)', { exact: true })
    .fill('900001');
  await page.getByRole('button', { name: 'Create item', exact: true }).click();
  await expect(page.locator('.item-creator').getByRole('alert')).toContainText(
    'Choose a valid item icon',
  );
  await page
    .getByLabel('Item icon (required)', { exact: true })
    .setInputFiles('public/skills/sailing.png');
  await expect(page.getByAltText('New item icon preview')).toBeVisible();
});
