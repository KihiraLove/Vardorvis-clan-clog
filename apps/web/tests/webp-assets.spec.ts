import { expect, test } from './test.ts';
import { mockApi } from './mock-api.ts';

for (const permanentFailure of [false, true]) {
  test(`public item icons ${permanentFailure ? 'bound failures and recover after a path change' : 'recover after a temporary failure'}`, async ({
    page,
  }) => {
    await page.clock.install({ time: new Date('2026-10-20T12:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-20T12:00:01Z'));
    await mockApi(page);
    let iconPath = '/catalog/items/13262.webp';
    await page.route('**/api/v1/catalog', (route) =>
      route.fulfill({
        json: {
          revision: iconPath,
          items: [{ id: 1, name: 'Abyssal orphan', iconPath }],
          pages: [
            {
              id: 'sire',
              name: 'Abyssal Sire',
              category: 'bosses',
              itemIds: [1],
            },
          ],
        },
      }),
    );
    await page.route('**/api/v1/collections', (route) =>
      route.fulfill({ json: { revision: 'empty', credits: [] } }),
    );
    let requests = 0;
    await page.route('**/catalog/items/13262.webp*', (route) => {
      requests++;
      return permanentFailure || requests === 1
        ? route.abort('failed')
        : route.continue();
    });
    await page.goto('/');
    const slot = page.getByRole('button', {
      name: 'Abyssal orphan: not collected',
      exact: true,
    });
    await expect(slot.locator('.icon-missing')).toBeVisible();
    await page.clock.runFor(1001);
    await expect.poll(() => requests).toBe(2);
    if (permanentFailure) {
      await expect(slot.locator('.icon-missing')).toBeVisible();
      await page.clock.runFor(3001);
      await expect.poll(() => requests).toBe(3);
      await expect(slot.locator('.icon-missing')).toBeVisible();
      await page.clock.runFor(10001);
      await expect.poll(() => requests).toBe(4);
      await expect(slot.locator('.icon-missing')).toBeVisible();
      await page.clock.runFor(10000);
      expect(requests).toBe(4);
      iconPath = '/catalog/items/13265.webp';
      await page.clock.runFor(2000);
      await expect(slot.locator('img')).toHaveAttribute('src', iconPath);
    } else {
      await expect(slot.locator('img')).toHaveAttribute(
        'src',
        iconPath + '?retry=1',
      );
    }
    await expect
      .poll(() =>
        slot
          .locator('img')
          .evaluate((node) => (node as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
    await expect(slot.locator('.icon-missing')).toHaveCount(0);
  });
}

for (const width of [1440, 320]) {
  test(
    'WebP icons, branding, favicon and texture render across public views at ' +
      width,
    async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      const { admin } = await mockApi(page, { xpSamples: true });
      const signal = new AbortController().signal;
      const settings = await admin.settings(signal);
      await admin.saveSettings(true, settings.revision, 'test-admin', signal);
      for (const [route, name] of [
        ['/', 'collection'],
        ['/?hardcore=1', 'hardcore'],
        ['/xp', 'xp'],
      ] as const) {
        await page.goto(route);
        await expect(page.locator('.clan-logo').first()).toHaveAttribute(
          'src',
          '/brand/clan-logo.webp',
        );
        await expect(
          page
            .locator(
              route === '/xp' ? 'img[src^="/skills/"]' : '.item-slot img',
            )
            .first(),
        ).toBeVisible();
        await expect
          .poll(() =>
            page
              .locator(
                '.clan-logo, .item-slot img, img[src^="/skills/"], .github-support img',
              )
              .evaluateAll(
                (images) =>
                  images.length > 0 &&
                  images.every(
                    (node) =>
                      (node as HTMLImageElement).complete &&
                      (node as HTMLImageElement).naturalWidth > 0 &&
                      (node as HTMLImageElement).src.endsWith('.webp'),
                  ),
              ),
          )
          .toBe(true);
        await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
          'type',
          'image/webp',
        );
        const assets = await page.evaluate(async () =>
          Promise.all(
            [
              '/favicon.webp',
              '/ui/panel.webp',
              '/brand/skull.webp',
              '/brand/github-mark.webp',
              '/brand/ko-fi-blue.webp',
            ].map(async (path) => {
              const response = await fetch(path);
              return {
                path,
                status: response.status,
                type: response.headers.get('content-type'),
                signature: new TextDecoder().decode(
                  (await response.arrayBuffer()).slice(0, 4),
                ),
              };
            }),
          ),
        );
        for (const asset of assets) {
          expect(asset.status, asset.path).toBe(200);
          expect(asset.type, asset.path).toBe('image/webp');
          expect(asset.signature, asset.path).toBe('RIFF');
        }
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBeLessThanOrEqual(width);
        await page.screenshot({
          path: test.info().outputPath(name + '-webp-' + width + '.png'),
          fullPage: true,
        });
      }
    },
  );
}
