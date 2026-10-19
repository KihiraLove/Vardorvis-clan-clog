import { expect, test, type Page } from './test.ts';
import { mockApi } from './mock-api.ts';
import { defaultSiteCopy } from '@clog/domain';

async function layout(page: Page) {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const box = document.querySelector(selector)!.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    };
    return {
      nav: rect('.public-navigation-bar'),
      caption: rect('.log-help'),
      log: rect('.game-window'),
    };
  });
}

for (const width of [1440, 740, 320]) {
  test(
    'public page buttons are centered equally and hardcore keeps caption/log coordinates at ' +
      width,
    async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      const { admin } = await mockApi(page);
      const signal = new AbortController().signal;
      const settings = await admin.settings(signal);
      await admin.saveSettings(
        true,
        settings.revision,
        'test-admin',
        signal,
        'Clan name',
        { ...defaultSiteCopy, collectionCaption: 'Regular collections' },
        {
          clanName: 'Clan name',
          copy: {
            ...defaultSiteCopy,
            collectionCaption:
              'Hardcore collections earned together over the years',
          },
        },
      );
      let xpReads = 0;
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/v1/xp/tracker') xpReads++;
      });
      await page.goto('/');
      await expect(page.locator('.log-help')).toHaveText('Regular collections');
      await expect(page.locator('.page-heading h3')).toHaveText('Vardorvis');
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      const nav = page.getByRole('navigation', {
        name: 'Public pages',
        exact: true,
      });
      const log = nav.getByRole('link', {
        name: 'Collection log',
        exact: true,
      });
      const xp = nav.getByRole('link', { name: 'Xp tracker', exact: true });
      await expect(log).toHaveAttribute('aria-current', 'page');
      const a = (await log.boundingBox())!,
        b = (await xp.boundingBox())!,
        header = (await page.locator('.site-header').boundingBox())!;
      expect(a.width).toBeCloseTo(b.width, 1);
      expect((a.x + a.width + b.x) / 2).toBeCloseTo(
        header.x + header.width / 2,
        1,
      );
      const normal = await layout(page);
      const skull = page.getByRole('button', {
        name: 'Hardcore worlds',
        exact: true,
      });
      await skull.click();
      await expect(skull).toHaveAttribute('aria-pressed', 'true');
      await expect(page).toHaveURL(/hardcore=1/);
      await expect(nav).toHaveCount(0);
      await expect(page.locator('.public-navigation')).toHaveAttribute(
        'inert',
        '',
      );
      await expect(page.locator('.log-help')).toHaveText(
        'Hardcore collections earned together over the years Hardcore worlds',
      );
      expect(await layout(page)).toEqual(normal);
      await page
        .getByRole('link', { name: 'Admin panel', exact: true })
        .focus();
      await page.keyboard.press('Tab');
      expect(
        await page
          .locator('main')
          .evaluate((node) => node.contains(document.activeElement)),
      ).toBe(true);
      expect(
        await page
          .locator('.public-navigation')
          .evaluate((node) => node.contains(document.activeElement)),
      ).toBe(false);
      expect(xpReads).toBe(0);
      await page.screenshot({
        path: test.info().outputPath('hardcore-navigation-' + width + '.png'),
        fullPage: true,
      });
      await page.reload();
      await expect(skull).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.log-help')).toContainText(
        'Hardcore collections earned together',
      );
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      expect(await layout(page)).toEqual(normal);
      await skull.click();
      await expect(nav).toBeVisible();
      expect(await layout(page)).toEqual(normal);
      await page.screenshot({
        path: test.info().outputPath('public-navigation-' + width + '.png'),
        fullPage: true,
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    },
  );

  test(
    'collection and XP routes preserve page selection, refresh, history, titles and focus at ' +
      width,
    async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await mockApi(page, { xpSamples: true });
      const reads: string[] = [];
      page.on('request', (request) =>
        reads.push(new URL(request.url()).pathname),
      );
      await page.goto('/?page=duke-sucellus');
      await expect(page.locator('.page-heading h3')).toHaveText(
        'Duke Sucellus',
      );
      await expect(page.locator('#xp-tracker')).toHaveCount(0);
      await expect(
        page.getByRole('complementary', {
          name: 'Activity competitions',
          exact: true,
        }),
      ).toBeVisible();
      expect(reads).not.toContain('/api/v1/xp/tracker');
      const xp = page.getByRole('link', { name: 'Xp tracker', exact: true });
      await expect(xp).toHaveAttribute('href', '/xp?page=duke-sucellus');
      await xp.focus();
      await xp.press('Enter');
      await expect(page).toHaveURL(/\/xp\?page=duke-sucellus$/);
      await expect(page.locator('#xp-tracker')).toBeVisible();
      await expect(page.locator('.game-window')).toHaveCount(0);
      await expect(page.locator('.activity-competitions')).toHaveCount(0);
      await expect(page).toHaveTitle('Clan name · ' + defaultSiteCopy.xpTitle);
      await expect(page.locator('#xp-tracker h1')).toBeFocused();
      await expect(
        page.getByLabel('Attack: 18,345,678 XP', { exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: test.info().outputPath('xp-route-' + width + '.png'),
        fullPage: true,
      });
      await expect(xp).toHaveAttribute('aria-current', 'page');
      await expect(page.locator('.skip-link')).toHaveAttribute(
        'href',
        '#xp-main',
      );
      await page.locator('.skip-link').focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('#xp-main')).toBeFocused();
      await page.reload();
      await expect(page.locator('#xp-tracker')).toBeVisible();
      const activityReads = reads.filter(
        (path) => path === '/api/v1/competitions/activities',
      ).length;
      await page.evaluate(() =>
        document.dispatchEvent(new Event('visibilitychange')),
      );
      await expect
        .poll(
          () => reads.filter((path) => path === '/api/v1/xp/tracker').length,
        )
        .toBeGreaterThan(1);
      expect(
        reads.filter((path) => path === '/api/v1/competitions/activities')
          .length,
      ).toBe(activityReads);
      await page
        .getByRole('link', { name: 'Collection log', exact: true })
        .click();
      await expect(page.locator('.page-heading h3')).toHaveText(
        'Duke Sucellus',
      );
      await expect(page).toHaveTitle(
        'Clan name · ' + defaultSiteCopy.collectionTitle,
      );
      await expect(page.locator('.log-help')).toBeFocused();
      await page.getByRole('tab', { name: 'Raids', exact: true }).click();
      await page
        .getByRole('button', { name: 'Tombs of Amascut', exact: true })
        .click();
      await expect(page).toHaveURL(/\?page=tombs-of-amascut$/);
      await expect(
        page.getByRole('button', { name: 'Tombs of Amascut', exact: true }),
      ).toBeFocused();
      await xp.click();
      await expect(page).toHaveURL(/\/xp\?page=tombs-of-amascut$/);
      await page.goBack();
      await expect(page.locator('.page-heading h3')).toHaveText(
        'Tombs of Amascut',
      );
      await page.goBack();
      await expect(page).toHaveURL(/\/xp\?page=duke-sucellus/);
      await page.goBack();
      await expect(page.locator('.page-heading h3')).toHaveText(
        'Duke Sucellus',
      );
      await page.goForward();
      await expect(page.locator('#xp-tracker')).toBeVisible();
      await page
        .getByRole('link', { name: 'Collection log', exact: true })
        .click();
      await page.getByRole('tab', { name: 'Raids', exact: true }).click();
      await expect(page.locator('.page-heading h3')).toHaveText(
        'Tombs of Amascut',
      );
      await page.getByRole('tab', { name: 'Bosses', exact: true }).click();
      await expect(page.locator('.page-heading h3')).toHaveText(
        'Duke Sucellus',
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    },
  );
}

test('hardcore from XP returns to the log and history restores the corresponding world mode', async ({
  page,
}) => {
  const { admin } = await mockApi(page);
  const signal = new AbortController().signal;
  const settings = await admin.settings(signal);
  await admin.saveSettings(true, settings.revision, 'test-admin', signal);
  await page.goto('/xp?page=tombs-of-amascut');
  await expect(page.locator('#xp-tracker')).toBeVisible();
  const skull = page.getByRole('button', {
    name: 'Hardcore worlds',
    exact: true,
  });
  await skull.click();
  await expect(page).toHaveURL(/\/\?page=tombs-of-amascut&hardcore=1$/);
  await expect(page.locator('.page-heading h3')).toHaveText('Tombs of Amascut');
  await expect(page.locator('#xp-tracker')).toHaveCount(0);
  await page.reload();
  await expect(skull).toHaveAttribute('aria-pressed', 'true');
  await page.goBack();
  await expect(page).toHaveURL(/\/xp\?page=tombs-of-amascut$/);
  await expect(skull).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#xp-tracker')).toBeVisible();
  await page.goForward();
  await expect(skull).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.page-heading h3')).toHaveText('Tombs of Amascut');
});

test('direct XP links work with hardcore disabled and stale catalog page links fall back safely', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto('/xp?hardcore=1');
  await expect(page.locator('#xp-tracker')).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Public pages', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Hardcore worlds', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('link', { name: 'Collection log', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/?page=retired-page');
  await expect(page.locator('.page-heading h3')).toHaveText('Vardorvis');
  await page
    .getByRole('button', { name: 'Duke Sucellus', exact: true })
    .click();
  await expect(page).toHaveURL(/\?page=duke-sucellus$/);
});
