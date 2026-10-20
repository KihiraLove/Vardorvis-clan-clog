/** Fixture icons are intercepted by tests and never copied to the public site. */
import { test as base, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { basename } from 'node:path';
export * from '@playwright/test';

export async function itemAssets(page: Page) {
  await page.route('**/fixture-items/*.webp', (route) => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1)!;
    if (!/^\d+\.webp$/.test(name)) return route.abort();
    return route.fulfill({
      path: fileURLToPath(new URL('./support/items/' + name, import.meta.url)),
      contentType: 'image/webp',
    });
  });
}
export const test = base.extend({
  page: async ({ page }, use) => {
    await itemAssets(page);
    await use(page);
  },
});

/** In-memory bytes keep intercepted multipart requests complete in Chromium. */
export async function pngFile(path: string) {
  return {
    name: basename(path).replace(/\.webp$/u, '.png'),
    mimeType: 'image/png',
    buffer: await sharp(path).png().toBuffer(),
  };
}
