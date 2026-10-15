import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { adminFixtures } from './admin-fixtures.ts';

test('saving the clan name updates branding and a manual PNG can be reviewed in preview', async ({
  page,
}) => {
  await page.goto('/admin/settings?preview=1');
  await page.getByLabel('Clan display name', { exact: true }).fill('New Clan');
  await page.getByRole('button', { name: 'Save site settings' }).click();
  await page.getByRole('link', { name: 'Submissions', exact: true }).click();
  await expect(page.locator('.clan-name')).toHaveText('New Clan');
  await expect(page).toHaveTitle('New Clan · Clan Collection Log');
  await page.getByRole('button', { name: 'Add manual submission' }).click();
  const form = page
    .locator('form')
    .filter({ has: page.getByLabel('Collector name', { exact: true }) });
  await form.getByLabel('Canonical item').selectOption({ index: 1 });
  await form
    .getByLabel('Collector name', { exact: true })
    .fill('PNG Collector');
  await form
    .getByLabel('PNG screenshot (optional)')
    .setInputFiles(resolve('public/skills/sailing.png'));
  await form
    .getByLabel('Approve immediately and show in the collection log')
    .uncheck();
  await form.getByRole('button', { name: 'Create manual submission' }).click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Manual submission created successfully.' }),
  ).toBeVisible();
  expect(
    await form
      .getByLabel('PNG screenshot (optional)')
      .evaluate((input: HTMLInputElement) => input.files?.length),
  ).toBe(0);
  await expect(
    form.getByLabel('Approve immediately and show in the collection log'),
  ).toBeChecked();
  await expect(
    page.getByText('PNG screenshot (preview)').first(),
  ).toBeVisible();
  await page.getByRole('button', { name: /^Review PNG Collector/ }).click();
  await expect(
    page.locator('.submission-editor').getByAltText('Submission screenshot'),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(
    page.locator('.submission-editor').getByAltText('Submission screenshot'),
  ).toBeVisible();
});

test('moderators can review stored RuneLite screenshots without access to clan settings', async ({
  page,
}) => {
  const f = await adminFixtures();
  const path =
    '/api/v1/admin/submission-images/00000000-0000-4000-8000-000000000001.png';
  const row = {
    ...f.detail.submission,
    id: '00000000-0000-4000-8000-000000000002',
    source: 'runelite',
    proofUrl: '',
    screenshotPath: path,
    status: 'pending',
    hardcore: false,
  };
  await page.route('**/api/v1/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === path)
      return route.fulfill({
        path: resolve('public/skills/sailing.png'),
        contentType: 'image/png',
      });
    if (url.pathname === '/api/v1/settings')
      return route.fulfill({
        json: {
          revision: 'settings-1',
          hardcoreEnabled: false,
          clanName: 'New Clan',
        },
      });
    if (url.pathname === '/api/v1/auth/session')
      return route.fulfill({ json: { ...f.session, role: 'moderator' } });
    if (url.pathname === '/api/v1/admin/catalog')
      return route.fulfill({ json: f.catalog });
    if (url.pathname === '/api/v1/admin/submissions/' + row.id)
      return route.fulfill({
        json: { ...f.detail, submission: row, audit: [] },
      });
    if (url.pathname === '/api/v1/admin/submissions')
      return route.fulfill({
        json: {
          revision: 'reviews-fixture',
          submissions: [row],
          pageCursor: 'first-page',
          nextCursor: null,
        },
      });
    return route.fulfill({ status: 404, json: { error: 'Unavailable' } });
  });
  await page.goto('/admin');
  await expect(page.locator('.clan-name')).toHaveText('New Clan');
  await expect(
    page.getByLabel('Clan display name', { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText('RuneLite', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Review / }).click();
  const editor = page.locator('.submission-editor');
  await expect(
    editor.getByRole('link', { name: 'View PNG screenshot' }),
  ).toHaveAttribute('href', path);
  await editor.getByLabel(/^I checked the linked proof/).check();
  await expect(
    editor.getByRole('button', { name: 'Approve submission', exact: true }),
  ).toBeEnabled();
});
