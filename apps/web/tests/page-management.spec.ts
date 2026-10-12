import { expect, test } from '@playwright/test';

test('page management creates and orders pages, confirms deletion, and preserves shared items across both world modes', async ({
  page,
}) => {
  await page.goto('/admin/settings/hardcore?preview=1');
  await page.getByLabel('Enable hardcore worlds').check();
  await page
    .getByRole('button', { name: 'Save hardcore settings', exact: true })
    .click();
  await expect(page.getByText('Hardcore worlds settings saved.')).toBeVisible();
  await page.getByRole('link', { name: 'Items catalog', exact: true }).click();
  const panel = page.locator('.page-management');
  const order = page.locator('.page-order-editor');
  await panel.getByLabel('Page name', { exact: true }).fill('Clan trophies');
  await panel
    .getByRole('searchbox', { name: 'Search items for new page' })
    .fill('Virtus');
  await panel
    .getByLabel('Include Virtus mask on new page', { exact: true })
    .check();
  await panel.getByRole('button', { name: 'Create page', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText(
    'Clan trophies created. The page is available in both world modes.',
  );
  await expect(
    panel
      .getByRole('list', { name: 'Collection-log pages' })
      .locator('li')
      .last(),
  ).toContainText('Clan trophies');
  await panel
    .getByRole('button', { name: 'Move page Clan trophies up', exact: true })
    .click();
  await expect(panel.getByRole('status')).toHaveText('Page order saved.');
  await expect(
    panel
      .getByRole('list', { name: 'Collection-log pages' })
      .locator('li')
      .nth(5),
  ).toContainText('Clan trophies');
  // The new page is immediately available in the shared item-management selector.
  await order.getByRole('combobox').selectOption({ label: 'Clan trophies' });
  await expect(order.getByRole('listitem')).toHaveCount(1);
  await expect(order.getByRole('listitem')).toContainText('Virtus mask');
  await page.setViewportSize({ width: 320, height: 850 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await panel.screenshot({
    path: test.info().outputPath('page-management-mobile.png'),
  });
  await page.setViewportSize({ width: 1100, height: 850 });
  await page.locator('header a.clan-brand').click();
  await page
    .locator('.page-list')
    .getByRole('button', { name: 'Clan trophies', exact: true })
    .click();
  await expect(page.locator('.page-heading h3')).toHaveText('Clan trophies');
  await expect(page.locator('.item-slot')).toHaveCount(1);
  await page
    .getByRole('button', { name: 'Hardcore worlds', exact: true })
    .click();
  await expect(page.locator('.page-heading h3')).toHaveText('Clan trophies');
  await expect(page.locator('.item-slot')).toHaveCount(1);
  await page.screenshot({
    path: test.info().outputPath('new-page-public.png'),
    fullPage: true,
  });
  await page.goBack();
  page.once('dialog', (dialog) => dialog.dismiss());
  await panel
    .getByRole('button', { name: 'Delete page Clan trophies', exact: true })
    .click();
  await expect(
    panel.getByRole('button', {
      name: 'Delete page Clan trophies',
      exact: true,
    }),
  ).toBeVisible();
  await order.getByRole('combobox').selectOption({ label: 'Clan trophies' });
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('both collection logs');
    await dialog.accept();
  });
  await panel
    .getByRole('button', { name: 'Delete page Clan trophies', exact: true })
    .click();
  await expect(panel.getByRole('status')).toHaveText(
    'Clan trophies deleted. 0 items removed from their last page.',
  );
  await expect(
    order
      .getByRole('combobox')
      .locator('option')
      .filter({ hasText: 'Clan trophies' }),
  ).toHaveCount(0);
  await expect(order.getByRole('listitem')).not.toHaveCount(0);
  await order.getByRole('combobox').selectOption({ label: 'Duke Sucellus' });
  await expect(
    order.getByRole('listitem').filter({ hasText: 'Virtus mask' }),
  ).toHaveCount(1);
  // A source page disappears, with only its unique items removed from the catalog.
  page.once('dialog', (dialog) => dialog.accept());
  await panel
    .getByRole('button', { name: 'Delete page Duke Sucellus', exact: true })
    .click();
  await expect(panel.getByRole('status')).toHaveText(
    'Duke Sucellus deleted. 5 items removed from their last page.',
  );
  await expect(
    order
      .getByRole('combobox')
      .locator('option')
      .filter({ hasText: 'Duke Sucellus' }),
  ).toHaveCount(0);
  await order.getByRole('combobox').selectOption({ label: 'Vardorvis' });
  await expect(
    order.getByRole('listitem').filter({ hasText: 'Virtus mask' }),
  ).toHaveCount(1);
  await page.locator('header a.clan-brand').click();
  await expect(
    page
      .locator('.page-list')
      .getByRole('button', { name: 'Duke Sucellus', exact: true }),
  ).toHaveCount(0);
});
