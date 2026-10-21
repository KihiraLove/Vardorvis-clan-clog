import { expect, test } from './test.ts';
import { mockApi } from './mock-api.ts';
import sharp from 'sharp';

test.use({ timezoneId: 'Europe/Copenhagen' });

for (const hardcore of [false, true]) {
  for (const failure of [503, 409]) {
    test(`settings Save retains the logo draft and retries only the unsaved upload: hardcore=${hardcore}, failure=${failure}`, async ({
      page,
    }) => {
      await mockApi(page);
      let settingsWrites = 0,
        logoWrites = 0;
      await page.route('**/api/v1/admin/settings', async (route) => {
        if (route.request().method() !== 'GET') settingsWrites++;
        await route.fallback();
      });
      await page.route(
        '**/api/v1/admin/branding' + (hardcore ? '/hardcore' : '') + '/logo',
        async (route) => {
          logoWrites++;
          if (logoWrites === 1)
            return route.fulfill({
              status: failure,
              json: { error: 'Logo save failed.' },
            });
          await route.fallback();
        },
      );
      await page.goto('/admin/settings' + (hardcore ? '/hardcore' : ''));
      const submit = page.getByRole('button', {
        name: hardcore ? 'Save hardcore settings' : 'Save site settings',
        exact: true,
      });
      const input = page.getByLabel('Logo image', { exact: true });
      const preview = page.getByAltText('Current clan logo');
      const buffer = await sharp({
        create: { width: 8, height: 8, channels: 4, background: '#123456' },
      })
        .webp()
        .toBuffer();
      await input.setInputFiles({
        name: 'logo.webp',
        mimeType: 'image/webp',
        buffer,
      });
      await expect(preview).toHaveAttribute('src', /^blob:/);
      await expect(page.locator('header .clan-logo')).toHaveAttribute(
        'src',
        '/brand/clan-logo.webp',
      );
      expect(logoWrites).toBe(0);
      await expect(
        page.getByRole('button', { name: 'Save clan logo', exact: true }),
      ).toHaveCount(0);
      await expect(page.getByText('Logo image', { exact: true })).toHaveCount(
        0,
      );
      await page
        .getByLabel('Displayed clan name', { exact: true })
        .fill('Saved settings with draft logo');
      await submit.click();
      await expect(
        page.getByText(
          'Site settings saved. Logo changes remain unsaved; retry Save to finish.',
        ),
      ).toBeVisible();
      await expect(submit).toBeEnabled();
      expect(settingsWrites).toBe(1);
      expect(logoWrites).toBe(1);
      await expect(preview).toHaveAttribute('src', /^blob:/);
      await submit.click();
      await expect(
        page.getByText(
          hardcore ? 'Hardcore worlds settings saved.' : 'Site settings saved.',
          { exact: true },
        ),
      ).toBeVisible();
      await expect(preview).toHaveAttribute('src', /^\/api\/v1\/branding\//);
      expect(settingsWrites).toBe(1);
      expect(logoWrites).toBe(2);
      const saved = await preview.getAttribute('src');
      await page.reload();
      await expect(preview).toHaveAttribute('src', saved!);
      await expect(
        page.getByLabel('Displayed clan name', { exact: true }),
      ).toHaveValue('Saved settings with draft logo');
      await input.setInputFiles({
        name: 'logo.webp',
        mimeType: 'image/webp',
        buffer,
      });
      await page
        .getByRole('button', { name: 'Discard changes', exact: true })
        .click();
      await expect(preview).toHaveAttribute('src', saved!);
      await expect(submit).toBeDisabled();
      await input.setInputFiles({
        name: 'empty.webp',
        mimeType: 'image/webp',
        buffer: Buffer.alloc(0),
      });
      await expect(page.getByRole('alert')).toContainText(
        'Choose a logo up to 10 MiB.',
      );
      await expect(submit).toBeDisabled();
      await page
        .getByRole('button', { name: 'Discard changes', exact: true })
        .click();
      await page
        .getByRole('button', { name: 'Restore default logo', exact: true })
        .click();
      expect(logoWrites).toBe(2);
      await submit.click();
      await expect(preview).toHaveAttribute('src', '/brand/clan-logo.webp');
      await expect(submit).toBeDisabled();
      expect(logoWrites).toBe(3);
    });
  }
}

test('Activity competitions show a compact range, hide metrics/timezone copy, and wrap after the hyphen', async ({
  page,
}) => {
  await mockApi(page);
  await page.route('**/api/v1/competitions/activities', (route) =>
    route.fulfill({
      json: {
        serverNow: '2026-10-21T12:00:00Z',
        competitions: [
          {
            id: 4444,
            kind: 'ACTIVITY',
            title: 'Autumn competition',
            sourceUrl: 'https://wiseoldman.net/competitions/4444',
            metrics: ['vardorvis'],
            startsAt: '2026-10-21T17:00:00Z',
            endsAt: '2026-10-22T19:00:00Z',
          },
        ],
      },
    }),
  );
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/');
  const panel = page.getByRole('complementary', {
    name: 'Activity competitions',
  });
  const range = panel.locator('.activity-range');
  await expect(range).toHaveText('21/Oct 19:00 - 22/Oct 21:00 +02:00');
  await expect(panel.locator('.competition-metrics')).toHaveCount(0);
  await expect(panel.getByText(/^Times:|^Start:|^End:/)).toHaveCount(0);
  await expect(range.locator('time').first()).toHaveAttribute(
    'title',
    '2026-10-21 17:00:00 UTC',
  );
  const start = range.locator('span'),
    end = range.locator('time').last();
  expect((await start.boundingBox())!.y).toBe((await end.boundingBox())!.y);
  await range.evaluate((element) => (element.style.maxWidth = '160px'));
  expect((await end.boundingBox())!.y).toBeGreaterThan(
    (await start.boundingBox())!.y,
  );
  await expect(start).toHaveText(/ -$/);
  await expect(page.locator('.footer-catalog')).toContainText(
    'App version 1.0.3',
  );
  await expect(page.locator('.footer-catalog a').last()).toHaveText(
    'OSRS Wiki',
  );
});

test('scheduling UTC previews appear only for selected valid dates and disappear when cleared', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto('/admin/schedules');
  await expect(page.locator('.admin-heading .xp-eyebrow')).toHaveCount(0);
  await expect(
    page.getByText(
      /Times use your local timezone:|All selected pages share this window/,
    ),
  ).toHaveCount(0);
  const start = page.getByLabel('Start date and time (local)', { exact: true });
  const end = page.getByLabel('End date and time (local)', { exact: true });
  await expect(page.locator('.schedule-utc')).toHaveCount(0);
  await start.fill('2026-11-02T09:00');
  await expect(page.locator('.schedule-utc')).toHaveText(
    'Start UTC: 2026-11-02 08:00:00 UTC',
  );
  await end.fill('2026-11-02T11:00');
  await expect(page.locator('.schedule-utc')).toHaveCount(2);
  await start.clear();
  await expect(page.locator('.schedule-utc')).toHaveText(
    'End UTC: 2026-11-02 10:00:00 UTC',
  );
  await end.clear();
  await expect(page.locator('.schedule-utc')).toHaveCount(0);
  await page
    .getByRole('switch', { name: 'Collection log scheduling', exact: true })
    .click();
  await expect(
    page.getByText(/Timed windows mark eligible normal-world drops/),
  ).toHaveCount(0);
  await page.goto('/admin/runelite');
  await expect(
    page.getByLabel('Current shared API key', { exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByText('Current shared API key', { exact: true }),
  ).toHaveCount(0);
});
