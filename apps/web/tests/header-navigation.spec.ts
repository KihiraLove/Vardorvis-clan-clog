import { expect, test, type Locator } from './test.ts';
import { mockApi } from './mock-api.ts';

async function geometry(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return Object.fromEntries(
    Object.entries(box!).map(([key, value]) => [
      key,
      Math.round(value * 100) / 100,
    ]),
  );
}

for (const width of [1440, 740, 580, 390, 320]) {
  test(
    'header links keep their position through world modes, administration and login at ' +
      width,
    async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const { admin } = await mockApi(page, { scenario: 'hardcore' });
      const signal = new AbortController().signal;
      let privateReads = 0;
      page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (
          path.startsWith('/api/v1/admin/') ||
          path === '/api/v1/auth/session'
        )
          privateReads++;
      });
      await page.goto('/');
      await expect(page.locator('.clan-name')).toHaveText('Clan name');
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      const entry = page.getByRole('link', {
        name: 'Admin panel',
        exact: true,
      });
      const home = page.getByRole('link', { name: 'Main site', exact: true });
      const skull = page.getByRole('button', {
        name: 'Hardcore worlds',
        exact: true,
      });
      await expect(entry).toBeVisible();
      await expect(entry).toHaveAttribute('href', '/admin');
      await expect(skull).toHaveCount(0);
      expect(privateReads).toBe(0);
      const original = await geometry(entry);
      const helpBounds = await geometry(
        page.getByRole('button', { name: 'How to submit', exact: true }),
      );
      expect(original.x! + original.width!).toBeCloseTo(
        helpBounds.x! + helpBounds.width!,
        1,
      );
      if (width > 580) {
        expect(original.x).toBe(helpBounds.x);
        expect(original.width).toBe(helpBounds.width);
      }
      const caption = await geometry(page.locator('.log-help'));
      await entry.focus();
      await expect(entry).toHaveCSS('outline-style', 'solid');
      await expect(entry).toHaveCSS('outline-width', '2px');
      await entry.hover();
      await expect(entry).toHaveCSS('background-color', 'rgb(73, 64, 45)');
      await page.locator('.site-header').screenshot({
        path: test.info().outputPath('header-disabled-' + width + '.png'),
      });

      const settings = await admin.settings(signal);
      await admin.saveSettings(true, settings.revision, 'test-admin', signal);
      await page.reload();
      await expect(skull).toBeVisible();
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      expect(await geometry(entry)).toEqual(original);
      expect((await geometry(page.locator('.log-help'))).y).toBe(caption.y);
      const skullBounds = await geometry(skull);
      expect(original.x!).toBeGreaterThanOrEqual(
        skullBounds.x! + skullBounds.width!,
      );
      await skull.click();
      await expect(skull).toHaveAttribute('aria-pressed', 'true');
      expect(await geometry(entry)).toEqual(original);
      await page.locator('.site-header').screenshot({
        path: test.info().outputPath('header-hardcore-' + width + '.png'),
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);

      await entry.focus();
      await entry.press('Enter');
      await expect(page).toHaveURL(/\/admin$/);
      await expect(home).toHaveAttribute('href', '/?hardcore=1');
      await expect(skull).toHaveCount(0);
      expect(await geometry(home)).toEqual(original);
      await page
        .getByRole('link', { name: 'Scheduling and Competitions', exact: true })
        .click();
      await expect(
        page.getByRole('heading', { name: 'Schedule management', exact: true }),
      ).toBeVisible();
      expect(await geometry(home)).toEqual(original);
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(
        page.getByRole('heading', {
          name: 'Admin sign-in required',
          exact: true,
        }),
      ).toBeVisible();
      expect(await geometry(home)).toEqual(original);
      await page.locator('.site-header').screenshot({
        path: test.info().outputPath('header-login-' + width + '.png'),
      });
      await home.click();
      await expect(page).toHaveURL(/\/\?hardcore=1$/);
      await expect(skull).toHaveAttribute('aria-pressed', 'true');
      expect(await geometry(entry)).toEqual(original);
      await entry.click();
      await expect(
        page.getByRole('heading', {
          name: 'Admin sign-in required',
          exact: true,
        }),
      ).toBeVisible();
      expect(await geometry(home)).toEqual(original);
    },
  );
}

test('Main site preserves a schedule draft when leaving is cancelled', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto('/admin/schedules');
  const draft = page.getByLabel('Schedule name', { exact: true });
  await draft.fill('Unsaved schedule');
  page.once('dialog', async (d) => {
    expect(d.message()).toContain('Discard unsaved changes');
    await d.dismiss();
  });
  await page.getByRole('link', { name: 'Main site', exact: true }).click();
  await expect(draft).toHaveValue('Unsaved schedule');
  page.once('dialog', async (d) => {
    await d.accept();
  });
  await page.getByRole('link', { name: 'Main site', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
});
test('Main site waits for a pending scheduling save without cancelling the write', async ({
  page,
}) => {
  await mockApi(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writes = 0;
  await page.route('**/api/v1/admin/schedules/settings', async (route) => {
    writes++;
    await held;
    await route.fallback();
  });
  try {
    await page.goto('/admin/schedules');
    await page
      .getByRole('switch', { name: 'Collection log scheduling' })
      .click();
    await expect.poll(() => writes).toBe(1);
    await page.getByRole('link', { name: 'Main site', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(
      'Wait for the current staff operation',
    );
    release();
    await expect(page.getByRole('status')).toContainText('Scheduling enabled.');
    await page.getByRole('link', { name: 'Main site', exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    expect(writes).toBe(1);
  } finally {
    release();
  }
});

test('public admin entry remains available when public settings cannot load', async ({
  page,
}) => {
  await mockApi(page);
  await page.route('**/api/v1/settings', (route) =>
    route.fulfill({ status: 503 }),
  );
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Hardcore worlds', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('link', { name: 'Admin panel', exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(
    page.getByRole('link', { name: 'Main site', exact: true }),
  ).toBeVisible();
});
