/** World identity must not change the shared shell, log surfaces or page backdrop. */
import sharp from 'sharp';
import { defaultSiteCopy } from '@clog/domain';
import { expect, test, type Page } from './test.ts';
import { mockApi } from './mock-api.ts';

async function shell(page: Page) {
  return page.evaluate(() => {
    const geometry = (selector: string) => {
      const box = document.querySelector(selector)!.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    };
    const style = getComputedStyle(document.querySelector('.site-shell')!);
    return {
      header: geometry('.site-header'),
      navigation: geometry('.public-navigation-bar'),
      headingTop: geometry('[data-page-heading]').y,
      padding: style.padding,
      width: style.width,
    };
  });
}

async function logSurfaces(page: Page) {
  return page.evaluate(() =>
    [
      '.log-help',
      '.game-window',
      '.game-body',
      '.game-content',
      '.page-heading',
      '.page-list button',
      '.game-tabs button[aria-selected="true"]',
    ].map((selector) => {
      const node = document.querySelector(selector)!;
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        selector,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        background: style.background,
        border: style.border,
        padding: style.padding,
        gap: style.gap,
        font: style.font,
      };
    }),
  );
}

async function backdrop(page: Page, name: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.scrollTo(0, 0);
  });
  const nav = (await page.locator('.public-navigation-bar').boundingBox())!;
  const screenshot = await page.screenshot({
    path: test.info().outputPath(name + '.png'),
  });
  // The gap between the centered navigation buttons exposes the page gradient
  // at identical viewport coordinates, even when the pair is hidden in hardcore.
  return Array.from(
    await sharp(screenshot)
      .extract({
        left: Math.floor(nav.x + nav.width / 2) - 1,
        top: Math.floor(nav.y + nav.height / 2),
        width: 2,
        height: 2,
      })
      .removeAlpha()
      .raw()
      .toBuffer(),
  );
}

for (const viewport of [
  { width: 1440, height: 810 },
  { width: 740, height: 900 },
  { width: 320, height: 850 },
]) {
  test(
    'normal, hardcore and XP share stable surfaces and backdrop at ' +
      viewport.width,
    async ({ page }) => {
      await page.setViewportSize(viewport);
      const { admin } = await mockApi(page, {
        scenario: 'hardcore',
        xpSamples: true,
      });
      const signal = new AbortController().signal;
      const settings = await admin.settings(signal);
      await admin.saveSettings(
        true,
        settings.revision,
        'test-admin',
        signal,
        'Example clan',
        defaultSiteCopy,
        {
          clanName: 'Hardcore clan',
          copy: {
            ...defaultSiteCopy,
            collectionCaption: 'Our hardcore collections',
          },
        },
      );
      await page.goto('/');
      await expect(page.locator('.page-heading h3')).toHaveText('Vardorvis');
      const normalBackdrop = await backdrop(page, 'normal-' + viewport.width);
      const normalShell = await shell(page);
      const normalLog = await logSurfaces(page);
      const skull = page.getByRole('button', {
        name: 'Hardcore worlds',
        exact: true,
      });
      await skull.click();
      await expect(skull).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.clan-name')).toHaveText('Hardcore clan');
      await expect(page.locator('.log-help')).toHaveText(
        'Our hardcore collections Hardcore worlds',
      );
      expect(await backdrop(page, 'hardcore-' + viewport.width)).toEqual(
        normalBackdrop,
      );
      expect(await shell(page)).toEqual(normalShell);
      expect(await logSurfaces(page)).toEqual(normalLog);
      const hcItem = page.getByRole('button', {
        name: 'Virtus mask: collected, hardcore',
        exact: true,
      });
      await expect(hcItem).not.toHaveClass(/item-slot--event/);
      await expect(hcItem.locator('img')).toHaveCSS(
        'filter',
        /hardcore-outline/,
      );
      await hcItem.click();
      await expect(page.getByRole('tooltip')).toHaveClass(
        /item-menu--hardcore/,
      );
      await expect(
        page.getByRole('tooltip').locator('.item-menu__regular p'),
      ).toHaveText('Collected by KihiraVD on 05/10/26');
      await expect(page.locator('.item-menu__event')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await skull.click();
      await page.getByRole('link', { name: 'Xp tracker', exact: true }).click();
      await expect(page.locator('#xp-tracker')).toBeVisible();
      expect(await backdrop(page, 'xp-' + viewport.width)).toEqual(
        normalBackdrop,
      );
      expect(await shell(page)).toEqual(normalShell);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    },
  );
}
