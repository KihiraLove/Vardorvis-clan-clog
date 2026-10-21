import { expect, test, type Page } from './test.ts';
import { adminFixtures } from './admin-fixtures.ts';
import { MemoryAdminClient } from './support/admin.ts';
import { MemoryXpClient } from './support/xp.ts';
import { defaultBranding } from '../src/branding.ts';

async function routedAdmin(page: Page) {
  const f = await adminFixtures(),
    client = new MemoryAdminClient(),
    signal = new AbortController().signal;
  const responses: Record<string, unknown> = {
    '/api/v1/auth/session': f.session,
    '/api/v1/settings': await client.settings(signal),
    '/api/v1/admin/settings': await client.settings(signal),
    '/api/v1/branding': defaultBranding,
    '/api/v1/branding/hardcore': defaultBranding,
    '/api/v1/admin/branding': defaultBranding,
    '/api/v1/admin/branding/hardcore': defaultBranding,
    '/api/v1/admin/catalog': f.catalog,
    '/api/v1/admin/catalog-updates': f.catalogUpdates,
    '/api/v1/admin/submissions': f.pending,
    '/api/v1/admin/schedules': await client.scheduling(signal),
    '/api/v1/admin/clan-api-key': await client.clanApiKey(signal),
    '/api/v1/admin/runelite-settings': await client.runeLiteSettings(signal),
    '/api/v1/admin/accounts': { accounts: await client.accounts(signal) },
    '/api/v1/xp/tracker': await new MemoryXpClient().tracker(signal),
    '/api/v1/admin/xp/imports': {
      imports: [],
      revision: 'xp-history-1',
      pageCursor: 'xp-first',
      nextCursor: null,
    },
    '/api/v1/competitions/activities': {
      serverNow: new Date().toISOString(),
      competitions: [],
    },
  };
  const holds = new Map<string, { wait: Promise<void>; release: () => void }>();
  const failures = new Map<string, number>();
  const requests: string[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    const held = holds.get(path);
    if (held) await held.wait;
    if (path === '/api/v1/auth/logout') {
      responses['/api/v1/auth/session'] = { authenticated: false };
      return route.fulfill({ status: 204 });
    }
    const status = failures.get(path) ?? (path in responses ? 200 : 404);
    await route.fulfill({
      status,
      json: status === 200 ? responses[path] : { error: 'Controlled failure' },
    });
  });
  return {
    requests,
    fail(path: string, status = 503) {
      failures.set(path, status);
    },
    recover(path: string) {
      failures.delete(path);
    },
    block(path: string) {
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      holds.set(path, { wait, release });
      return () => {
        if (holds.get(path)?.wait === wait) holds.delete(path);
        release();
      };
    },
  };
}
const account = (page: Page) =>
  page.getByRole('heading', { name: 'Your account', exact: true });
const catalogLink = (page: Page) =>
  page.getByRole('link', { name: 'Items catalog', exact: true });
const calls = (requests: string[], path: string) =>
  requests.filter((request) => request === path).length;

test('scrolling before a native history event cannot overwrite its destination', async ({
  page,
}) => {
  await routedAdmin(page);
  await page.goto('/admin/account');
  await expect(account(page)).toBeVisible();
  // Native history can change the address before its popstate notification.
  // Reproduce a scroll notification in that interval deterministically.
  await page.evaluate(() => {
    history.pushState(
      { clogPosition: history.state.clogPosition + 1, clogScroll: [0, 0] },
      '',
      '/admin/catalog',
    );
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(
      new PopStateEvent('popstate', { state: history.state }),
    );
  });
  await expect(
    page.getByRole('heading', { name: 'Items catalog', exact: true }),
  ).toBeVisible();
  await expect(catalogLink(page)).toHaveAttribute('aria-current', 'page');
  expect(new URL(page.url()).pathname).toBe('/admin/catalog');
  await page.getByRole('link', { name: 'Your account', exact: true }).click();
  await expect(account(page)).toBeVisible();
  await catalogLink(page).click();
  await expect(
    page.getByRole('heading', { name: 'Items catalog', exact: true }),
  ).toBeVisible();
});

test('scrolling between repeated admin navigations keeps the URL, current link and visible page together', async ({
  page,
}) => {
  await routedAdmin(page);
  await page.goto('/admin');
  const destinations = [
    ['Items catalog', '/admin/catalog', 'Items catalog'],
    ['RuneLite submissions', '/admin/runelite', 'RuneLite submissions'],
    ['Your account', '/admin/account', 'Your account'],
    ['Scheduling and Competitions', '/admin/schedules', 'Schedule management'],
    ['Submissions', '/admin', 'Submissions'],
  ];
  for (let cycle = 0; cycle < 6; cycle++) {
    for (const [label, path, heading] of destinations) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      const link = page.getByRole('link', { name: label, exact: true });
      await link.click();
      await expect(
        page.getByRole('heading', { name: heading, exact: true }),
      ).toBeVisible();
      await expect(link).toHaveAttribute('aria-current', 'page');
      expect(new URL(page.url()).pathname).toBe(path);
    }
  }
});

test('route failure retains current content and URL; Retry prepares once and commits history and focus', async ({
  page,
}) => {
  const fixture = await routedAdmin(page);
  await page.goto('/admin/account');
  await expect(account(page)).toBeVisible();
  const length = await page.evaluate(() => history.length);
  fixture.fail('/api/v1/admin/catalog');
  await catalogLink(page).click();
  await expect(page.getByRole('alert')).toContainText(
    'This page could not be loaded',
  );
  await expect(account(page)).toBeVisible();
  await expect(page.getByLabel('Item name', { exact: true })).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe('/admin/account');
  expect(await page.evaluate(() => history.length)).toBe(length);
  fixture.recover('/api/v1/admin/catalog');
  await page.getByRole('button', { name: 'Retry navigation' }).click();
  await expect(
    page.getByRole('heading', { name: 'Items catalog', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Items catalog', exact: true }),
  ).toBeFocused();
  expect(new URL(page.url()).pathname).toBe('/admin/catalog');
  expect(await page.evaluate(() => history.length)).toBe(length + 1);
  expect(calls(fixture.requests, '/api/v1/admin/catalog')).toBe(2);
  expect(calls(fixture.requests, '/api/v1/auth/session')).toBe(1);
});

test('timeout and Cancel settle without committing; a later response cannot mount an editor', async ({
  page,
}) => {
  const fixture = await routedAdmin(page);
  await page.clock.install();
  await page.goto('/admin/account');
  await expect(account(page)).toBeVisible();
  const release = fixture.block('/api/v1/admin/catalog');
  await catalogLink(page).click();
  await expect
    .poll(() => calls(fixture.requests, '/api/v1/admin/catalog'))
    .toBe(1);
  await page.clock.fastForward(10001);
  await expect(page.getByRole('alert')).toContainText('Loading timed out');
  await expect(account(page)).toBeVisible();
  await page.getByRole('button', { name: 'Cancel navigation' }).click();
  release();
  await expect(
    page.getByRole('complementary', { name: 'Page navigation' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Items catalog', exact: true }),
  ).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe('/admin/account');
});

test('rapid destinations cancel previous generations and mount only the latest ready page', async ({
  page,
}) => {
  const fixture = await routedAdmin(page);
  await page.goto('/admin/account');
  await expect(account(page)).toBeVisible();
  const releaseCatalog = fixture.block('/api/v1/admin/catalog');
  const releaseSettings = fixture.block('/api/v1/admin/settings');
  await catalogLink(page).click();
  await expect
    .poll(() => calls(fixture.requests, '/api/v1/admin/catalog'))
    .toBe(1);
  await page.getByRole('link', { name: 'Site settings', exact: true }).click();
  await expect
    .poll(() => calls(fixture.requests, '/api/v1/admin/settings'))
    .toBe(1);
  await expect(account(page)).toBeVisible();
  await page
    .getByRole('link', { name: 'RuneLite submissions', exact: true })
    .click();
  await expect(page.getByLabel('Current shared API key')).toBeEnabled();
  releaseCatalog();
  releaseSettings();
  await expect(
    page.getByRole('heading', { name: 'Your account', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Items catalog', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Site settings', exact: true }),
  ).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe('/admin/runelite');
  expect(calls(fixture.requests, '/api/v1/admin/clan-api-key')).toBe(1);
  expect(calls(fixture.requests, '/api/v1/admin/runelite-settings')).toBe(1);
});

test('Back/Forward load ready data and Cancel restores the original entry without deleting history', async ({
  page,
}) => {
  const fixture = await routedAdmin(page);
  await page.goto('/admin/account');
  await expect(account(page)).toBeVisible();
  await catalogLink(page).click();
  await expect(
    page.getByRole('heading', { name: 'Items catalog', exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Your account', exact: true }).click();
  await expect(account(page)).toBeVisible();
  const length = await page.evaluate(() => history.length);
  const release = fixture.block('/api/v1/admin/catalog');
  await page.goBack();
  await expect
    .poll(() => calls(fixture.requests, '/api/v1/admin/catalog'))
    .toBe(2);
  await expect(account(page)).toBeVisible();
  await page.getByRole('button', { name: 'Cancel navigation' }).click();
  await expect(page).toHaveURL(/\/admin\/account$/);
  await page.goBack();
  await expect
    .poll(() => calls(fixture.requests, '/api/v1/admin/catalog'))
    .toBe(3);
  release();
  await expect(
    page.getByRole('heading', { name: 'Items catalog', exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(account(page)).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(length);
});

test('dirty forms survive a declined leave; confirmed navigation discards the draft', async ({
  page,
}) => {
  await routedAdmin(page);
  await page.goto('/admin/account');
  const currentPassword = page.getByLabel('Current password', { exact: true });
  await currentPassword.fill('unsaved-test-password');
  page.once('dialog', (dialog) => dialog.dismiss());
  await catalogLink(page).click();
  await expect(currentPassword).toHaveValue('unsaved-test-password');
  expect(new URL(page.url()).pathname).toBe('/admin/account');
  page.once('dialog', (dialog) => dialog.accept());
  await catalogLink(page).click();
  await expect(
    page.getByRole('heading', { name: 'Items catalog', exact: true }),
  ).toBeVisible();
  await expect(currentPassword).toHaveCount(0);
  await page.getByRole('link', { name: 'Your account', exact: true }).click();
  await expect(currentPassword).toHaveValue('');
});

test('logout cancels pending navigation and late private reads cannot revive the signed-out shell', async ({
  page,
}) => {
  const fixture = await routedAdmin(page);
  await page.goto('/admin/account');
  await expect(account(page)).toBeVisible();
  const release = fixture.block('/api/v1/admin/catalog');
  await catalogLink(page).click();
  await expect
    .poll(() => calls(fixture.requests, '/api/v1/admin/catalog'))
    .toBe(1);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Admin sign-in required' }),
  ).toBeVisible();
  release();
  await expect(
    page.getByRole('navigation', { name: 'Admin navigation' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Items catalog', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel('Current password', { exact: true }),
  ).toHaveCount(0);
});

test('a destination 401 immediately clears the current private page without another session read', async ({
  page,
}) => {
  const fixture = await routedAdmin(page);
  await page.goto('/admin/account');
  await expect(account(page)).toBeVisible();
  fixture.fail('/api/v1/admin/catalog', 401);
  await catalogLink(page).click();
  await expect(
    page.getByRole('heading', { name: 'Admin session expired' }),
  ).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Admin navigation' }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel('Current password', { exact: true }),
  ).toHaveCount(0);
  expect(calls(fixture.requests, '/api/v1/auth/session')).toBe(1);
});

test('refresh and deep links use one stable shell with no hidden forms or duplicate initial reads', async ({
  page,
}) => {
  const fixture = await routedAdmin(page);
  let release = fixture.block('/api/v1/admin/catalog');
  await page.goto('/admin/catalog');
  await expect
    .poll(() => calls(fixture.requests, '/api/v1/admin/catalog'))
    .toBe(1);
  await expect(page.locator('.admin-route-shell')).toBeVisible();
  await expect(page.getByLabel('Item name', { exact: true })).toHaveCount(0);
  const before = await page.locator('.admin-route-shell').boundingBox();
  await page.getByRole('button', { name: 'Cancel navigation' }).click();
  await expect(page.getByRole('alert')).toContainText('Loading cancelled');
  expect(await page.locator('.admin-route-shell').boundingBox()).toEqual(
    before,
  );
  release();
  await page.getByRole('button', { name: 'Retry navigation' }).click();
  await expect(
    page.getByRole('heading', { name: 'Items catalog', exact: true }),
  ).toBeVisible();
  expect(calls(fixture.requests, '/api/v1/admin/catalog')).toBe(2);
  release = fixture.block('/api/v1/admin/catalog');
  await page.reload();
  await expect(page.locator('.admin-route-shell')).toBeVisible();
  await expect(page.getByLabel('Item name', { exact: true })).toHaveCount(0);
  release();
  await expect(
    page.getByRole('heading', { name: 'Items catalog', exact: true }),
  ).toBeVisible();
  expect(calls(fixture.requests, '/api/v1/admin/catalog')).toBe(3);
  expect(calls(fixture.requests, '/api/v1/auth/session')).toBe(2);
});

test('Back respects a dirty catalog draft and a declined leave restores the current entry', async ({
  page,
}) => {
  await routedAdmin(page);
  await page.goto('/admin/account');
  await expect(account(page)).toBeVisible();
  await catalogLink(page).click();
  await page.getByRole('button', { name: '+ Add item', exact: true }).click();
  await page.getByRole('button', { name: 'Add new item', exact: true }).click();
  const name = page.getByLabel('Item name', { exact: true });
  await name.fill('Unsaved item');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/catalog$/);
  await expect(name).toHaveValue('Unsaved item');
  page.once('dialog', (dialog) => dialog.accept());
  await page.goBack();
  await expect(account(page)).toBeVisible();
});

test('edits made while a destination loads are protected at commit', async ({
  page,
}) => {
  const fixture = await routedAdmin(page);
  await page.goto('/admin/account');
  await expect(account(page)).toBeVisible();
  const release = fixture.block('/api/v1/admin/catalog');
  await catalogLink(page).click();
  await expect
    .poll(() => calls(fixture.requests, '/api/v1/admin/catalog'))
    .toBe(1);
  const password = page.getByLabel('Current password', { exact: true });
  await password.fill('late-unsaved-test-password');
  page.once('dialog', (dialog) => dialog.dismiss());
  release();
  await expect(
    page.getByRole('complementary', { name: 'Page navigation' }),
  ).toHaveCount(0);
  await expect(password).toHaveValue('late-unsaved-test-password');
  expect(new URL(page.url()).pathname).toBe('/admin/account');
});

test('a staff write in progress blocks route commit instead of unmounting its form', async ({
  page,
}) => {
  await routedAdmin(page);
  let release!: () => void;
  const write = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await adminFixtures();
  await page.route('**/api/v1/auth/account', async (route) => {
    await write;
    await route.fulfill({ json: { ...fixture.session, username: 'NewName' } });
  });
  await page.goto('/admin/account');
  await page
    .getByLabel('Current password', { exact: true })
    .fill('test-current-password');
  await page.getByLabel('Username', { exact: true }).fill('NewName');
  await page.getByRole('button', { name: 'Save account', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Saving…', exact: true }),
  ).toBeDisabled();
  await catalogLink(page).click();
  await expect(page.getByRole('alert')).toContainText(
    'Wait for the current staff operation',
  );
  await expect(account(page)).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/admin/account');
  release();
  await expect(
    page.getByRole('button', { name: 'Save account', exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByLabel('Current password', { exact: true }),
  ).toHaveValue('');
  await catalogLink(page).click();
  await expect(
    page.getByRole('heading', { name: 'Items catalog', exact: true }),
  ).toBeVisible();
});

test('a new link supersedes a pending Back load and pushes from the restored current entry', async ({
  page,
}) => {
  const fixture = await routedAdmin(page);
  await page.goto('/admin/account');
  await expect(account(page)).toBeVisible();
  await catalogLink(page).click();
  await expect(
    page.getByRole('heading', { name: 'Items catalog', exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Your account', exact: true }).click();
  await expect(account(page)).toBeVisible();
  const release = fixture.block('/api/v1/admin/catalog');
  await page.goBack();
  await expect
    .poll(() => calls(fixture.requests, '/api/v1/admin/catalog'))
    .toBe(2);
  await page
    .getByRole('link', { name: 'RuneLite submissions', exact: true })
    .click();
  await expect(page.getByLabel('Current shared API key')).toBeEnabled();
  release();
  await page.goBack();
  await expect(account(page)).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole('heading', { name: 'Items catalog', exact: true }),
  ).toBeVisible();
});

test('requesting the current page cancels a pending destination without adding a history entry', async ({
  page,
}) => {
  const fixture = await routedAdmin(page);
  await page.goto('/admin/account');
  await expect(account(page)).toBeVisible();
  const length = await page.evaluate(() => history.length);
  const release = fixture.block('/api/v1/admin/catalog');
  await catalogLink(page).click();
  await expect
    .poll(() => calls(fixture.requests, '/api/v1/admin/catalog'))
    .toBe(1);
  await page.getByRole('link', { name: 'Your account', exact: true }).click();
  release();
  await expect(
    page.getByRole('complementary', { name: 'Page navigation' }),
  ).toHaveCount(0);
  await expect(account(page)).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/admin/account');
  expect(await page.evaluate(() => history.length)).toBe(length);
});
