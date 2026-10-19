import { mockApi } from './mock-api.ts';
import { expect, test, pngFile } from './test.ts';
import { fixtureCatalog } from './support/scenarios.ts';
import { resolve } from 'node:path';
import { adminFixtures } from './admin-fixtures.ts';
import { defaultBranding } from '../src/branding.ts';

test('site settings lives on its own page and edited labels appear across the public site', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto('/admin');
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
    'Scheduling and Competitions',
    'RuneLite submissions',
    'Site settings',
    'Hardcore worlds',
    'Discord bot',
    'Access control',
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
    const captionSize = await page
      .locator('.log-help')
      .evaluate((node) => getComputedStyle(node).fontSize);
    await page.getByRole('link', { name: 'Xp tracker', exact: true }).click();
    await expect(page.locator('.event-tracker > h1')).toHaveCSS(
      'font-size',
      captionSize,
    );
    await expect(page).toHaveTitle('Clan name · Clan training');
    await page
      .getByRole('link', { name: 'Collection log', exact: true })
      .click();
  }
  await page.setViewportSize({ width: 1100, height: 850 });
  await expect(page).toHaveTitle('Clan name · Our clan collection');
  await page.getByRole('link', { name: 'Xp tracker', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Clan training', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Across all recorded SOTW events', { exact: true }),
  ).toHaveCount(0);
  await expect(page).toHaveTitle('Clan name · Clan training');
  await expect(page.locator('.site-footer')).not.toContainText(
    'One clan. Every collection.',
  );
  await expect(
    page.getByRole('link', { name: 'GitHub', exact: true }),
  ).toHaveAttribute('href', 'https://github.com/KihiraLove/clan-clog');
  expect(
    await page
      .locator('.github-support')
      .evaluate((node) => getComputedStyle(node).backgroundColor),
  ).toBe('rgb(255, 255, 255)');
  await expect(
    page.getByRole('link', { name: 'Support this project' }),
  ).toHaveAttribute('href', 'https://ko-fi.com/kihiralove');
  await page.getByRole('link', { name: 'Collection log', exact: true }).click();
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
  await mockApi(page);
  await page.goto('/admin/settings');
  const logo = await page
    .getByRole('heading', { name: 'Clan logo', exact: true })
    .boundingBox();
  const name = await page
    .getByLabel('Displayed clan name', { exact: true })
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
  const release = page.getByRole('switch', {
    name: 'Enable hardcore worlds',
    exact: true,
  });
  await release.click();
  await expect(release).toBeChecked();
  await expect(page.getByLabel('Displayed clan name')).toHaveValue(
    'Hardcore clan',
  );
  await release.click();
  await expect(release).not.toBeChecked();
  await expect(page.getByLabel('Displayed clan name')).toHaveValue(
    'Hardcore clan',
  );
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
    .setInputFiles(await pngFile(resolve('public/skills/sailing.png')));
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
  await page.getByLabel('Enable hardcore worlds').click();
  await expect(
    page.getByRole('switch', { name: 'Enable hardcore worlds', exact: true }),
  ).toBeChecked();
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
  ).toHaveCount(0);
  await expect(page.locator('#xp-tracker')).toHaveCount(0);
  await expect(page).toHaveTitle('Hardcore clan · Hardcore collection');
  await expect(page.locator('.log-help')).toContainText('Hardcore drops');
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
    'href',
    /\/api\/v1\/branding\//,
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
  await page.getByRole('link', { name: 'Admin panel', exact: true }).click();
  await page
    .getByRole('link', { name: 'Hardcore worlds', exact: true })
    .click();
  await page.getByLabel('Enable hardcore worlds').click();
  await expect(
    page.getByRole('switch', { name: 'Enable hardcore worlds', exact: true }),
  ).not.toBeChecked();
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
  await page
    .getByRole('link', { name: 'Scheduling and Competitions', exact: true })
    .click();
  await expect(page.locator('.event-tracker > h1')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Schedule management', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('admin-scheduling-mobile.png'),
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
  await mockApi(page);
  await page.goto('/admin/accounts');
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
    page.getByRole('button', { name: 'Delete test-admin', exact: true }),
  ).toHaveCount(0);
});

test('item settings preserve a pageless item until explicit deletion, including review history', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto('/admin/catalog');
  await page
    .getByRole('button', { name: 'Item settings for Virtus mask', exact: true })
    .click();
  const mask = fixtureCatalog.items.find(
    (item) => item.name === 'Virtus mask',
  )!;
  for (const entry of fixtureCatalog.pages.filter((p) =>
    p.itemIds.includes(mask.id),
  )) {
    await page
      .getByRole('button', {
        name: 'Remove Virtus mask from ' + entry.name,
        exact: true,
      })
      .click();
    await expect(
      page.getByText('Removed from ' + entry.name + '.', { exact: true }),
    ).toBeVisible();
  }
  await expect(
    page.getByText('This item is pageless.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close editor', exact: true }).click();
  await page.getByRole('button', { name: '+ Add item', exact: true }).click();
  await page
    .getByRole('button', { name: 'Add existing item', exact: true })
    .click();
  await page
    .getByRole('searchbox', { name: 'Search items', exact: true })
    .fill('Virtus mask');
  await expect(
    page.getByRole('button', { name: 'Add Virtus mask to page', exact: true }),
  ).toContainText('Pageless');
  await page
    .getByRole('button', { name: 'Add Virtus mask to page', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Item settings for Virtus mask', exact: true })
    .click();
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Delete item', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Edit item Virtus mask', exact: true }),
  ).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete item', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Edit item Virtus mask', exact: true }),
  ).toHaveCount(0);
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
