import { mockApi } from './mock-api.ts';
import { expect, test, pngFile } from './test.ts';
import { resolve } from 'node:path';
import { adminFixtures } from './admin-fixtures.ts';

test('saving the clan name updates branding and a manual PNG can be reviewed', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto('/admin/settings');
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
    .setInputFiles(await pngFile(resolve('public/skills/sailing.png')));
  await form.getByLabel('Approve immediately').uncheck();
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
  await expect(form.getByLabel('Approve immediately')).toBeChecked();
  await expect(
    form.getByLabel('Collected on hardcore worlds', { exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .locator('.submission-card')
      .getByAltText('Submission screenshot')
      .first(),
  ).toBeVisible();
  const review = page.getByRole('button', { name: /^Review PNG Collector/ });
  await review.scrollIntoViewIfNeeded();
  const scroll = await page.evaluate(() => window.scrollY);
  await review.click();
  const dialog = page.getByRole('dialog', { name: 'Submission review' });
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(scroll);
  const box = await dialog.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(850);
  await expect(dialog.getByRole('heading', { level: 2 })).toContainText(
    'PNG Collector',
  );
  await expect(dialog.getByText(/Version .*saved revision/)).toBeVisible();
  await expect(
    page.locator('.submission-editor').getByAltText('Submission screenshot'),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(
    page.locator('.submission-editor').getByAltText('Submission screenshot'),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
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
  await expect(page.locator('.submission-card .submission-facts')).toHaveCount(
    0,
  );
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

for (const screenshot of [false, true]) {
  test(`RuneLite full chat proof is safe, readable and sufficient for review, screenshot=${screenshot}`, async ({
    page,
  }) => {
    const f = await adminFixtures();
    const chatMessage =
      '  Collector received <img src="https://example.org/tracker">: Rare item & 100 coins.\nFull original message 😀  ';
    const path =
      '/api/v1/admin/submission-images/00000000-0000-4000-8000-000000000001.png';
    const row = {
      ...f.detail.submission,
      source: 'runelite',
      proofUrl: '',
      chatMessage,
      screenshotPath: screenshot ? path : null,
      status: 'pending',
      hardcore: false,
    };
    let approved = false;
    await page.route('**/api/v1/**', async (route) => {
      const url = new URL(route.request().url()).pathname;
      if (url === '/api/v1/admin/submissions/' + row.id + '/approve') {
        expect(route.request().postDataJSON().expectedVersion).toBe(
          row.version,
        );
        approved = true;
        row.status = 'approved';
        row.version++;
        return route.fulfill({ json: row });
      }
      if (url === path)
        return route.fulfill({
          path: resolve('public/skills/sailing.png'),
          contentType: 'image/png',
        });
      const responses: Record<string, unknown> = {
        '/api/v1/auth/session': { ...f.session, role: 'moderator' },
        '/api/v1/settings': {
          revision: 'settings-1',
          clanName: 'Clan name',
          hardcoreEnabled: false,
        },
        '/api/v1/admin/catalog': f.catalog,
        '/api/v1/admin/submissions': {
          ...f.pending,
          submissions: row.status === 'pending' ? [row] : [],
        },
        ['/api/v1/admin/submissions/' + row.id]: {
          ...f.detail,
          submission: row,
          audit: [],
        },
      };
      return route.fulfill({
        status: url in responses ? 200 : 404,
        json: responses[url] ?? {},
      });
    });
    await page.goto('/admin');
    await page.getByRole('button', { name: /^Review / }).click();
    const editor = page.locator('.submission-editor');
    const message = editor.locator('.submission-chat-proof p');
    await expect(message).toBeVisible();
    expect(await message.textContent()).toBe(chatMessage);
    await expect(message).toHaveCSS('white-space', 'pre-wrap');
    await expect(message.locator('img,a,script')).toHaveCount(0);
    await expect(editor.getByAltText('Submission screenshot')).toHaveCount(
      screenshot ? 1 : 0,
    );
    await editor.getByLabel(/^I checked the chat message/).check();
    await expect(
      editor.getByRole('button', { name: 'Approve submission', exact: true }),
    ).toBeEnabled();
    await page.setViewportSize({ width: 320, height: 800 });
    await expect(message).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(320);
    await editor
      .getByRole('button', { name: 'Approve submission', exact: true })
      .click();
    await expect.poll(() => approved).toBe(true);
  });
}
