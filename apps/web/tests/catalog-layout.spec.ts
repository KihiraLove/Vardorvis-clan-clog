/** REVIEW-03/F07: verify equal panel geometry and bounded, usable catalog choices. */
import { expect, test, type Page } from '@playwright/test';
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
        clanName: 'Vardorvis',
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
    page.getByRole('heading', { name: 'Add item', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return { catalog, writes: () => writes };
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const r = document.querySelector(selector)!.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height };
    };
    const choices = document.querySelector<HTMLElement>(
      '.page-picker-choices',
    )!;
    const items = document.querySelector<HTMLElement>(
      '.page-order-editor .page-order-list',
    )!;
    return {
      creator: box('.item-creator'),
      manager: box('.page-order-editor'),
      picker: box('.page-picker'),
      choices: box('.page-picker-choices'),
      search: box('.page-picker > input'),
      submit: box('.item-creator button[type="submit"]'),
      choicesOverflow: choices.scrollHeight > choices.clientHeight,
      itemsOverflow: items.scrollHeight > items.clientHeight,
    };
  });
}

async function equalPanels(page: Page) {
  await expect
    .poll(async () => {
      const r = await geometry(page);
      return Math.max(
        Math.abs(r.creator.top - r.manager.top),
        Math.abs(r.creator.bottom - r.manager.bottom),
        Math.abs(r.creator.height - r.manager.height),
      );
    })
    .toBeLessThanOrEqual(1);
  const r = await geometry(page);
  expect(r.choices.height).toBeGreaterThan(0);
  expect(r.search.bottom).toBeLessThanOrEqual(r.choices.top);
  expect(r.choices.bottom).toBeLessThan(r.submit.top);
  expect(r.submit.bottom).toBeLessThan(r.creator.bottom);
  return r;
}

const cases = [
  { pages: 0, items: 0 },
  { pages: 3, items: 3 },
  { pages: 180, items: 80 },
];
for (const width of [1440, 1100]) {
  for (const { pages, items } of cases) {
    test(`catalog panels match at ${width}px with ${pages} pages and ${items} items`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1500 });
      const state = await liveCatalog(page, pages, items);
      const picker = page.getByRole('group', {
        name: 'Collection-log pages (required)',
      });
      await expect(picker.getByRole('checkbox')).toHaveCount(pages);
      const r = await equalPanels(page);
      if (pages === 0) {
        await expect(picker).toContainText('No collection-log pages yet.');
      } else {
        const search = picker.getByRole('searchbox');
        await search.fill('not-a-matching-page');
        await expect(picker).toContainText('No matching pages.');
        await equalPanels(page);
        await search.fill('');
        await expect(picker.getByRole('checkbox')).toHaveCount(pages);
      }
      if (pages === 180) {
        expect(r.picker.height).toBeGreaterThan(280);
        expect(r.choicesOverflow).toBe(true);
        expect(r.itemsOverflow).toBe(true);
        const choices = picker.getByRole('checkbox');
        await picker.getByRole('searchbox').focus();
        await page.keyboard.press('Tab');
        await expect(choices.first()).toBeFocused();
        await page.keyboard.press('Space');
        await expect(choices.first()).toBeChecked();
        await page
          .getByRole('button', { name: 'Create item', exact: true })
          .focus();
        await page.keyboard.press('Shift+Tab');
        await expect(choices.last()).toBeFocused();
        await page.keyboard.press('Space');
        await expect(choices.last()).toBeChecked();
        expect(
          await picker
            .locator('.page-picker-choices')
            .evaluate((el) => el.scrollTop),
        ).toBeGreaterThan(0);
        await expect(picker.getByRole('searchbox')).toBeInViewport();
        await equalPanels(page);
        await picker.getByRole('searchbox').fill('no other matches');
        await expect(picker.getByRole('checkbox')).toHaveCount(2);
        await expect(picker.getByRole('checkbox').first()).toBeChecked();
        await expect(picker.getByRole('checkbox').last()).toBeChecked();
        await picker.getByRole('searchbox').fill('');
        await picker.locator('.page-picker-choices').evaluate((el) => {
          el.scrollTop = 0;
        });
        await page.evaluate(() => {
          (document.activeElement as HTMLElement)?.blur();
          window.scrollTo(0, 0);
        });
        await page.screenshot({
          path: test.info().outputPath(`catalog-${width}.png`),
          animations: 'disabled',
        });
      }
      expect(state.writes()).toBe(0);
    });
  }
}

test.describe('touch mobile catalog', () => {
  test.use({ hasTouch: true });
  for (const { pages, items } of cases) {
    test(`catalog panels stack at 320px with ${pages} pages and ${items} items`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 320, height: 850 });
      const state = await liveCatalog(page, pages, items);
      const r = await geometry(page);
      expect(r.manager.top).toBeGreaterThan(r.creator.bottom);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(320);
      const picker = page.getByRole('group', {
        name: 'Collection-log pages (required)',
      });
      if (pages === 0) {
        await expect(picker).toContainText('No collection-log pages yet.');
      } else {
        const choices = picker.getByRole('checkbox');
        await choices.last().tap();
        await expect(choices.last()).toBeChecked();
        await picker.getByRole('searchbox').fill('no other matches');
        await expect(picker.getByRole('checkbox')).toHaveCount(1);
        await expect(picker.getByRole('checkbox')).toBeChecked();
        await picker.getByRole('searchbox').fill('');
      }
      if (pages === 180) {
        expect(r.choices.height).toBeLessThanOrEqual(280);
        expect(r.choicesOverflow).toBe(true);
        expect(r.itemsOverflow).toBe(true);
        const rows = page
          .getByRole('list', { name: 'Page items in draft order' })
          .getByRole('listitem');
        await rows.last().getByRole('button', { name: / up$/ }).tap();
        await expect(rows.nth(items - 2)).toHaveAttribute(
          'data-item-id',
          String(items),
        );
        await expect(
          page.getByRole('button', { name: 'Save order', exact: true }),
        ).toBeEnabled();
        await page
          .getByRole('button', { name: 'Discard order changes', exact: true })
          .tap();
        await expect(rows.last()).toHaveAttribute(
          'data-item-id',
          String(items),
        );
        await page.evaluate(() => {
          (document.activeElement as HTMLElement)?.blur();
          window.scrollTo(0, 0);
        });
        await page.screenshot({
          path: test.info().outputPath('catalog-320.png'),
          fullPage: true,
          animations: 'disabled',
          style: '.skip-link:not(:focus) { visibility: hidden; }',
        });
        for (const [selector, name] of [
          ['.item-creator', 'catalog-create-320.png'],
          ['.page-order-editor', 'catalog-manage-320.png'],
        ]) {
          await page.locator(selector!).screenshot({
            path: test.info().outputPath(name!),
            animations: 'disabled',
            // Chromium can paint offscreen fixed elements into a tall element capture.
            style: '.skip-link:not(:focus) { visibility: hidden; }',
          });
        }
      }
      expect(state.writes()).toBe(0);
    });
  }
});

test('panel and picker heights follow page selection, search, viewport changes and icon/error content', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1500 });
  const { catalog, writes } = await liveCatalog(page, 180, 80);
  const initial = await equalPanels(page);
  await page.getByLabel('Item name', { exact: true }).fill('Layout item');
  await page.getByRole('button', { name: 'Create item', exact: true }).click();
  await expect(page.locator('.item-creator').getByRole('alert')).toContainText(
    'Choose a valid item icon',
  );
  const withError = await equalPanels(page);
  expect(withError.choices.height).toBeLessThan(initial.choices.height);
  await page
    .getByLabel('Item icon (required)', { exact: true })
    .setInputFiles('public/skills/sailing.png');
  await expect(page.getByAltText('New item icon preview')).toBeVisible();
  const withIcon = await equalPanels(page);
  expect(withIcon.choices.height).toBeLessThan(withError.choices.height);
  await page
    .locator('.page-order-editor')
    .getByRole('combobox')
    .selectOption(catalog.pages.at(-1)!.id);
  await expect(page.locator('.page-order-editor')).toContainText(
    'No items on this page.',
  );
  const empty = await equalPanels(page);
  expect(empty.creator.height).toBeLessThan(withIcon.creator.height);
  await page.setViewportSize({ width: 1100, height: 1500 });
  await equalPanels(page);
  await page.setViewportSize({ width: 320, height: 850 });
  const mobile = await geometry(page);
  expect(mobile.manager.top).toBeGreaterThan(mobile.creator.bottom);
  await page.setViewportSize({ width: 1440, height: 1500 });
  await equalPanels(page);
  expect(writes()).toBe(0);
});
