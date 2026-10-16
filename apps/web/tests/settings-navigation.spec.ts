import { expect, test, type Page } from '@playwright/test';
import { adminFixtures } from './admin-fixtures.ts';
import { defaultBranding } from '../src/branding.ts';
import { PreviewAdminClient } from '../src/preview/admin.ts';
import { PreviewXpClient } from '../src/preview/xp.ts';
import { defaultRuneLiteRules } from '@clog/domain';

async function delayedSettings(page: Page) {
  const fixture = await adminFixtures(),
    signal = new AbortController().signal;
  const settings = await new PreviewAdminClient().settings(signal);
  const tracker = await new PreviewXpClient().tracker(signal);
  const pending: (() => void)[] = [];
  let hold = false;
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/v1/auth/session': fixture.session,
      '/api/v1/settings': settings,
      '/api/v1/admin/settings': settings,
      '/api/v1/branding': defaultBranding,
      '/api/v1/branding/hardcore': defaultBranding,
      '/api/v1/admin/branding': defaultBranding,
      '/api/v1/admin/branding/hardcore': defaultBranding,
      '/api/v1/admin/clan-api-key': {
        revision: 'clan-key-1',
        enabled: true,
        key: 'a'.repeat(32),
      },
      '/api/v1/admin/runelite-settings': {
        revision: 'runelite-1',
        ...defaultRuneLiteRules('Clan name'),
      },
      '/api/v1/admin/catalog': fixture.catalog,
      '/api/v1/admin/submissions': fixture.pending,
      '/api/v1/admin/accounts': {
        accounts: [
          {
            id: 'admin-id',
            username: 'admin',
            role: 'admin',
            mustChangePassword: false,
          },
        ],
      },
      '/api/v1/xp/tracker': tracker,
      '/api/v1/admin/xp/imports': {
        imports: [],
        revision: 'xp-history-1',
        pageCursor: 'xp-first',
        nextCursor: null,
      },
    };
    if (hold && path.startsWith('/api/v1/admin/'))
      await new Promise<void>((resolve) => pending.push(resolve));
    await route.fulfill({
      json: responses[path] ?? {},
      status: path in responses ? 200 : 404,
    });
  });
  return {
    hold() {
      hold = true;
    },
    pending: () => pending.length,
    release() {
      hold = false;
      pending.splice(0).forEach((resolve) => resolve());
    },
  };
}

test('settings-navigation: current forms, focus, scroll, panel and footer stay stable until settings are ready', async ({
  page,
}) => {
  const requests = await delayedSettings(page);
  await page.goto('/admin/account');
  await expect(
    page.getByLabel('Current password', { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  for (const width of [1100, 320]) {
    await page.setViewportSize({ width, height: 850 });
    for (const [name, field, calls] of [
      ['Site settings', 'Clan display name', 2],
      ['Hardcore worlds', 'Displayed clan name', 2],
      ['RuneLite submissions', 'Current shared API key', 2],
    ] as const) {
      const currentHeading = page.locator('main h2').first();
      const currentText = await currentHeading.textContent();
      const currentPath = new URL(page.url()).pathname;
      const geometry = async () => ({
        nav: await page
          .getByRole('navigation', { name: 'Admin navigation' })
          .boundingBox(),
        panel: await page.locator('.admin-panel').first().boundingBox(),
        footer: await page.locator('.site-footer').boundingBox(),
        scroll: await page.evaluate(() => scrollY),
      });
      const link = page.getByRole('link', { name, exact: true });
      await link.focus();
      const before = await geometry();
      requests.hold();
      await link.press('Enter');
      await expect.poll(requests.pending).toBe(calls);
      const input = page.getByLabel(field, { exact: true });
      await expect(input).toHaveCount(0);
      await expect(currentHeading).toHaveText(currentText!);
      await expect(link).toBeFocused();
      expect(new URL(page.url()).pathname).toBe(currentPath);
      expect(await geometry()).toEqual(before);
      requests.release();
      await expect(input).toBeEnabled();
      if (name !== 'RuneLite submissions')
        await expect(page.getByLabel('Logo image')).toBeEnabled();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  }
});

test('settings-navigation: admin background stays fixed across delayed page changes', async ({
  page,
}) => {
  const requests = await delayedSettings(page);
  await page.goto('/admin/account');
  await expect(
    page.getByLabel('Current password', { exact: true }),
  ).toBeVisible();
  const background = () =>
    page.screenshot({ clip: { x: 1, y: 400, width: 3, height: 3 } });
  const original = await background();
  for (const [name, ready] of [
    ['Items catalog', 'Items catalog'],
    ['XP imports', 'XP competition imports'],
    ['Submissions', 'Submissions'],
    ['Moderator accounts', 'Existing accounts'],
    ['RuneLite submissions', 'RuneLite submissions'],
  ]) {
    requests.hold();
    await page.getByRole('link', { name: name!, exact: true }).click();
    await expect.poll(requests.pending).toBeGreaterThan(0);
    expect(await background()).toEqual(original);
    requests.release();
    await expect(
      page.getByRole('heading', { name: ready!, exact: true }),
    ).toBeVisible();
    await expect.poll(requests.pending).toBe(0);
    // Wait for data-backed controls so the comparison includes the completed page.
    if (name === 'RuneLite submissions')
      await expect(page.getByLabel('Current shared API key')).toBeEnabled();
    if (name === 'Submissions')
      await expect(
        page.getByRole('button', { name: 'Refresh submissions', exact: true }),
      ).toBeEnabled();
    expect(await background()).toEqual(original);
  }
  await page.getByRole('link', { name: 'Your account', exact: true }).click();
  await expect(
    page.getByLabel('Current password', { exact: true }),
  ).toBeEnabled();
  expect(await background()).toEqual(original);
});
