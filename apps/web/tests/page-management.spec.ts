import { mockApi } from './mock-api.ts';
import { expect, test, pngFile } from './test.ts';

test('sections and pages are managed in the log; deleted pages leave reusable pageless items', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto('/admin/settings/hardcore');
  await page.getByLabel('Enable hardcore worlds').check();
  await page
    .getByRole('button', { name: 'Save hardcore settings', exact: true })
    .click();
  await expect(page.getByText('Hardcore worlds settings saved.')).toBeVisible();
  await page.getByRole('link', { name: 'Items catalog', exact: true }).click();
  await page
    .getByRole('button', { name: '+ Add section', exact: true })
    .click();
  await page.getByLabel('Section name', { exact: true }).fill('Clan events');
  await page
    .getByRole('button', { name: 'Create section', exact: true })
    .click();
  await expect(
    page.getByRole('tab', { name: 'Clan events', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await page
    .getByRole('button', { name: 'Edit section Clan events', exact: true })
    .click();
  await page.getByLabel('Section name', { exact: true }).fill('Clan trophies');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('tab', { name: 'Clan trophies', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '+ Add page', exact: true }).click();
  await page.getByLabel('Page name', { exact: true }).fill('Event drops');
  await page.getByRole('button', { name: 'Create page', exact: true }).click();
  await expect(page.locator('.page-heading h3')).toHaveText('Event drops');
  await page
    .getByRole('button', { name: 'Edit section Clan trophies', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Delete section', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Edit page Event drops', exact: true })
    .click();
  await page.getByLabel('Page name', { exact: true }).fill('Season drops');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.locator('.page-heading h3')).toHaveText('Season drops');
  await page.getByRole('button', { name: '+ Add item', exact: true }).click();
  await page
    .getByRole('button', { name: 'Add existing item', exact: true })
    .click();
  await page
    .getByRole('searchbox', { name: 'Search items', exact: true })
    .fill('Virtus mask');
  await page
    .getByRole('button', { name: 'Add Virtus mask to page', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Edit item Virtus mask', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '+ Add item', exact: true }).click();
  await page.getByRole('button', { name: 'Add new item', exact: true }).click();
  await page.getByLabel('Item name', { exact: true }).fill('Clan trophy');
  await page
    .getByLabel('In-game item ID (required)', { exact: true })
    .fill('900007');
  await page
    .getByLabel('Item icon (required)', { exact: true })
    .setInputFiles(await pngFile('public/skills/sailing.png'));
  await expect(page.getByAltText('New item icon preview')).toBeVisible();
  await page.getByRole('button', { name: 'Create item', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Edit item Clan trophy', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Edit page Season drops', exact: true })
    .click();
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Delete page', exact: true }).click();
  await expect(page.locator('.page-heading h3')).toHaveText('Season drops');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete page', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Season drops', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '+ Add page', exact: true }).click();
  await page.getByLabel('Page name', { exact: true }).fill('Recovered drops');
  await page.getByRole('button', { name: 'Create page', exact: true }).click();
  await expect(page.locator('.page-heading h3')).toHaveText('Recovered drops');
  await page.getByRole('button', { name: '+ Add item', exact: true }).click();
  await page
    .getByRole('button', { name: 'Add existing item', exact: true })
    .click();
  await page
    .getByRole('searchbox', { name: 'Search items', exact: true })
    .fill('Clan trophy');
  await expect(
    page.getByRole('button', { name: 'Add Clan trophy to page', exact: true }),
  ).toContainText('Pageless');
  await page
    .getByRole('button', { name: 'Add Clan trophy to page', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Item settings for Clan trophy', exact: true })
    .click();
  await page.getByLabel('Item name', { exact: true }).fill('Renamed trophy');
  await page
    .getByLabel('In-game item IDs', { exact: true })
    .fill('900008, 900009');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Edit item Renamed trophy', exact: true }),
  ).toBeVisible();
  await page.locator('header a.clan-brand').click();
  await page.getByRole('tab', { name: 'Clan trophies', exact: true }).click();
  await expect(page.locator('.page-heading h3')).toHaveText('Recovered drops');
  await expect(page.locator('.item-slot')).toHaveCount(1);
  await page
    .getByRole('button', { name: 'Hardcore worlds', exact: true })
    .click();
  await expect(page.locator('.page-heading h3')).toHaveText('Recovered drops');
  await expect(page.locator('.item-slot')).toHaveCount(1);
  await page.goBack();
  await page.getByRole('tab', { name: 'Clan trophies', exact: true }).click();
  await page
    .getByRole('button', { name: 'Edit page Recovered drops', exact: true })
    .click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete page', exact: true }).click();
  await page
    .getByRole('button', { name: 'Edit section Clan trophies', exact: true })
    .click();
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', { name: 'Delete section', exact: true })
    .click();
  await expect(
    page.getByRole('tab', { name: 'Clan trophies', exact: true }),
  ).toHaveCount(0);
});

test('section, page and item ordering stays local until saved and persists together', async ({
  page,
}) => {
  await mockApi(page);
  let writes = 0;
  page.on('request', (request) => {
    if (
      request.method() !== 'GET' &&
      new URL(request.url()).pathname.endsWith('/order')
    )
      writes++;
  });
  await page.goto('/admin/catalog');
  const tabs = page
    .getByRole('tablist', { name: 'Catalog sections' })
    .getByRole('tab');
  await page
    .getByRole('button', { name: 'Reorder section Bosses', exact: true })
    .dragTo(
      page
        .locator('.catalog-tab')
        .filter({ has: page.getByRole('tab', { name: 'Raids', exact: true }) }),
    );
  await expect(tabs.first()).toHaveText('Raids');
  await page
    .getByRole('button', { name: 'Reorder section Bosses', exact: true })
    .press('Alt+ArrowLeft');
  await expect(tabs.first()).toHaveText('Bosses');
  await page
    .getByRole('button', { name: 'Reorder section Bosses', exact: true })
    .press('Alt+ArrowRight');
  const rows = page.locator('.catalog-page-row');
  const id = await rows.first().getAttribute('data-page-id');
  await rows
    .first()
    .getByRole('button', { name: /^Reorder page / })
    .dragTo(rows.nth(1));
  await expect(rows.nth(1)).toHaveAttribute('data-page-id', id!);
  const items = page.locator('.catalog-item'),
    itemId = await items.first().getAttribute('data-item-id');
  await items
    .first()
    .getByRole('button', { name: /^Reorder item / })
    .dragTo(items.nth(1));
  await expect(items.nth(1)).toHaveAttribute('data-item-id', itemId!);
  await items
    .nth(1)
    .getByRole('button', { name: /^Reorder item / })
    .press('Alt+ArrowUp');
  await expect(items.first()).toHaveAttribute('data-item-id', itemId!);
  await items
    .first()
    .getByRole('button', { name: /^Reorder item / })
    .press('Alt+ArrowDown');
  expect(writes).toBe(0);
  await page
    .locator('.catalog-order-save')
    .getByRole('button', { name: 'Save changes', exact: true })
    .click();
  await expect(
    page.getByText('Item order saved.', { exact: true }),
  ).toBeVisible();
  expect(writes).toBe(3);
  await page.reload();
  await expect(tabs.first()).toHaveText('Raids');
  await expect(rows.nth(1)).toHaveAttribute('data-page-id', id!);
  await expect(items.nth(1)).toHaveAttribute('data-item-id', itemId!);
  await page.screenshot({
    path: test.info().outputPath('catalog-editor.png'),
    fullPage: true,
  });
});
