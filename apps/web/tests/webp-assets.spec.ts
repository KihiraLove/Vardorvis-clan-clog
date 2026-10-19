import { expect, test } from './test.ts';
import { mockApi } from './mock-api.ts';

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
