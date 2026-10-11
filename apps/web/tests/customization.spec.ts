import { expect, test } from '@playwright/test';

test('site settings lives on its own page and edited labels appear across the public site', async ({
  page,
}) => {
  await page.goto('/admin?preview=1');
  await expect(
    page.getByRole('heading', { name: 'Site settings', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('link', { name: 'Site settings', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Site settings', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Submissions', exact: true }),
  ).toHaveCount(0);
  await page
    .getByLabel('Collection log title', { exact: true })
    .fill('Our clan collection');
  await page
    .getByLabel('Collection log caption', { exact: true })
    .fill('Drops earned together');
  await page
    .getByLabel('XP section title', { exact: true })
    .fill('Clan training');
  await page
    .getByLabel('XP total caption', { exact: true })
    .fill('All clan training events');
  await page
    .getByRole('button', { name: 'Save site settings', exact: true })
    .click();
  await expect(page.getByText('Site settings saved.')).toBeVisible();
  await page.setViewportSize({ width: 320, height: 850 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => {
    (document.activeElement as HTMLElement)?.blur();
    window.scrollTo(0, 0);
  });
  await page.screenshot({
    path: test.info().outputPath('site-settings-mobile.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1100, height: 850 });
  await page.locator('header a.clan-brand').click();
  await expect(page.locator('.clan-subtitle')).toHaveText(
    'Our clan collection',
  );
  await expect(page.locator('.log-help')).toHaveText('Drops earned together');
  await expect(
    page.getByRole('heading', { name: 'Clan training', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('All clan training events', { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveTitle('Vardorvis · Our clan collection');
  await expect(page.locator('.site-footer')).not.toContainText(
    'One clan. Every collection.',
  );
  await expect(
    page.getByRole('link', { name: 'GitHub · KihiraLove' }),
  ).toHaveAttribute('href', 'https://github.com/KihiraLove');
  await expect(
    page.getByRole('link', { name: 'Support me on Ko-fi' }),
  ).toHaveAttribute('href', 'https://ko-fi.com/kihiralove');
  const search = await page.locator('.game-search').boundingBox(),
    window = await page.locator('.game-window').boundingBox();
  expect(search!.x - window!.x).toBeLessThan(20);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const input = await page.getByPlaceholder('Search pages...').boundingBox();
  expect(input!.x - window!.x).toBeLessThan(30);
  await page.getByPlaceholder('Search pages...').fill('Duke');
  await expect(page.locator('.page-list button')).toHaveCount(1);
  await page.screenshot({
    path: test.info().outputPath('custom-labels-and-footer.png'),
    fullPage: true,
  });
});
test('administrator can disable, re-enable and delete moderator accounts without administrator controls', async ({
  page,
}) => {
  await page.goto('/admin/accounts?preview=1');
  await page.getByLabel('Moderator username').fill('reviewer');
  await page
    .getByLabel('Temporary password')
    .fill('preview-moderator-password');
  await page
    .getByRole('button', { name: 'Create moderator', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Disable reviewer', exact: true })
    .click();
  await expect(
    page.getByText('Moderator reviewer disabled.', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Enable reviewer', exact: true })
    .click();
  await expect(
    page.getByText('Moderator reviewer enabled.', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Delete reviewer', exact: true })
    .click();
  await page
    .getByRole('group', { name: 'Confirm moderator deletion' })
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Delete reviewer', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Delete reviewer', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Confirm delete moderator', exact: true })
    .click();
  await expect(
    page.getByText('Moderator reviewer deleted.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Delete reviewer', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Delete preview-admin', exact: true }),
  ).toHaveCount(0);
});
test('catalog deletion requires confirmation, removes the shared item from all pages and keeps reviews', async ({
  page,
}) => {
  await page.goto('/admin/catalog?preview=1');
  await page
    .getByLabel('Find item to delete', { exact: true })
    .fill('Virtus mask');
  await page
    .getByRole('combobox', { name: 'Item to delete', exact: true })
    .selectOption({ index: 1 });
  await page
    .getByRole('button', { name: 'Delete selected item', exact: true })
    .click();
  await page
    .getByRole('group', { name: 'Confirm item deletion' })
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Delete selected item', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Confirm delete item', exact: true })
    .click();
  await expect(
    page.getByText('Virtus mask deleted from the active catalog.', {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Submissions', exact: true }).click();
  await expect(
    page.getByRole('button', { name: /^Review KihiraVD/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: /^Review KihiraVD/ }).click();
  await expect(
    page.getByText(/is no longer in the active catalog/),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Approve submission', exact: true }),
  ).toBeDisabled();
  await page.getByLabel('Review reason').fill('Item removed from clan catalog');
  await page
    .getByRole('button', { name: 'Reject submission', exact: true })
    .click();
  await page.getByRole('button', { name: 'Reviewed', exact: true }).click();
  await expect(
    page.getByRole('button', { name: /^Review KihiraVD/ }),
  ).toBeVisible();
  await expect(
    page.locator('.submission-card').filter({ hasText: 'KihiraVD' }),
  ).toContainText('rejected');
  await page.locator('header a.clan-brand').click();
  await expect(
    page.getByRole('button', { name: /^Virtus mask: / }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Duke Sucellus', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: /^Virtus mask: / }),
  ).toHaveCount(0);
});
