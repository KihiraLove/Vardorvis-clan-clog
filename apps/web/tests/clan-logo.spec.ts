import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { adminFixtures } from './admin-fixtures.ts';

test('admin uploads GIF and animated WebP logos, updates the website icon and restores the default', async ({
  page,
}) => {
  await page.goto('/admin?preview=1');
  const logo = page.locator('.clan-logo').first();
  await expect(logo).toHaveAttribute('src', '/brand/mexicat.gif');
  const webp = await sharp(Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]), {
    raw: { width: 1, height: 2, pageHeight: 1, channels: 4 },
  })
    .webp({ lossless: true, delay: [120, 230] })
    .toBuffer();
  for (const [name, mimeType, buffer] of [
    ['logo.gif', 'image/gif', await readFile('public/brand/mexicat.gif')],
    ['logo.webp', 'image/webp', webp],
  ] as const) {
    await page
      .getByLabel('Logo image', { exact: true })
      .setInputFiles({ name, mimeType, buffer });
    await page
      .getByRole('button', { name: 'Save clan logo', exact: true })
      .click();
    await expect(
      page.getByText('Clan logo and website icon saved.'),
    ).toBeVisible();
    await expect(logo).toHaveAttribute('src', /^blob:/);
    const paths = await page.evaluate(() => ({
      logo: document.querySelector<HTMLImageElement>('.clan-logo')!.src,
      favicon:
        document.querySelector<HTMLLinkElement>('link[rel="icon"]')!.href,
      alternate: document.querySelector<HTMLLinkElement>(
        'link[rel="alternate icon"]',
      )!.href,
    }));
    expect(paths.favicon).toMatch(/^blob:/);
    expect(paths.alternate).toBe(paths.favicon);
    const formats = await page.evaluate(
      async ({ logo, favicon }) => ({
        logo: (await fetch(logo)).headers.get('Content-Type'),
        favicon: (await fetch(favicon)).headers.get('Content-Type'),
      }),
      paths,
    );
    expect(formats).toEqual({ logo: mimeType, favicon: 'image/png' });
  }
  await page.setViewportSize({ width: 320, height: 850 });
  await expect(
    page.getByRole('button', { name: 'Restore default logo' }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page
    .locator('.clan-logo-settings')
    .screenshot({ path: test.info().outputPath('clan-logo-controls.png') });
  await page.getByRole('button', { name: 'Restore default logo' }).click();
  await expect(logo).toHaveAttribute('src', '/brand/mexicat.gif');
  expect(await page.locator('link[rel="icon"]').getAttribute('href')).toBe(
    '/favicon.png',
  );
});

test('live branding changes the public logo and icon; moderator accounts have no logo controls or private branding reads', async ({
  page,
}) => {
  const fixture = await adminFixtures();
  let privateReads = 0;
  const id = '00000000-0000-4000-8000-000000000001';
  const branding = {
    revision: 'branding-2',
    logoPath: `/api/v1/branding/${id}.webp`,
    faviconPath: `/api/v1/branding/${id}/favicon.png`,
  };
  await page.route('**/api/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/branding') return route.fulfill({ json: branding });
    if (path === '/api/v1/admin/branding') privateReads++;
    if (path === '/api/v1/auth/session')
      return route.fulfill({ json: { ...fixture.session, role: 'moderator' } });
    if (path === '/api/v1/settings')
      return route.fulfill({
        json: {
          revision: 'settings-1',
          clanName: 'Vardorvis',
          hardcoreEnabled: false,
        },
      });
    if (path === '/api/v1/admin/catalog')
      return route.fulfill({ json: fixture.catalog });
    if (path === '/api/v1/admin/submissions')
      return route.fulfill({ json: fixture.pending });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto('/admin');
  await expect(page.locator('.clan-logo').first()).toHaveAttribute(
    'src',
    branding.logoPath,
  );
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
    'href',
    branding.faviconPath,
  );
  await expect(
    page.getByRole('heading', { name: 'Submissions', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Logo image', { exact: true })).toHaveCount(0);
  expect(privateReads).toBe(0);
});
