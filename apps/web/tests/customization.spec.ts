import { expect, test } from '@playwright/test';
import { previewCatalog } from '../src/preview/scenarios.ts';
import { resolve } from 'node:path';
import { adminFixtures } from './admin-fixtures.ts';
import { defaultBranding } from '../src/branding.ts';

test('site settings lives on its own page and edited labels appear across the public site', async ({
  page,
}) => {
  await page.goto('/admin?preview=1');
  await expect(
    page.getByRole('heading', { name: 'Site settings', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('link', { name: 'Site settings', exact: true }).click();
  await expect(
    page
      .getByRole('navigation', { name: 'Admin navigation' })
      .getByRole('link'),
  ).toHaveText([
    'Submissions',
    'Items catalog',
    'XP imports',
    'Scheduling',
    'RuneLite submissions',
    'Site settings',
    'Hardcore worlds',
    'Moderator accounts',
    'Your account',
  ]);
  await expect(
    page.getByLabel('Current shared API key', { exact: true }),
  ).toHaveCount(0);
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
  await expect(
    page.getByLabel('XP total caption', { exact: true }),
  ).toHaveCount(0);
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
  for (const width of [1100, 320]) {
    await page.setViewportSize({ width, height: 850 });
    const caption = await page.locator('.log-help').boundingBox();
    const log = await page.locator('.game-window').boundingBox();
    expect(caption!.y + caption!.height).toBeLessThan(log!.y);
    const sizes = await page.evaluate(() =>
      [
        document.querySelector('.log-help'),
        document.querySelector('.event-tracker > h1'),
      ].map((node) => getComputedStyle(node!).fontSize),
    );
    expect(sizes[0]).toBe(sizes[1]);
  }
  await page.setViewportSize({ width: 1100, height: 850 });
  await expect(
    page.getByRole('heading', { name: 'Clan training', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Across all recorded SOTW events', { exact: true }),
  ).toHaveCount(0);
  await expect(page).toHaveTitle('Clan name · Our clan collection');
  await expect(page.locator('.site-footer')).not.toContainText(
    'One clan. Every collection.',
  );
  await expect(
    page.getByRole('link', { name: 'GitHub', exact: true }),
  ).toHaveAttribute('href', 'https://github.com/KihiraLove');
  expect(
    await page
      .locator('.github-support')
      .evaluate((node) => getComputedStyle(node).backgroundColor),
  ).toBe('rgb(255, 255, 255)');
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
test('hardcore appearance can be configured while disabled and switches independently on the public site', async ({
  page,
}) => {
  await page.goto('/admin/settings?preview=1');
  const logo = await page
    .getByRole('heading', { name: 'Clan logo', exact: true })
    .boundingBox();
  const name = await page
    .getByLabel('Clan name', { exact: true })
    .boundingBox();
  expect(logo!.y).toBeLessThan(name!.y);
  await expect(
    page.getByLabel('XP total caption', { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole('link', { name: 'Hardcore worlds', exact: true })
    .click();
  await expect(page.getByLabel('Enable hardcore worlds')).not.toBeChecked();
  const flag = await page.getByLabel('Enable hardcore worlds').boundingBox();
  const hardcoreLogo = await page
    .getByRole('heading', { name: 'Clan logo', exact: true })
    .boundingBox();
  expect(flag!.y).toBeLessThan(hardcoreLogo!.y);
  await page.getByLabel('Displayed clan name').fill('Hardcore clan');
  await page
    .getByLabel('Collection log title', { exact: true })
    .fill('Hardcore collection');
  await page
    .getByLabel('Collection log caption', { exact: true })
    .fill('Hardcore drops');
  await page
    .getByLabel('XP section title', { exact: true })
    .fill('Hardcore training');
  await page
    .getByLabel('Logo image')
    .setInputFiles(resolve('public/skills/sailing.png'));
  await page
    .getByRole('button', { name: 'Save clan logo', exact: true })
    .click();
  await expect(
    page.getByText('Clan logo and website icon saved.'),
  ).toBeVisible();
  const hcLogo = await page
    .getByAltText('Current clan logo')
    .getAttribute('src');
  await page
    .getByRole('button', { name: 'Save hardcore settings', exact: true })
    .click();
  await expect(page.getByText('Hardcore worlds settings saved.')).toBeVisible();
  await page.locator('header a.clan-brand').click();
  await expect(page.locator('.clan-name')).toHaveText('Clan name');
  await expect(page.locator('header .clan-logo')).toHaveAttribute(
    'src',
    defaultBranding.logoPath,
  );
  await expect(
    page.getByRole('button', { name: 'Hardcore worlds', exact: true }),
  ).toHaveCount(0);
  await page.goBack();
  await page.getByLabel('Enable hardcore worlds').check();
  await page
    .getByRole('button', { name: 'Save hardcore settings', exact: true })
    .click();
  await expect(page.getByText('Hardcore worlds settings saved.')).toBeVisible();
  await page.locator('header a.clan-brand').click();
  await page
    .getByRole('button', { name: 'Hardcore worlds', exact: true })
    .click();
  await expect(page.locator('.clan-name')).toHaveText('Hardcore clan');
  await expect(page.locator('header .clan-logo')).toHaveAttribute(
    'src',
    hcLogo!,
  );
  await expect(
    page.getByRole('heading', { name: 'Hardcore training', exact: true }),
  ).toBeVisible();
  await expect(page).toHaveTitle('Hardcore clan · Hardcore collection');
  await expect(page.locator('.log-help')).toContainText('Hardcore drops');
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
    'href',
    /^blob:/,
  );
  await page.screenshot({
    path: test.info().outputPath('hardcore-customized-desktop.png'),
    fullPage: true,
  });
  await page
    .getByRole('button', { name: 'Hardcore worlds', exact: true })
    .click();
  await expect(page.locator('.clan-name')).toHaveText('Clan name');
  await expect(page.locator('header .clan-logo')).toHaveAttribute(
    'src',
    defaultBranding.logoPath,
  );
  await page.goBack();
  await page.getByLabel('Enable hardcore worlds').uncheck();
  await page
    .getByRole('button', { name: 'Save hardcore settings', exact: true })
    .click();
  await expect(page.getByText('Hardcore worlds settings saved.')).toBeVisible();
  await expect(page.getByLabel('Displayed clan name')).toHaveValue(
    'Hardcore clan',
  );
  await expect(page.getByAltText('Current clan logo')).toHaveAttribute(
    'src',
    hcLogo!,
  );
  await page.setViewportSize({ width: 320, height: 850 });
  await page.evaluate(() => {
    (document.activeElement as HTMLElement)?.blur();
    window.scrollTo(0, 0);
  });
  await page.screenshot({
    path: test.info().outputPath('hardcore-settings-disabled-mobile.png'),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole('link', { name: 'XP imports', exact: true }).click();
  await expect(page.locator('.event-tracker > h1')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Import competition', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('admin-xp-mobile.png'),
    fullPage: true,
  });
});

test('empty submission filters preserve panel and pagination geometry while loading', async ({
  page,
}) => {
  const fixture = await adminFixtures();
  let release: (() => void) | undefined;
  let delay = false;
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/auth/session')
      return route.fulfill({ json: fixture.session });
    if (path === '/api/v1/settings')
      return route.fulfill({
        json: {
          revision: 'settings-1',
          clanName: 'Clan name',
          hardcoreEnabled: false,
        },
      });
    if (path.startsWith('/api/v1/branding'))
      return route.fulfill({ json: defaultBranding });
    if (path === '/api/v1/admin/catalog')
      return route.fulfill({ json: fixture.catalog });
    if (path === '/api/v1/admin/submissions') {
      if (delay)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return route.fulfill({
        json: { ...fixture.pending, submissions: [], nextCursor: null },
      });
    }
    return route.fulfill({ status: 404, json: { error: 'Not found' } });
  });
  await page.goto('/admin');
  await expect(
    page.getByText('No pending submissions in this view.'),
  ).toBeVisible();
  const panel = page.locator('.admin-panel').filter({
    has: page.getByRole('heading', { name: 'Submissions', exact: true }),
  });
  const before = await panel.boundingBox(),
    pagination = await page.locator('.admin-pagination').boundingBox();
  for (const view of ['Unmatched', 'Reviewed', 'Pending']) {
    delay = true;
    release = undefined;
    await page.getByRole('button', { name: view, exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Loading');
    expect(await panel.boundingBox()).toEqual(before);
    expect(await page.locator('.admin-pagination').boundingBox()).toEqual(
      pagination,
    );
    await expect.poll(() => Boolean(release)).toBe(true);
    delay = false;
    release!();
    await expect(
      page.getByText(`No ${view.toLowerCase()} submissions in this view.`),
    ).toBeVisible();
    expect(await panel.boundingBox()).toEqual(before);
    expect(await page.locator('.admin-pagination').boundingBox()).toEqual(
      pagination,
    );
  }
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
test('item management confirms page-only deletion, retires the last membership and preserves reviews', async ({
  page,
}) => {
  await page.goto('/admin/catalog?preview=1');
  await expect(
    page.getByRole('heading', { name: 'Item management', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Catalog maintenance', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Delete catalog item', exact: true }),
  ).toHaveCount(0);
  const picker = page.getByRole('group', {
    name: 'Collection-log pages (required)',
  });
  const search = picker.getByRole('searchbox', {
    name: 'Search collection-log pages',
  });
  await expect(search).toHaveAttribute('placeholder', 'Search');
  await expect(
    page.getByText('Find collection-log pages', { exact: true }),
  ).toHaveCount(0);
  await search.fill('Duke');
  await expect(picker.getByRole('checkbox')).toHaveCount(1);
  await expect(
    picker.getByRole('checkbox', { name: 'Duke Sucellus', exact: true }),
  ).toBeVisible();
  await search.fill('');
  const mask = previewCatalog.items.find(
    (item) => item.name === 'Virtus mask',
  )!;
  const pages = previewCatalog.pages.filter((row) =>
    row.itemIds.includes(mask.id),
  );
  const initial = pages.find((row) => row.id === 'vardorvis')!;
  const confirm = async (name: string, accept: boolean, last = false) => {
    await Promise.all([
      page.waitForEvent('dialog').then(async (dialog) => {
        expect(dialog.type()).toBe('confirm');
        expect(dialog.message()).toContain('Are you sure');
        expect(dialog.message()).toContain('Virtus mask from ' + name);
        expect(dialog.message()).toContain(last ? 'last page' : 'other pages');
        if (accept) await dialog.accept();
        else await dialog.dismiss();
      }),
      page
        .getByRole('button', {
          name: 'Delete Virtus mask from ' + name,
          exact: true,
        })
        .click(),
    ]);
  };
  await confirm(initial.name, false);
  await expect(
    page
      .locator('.page-order-editor .page-order-list li')
      .filter({ hasText: 'Virtus mask' }),
  ).toHaveCount(1);
  await confirm(initial.name, true);
  await expect(
    page
      .locator('.page-order-editor .page-order-list li')
      .filter({ hasText: 'Virtus mask' }),
  ).toHaveCount(0);
  await page.locator('header a.clan-brand').click();
  await expect(
    page.locator('.item-slot[aria-label^="Virtus mask:"]'),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Duke Sucellus', exact: true })
    .click();
  await expect(
    page.locator('.item-slot[aria-label^="Virtus mask:"]'),
  ).toHaveCount(1);
  await page.goBack();
  await expect(
    page.getByRole('heading', { name: 'Item management', exact: true }),
  ).toBeVisible();
  const remaining = pages.filter((row) => row.id !== initial.id);
  for (const [index, row] of remaining.entries()) {
    await page
      .getByLabel('Collection-log page', { exact: true })
      .selectOption(row.id);
    await confirm(row.name, true, index === remaining.length - 1);
    await expect(
      page
        .locator('.page-order-editor .page-order-list li')
        .filter({ hasText: 'Virtus mask' }),
    ).toHaveCount(0);
  }
  await expect(
    page.getByText('Virtus mask deleted from its last page and the catalog.', {
      exact: true,
    }),
  ).toBeVisible();
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
    path: test.info().outputPath('item-management-mobile.png'),
    fullPage: true,
  });
  await page.getByRole('link', { name: 'Submissions', exact: true }).click();
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
  await expect(
    page.getByText('Saved submission state: rejected.', { exact: true }),
  ).toBeVisible();
});
