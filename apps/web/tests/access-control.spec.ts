import { expect, test } from './test.ts';
import { mockApi } from './mock-api.ts';
import { adminFixtures } from './admin-fixtures.ts';
import { staffPages, type StaffPage } from '@clog/domain';

for (const width of [1100, 390])
  test(`access control saves moderator page switches explicitly at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 850 });
    const { admin } = await mockApi(page);
    await page.goto('/admin/access-control');
    await expect(
      page.getByRole('heading', { name: 'Access control', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('switch', { name: 'Submissions', exact: true }),
    ).toBeChecked();
    await expect(
      page.getByRole('switch', { name: 'Discord bot', exact: true }),
    ).not.toBeChecked();
    await page
      .getByRole('switch', { name: 'Submissions', exact: true })
      .click();
    await page
      .getByRole('switch', { name: 'Discord bot', exact: true })
      .click();
    expect(
      (await admin.accessControl(new AbortController().signal)).moderatorPages,
    ).toContain('submissions');
    await page
      .getByRole('button', { name: 'Save changes', exact: true })
      .click();
    await expect(
      page.getByText('Access control saved.', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Save changes', exact: true }),
    ).toBeDisabled();
    await page.reload();
    await expect(
      page.getByRole('switch', { name: 'Submissions', exact: true }),
    ).not.toBeChecked();
    await expect(
      page.getByRole('switch', { name: 'Discord bot', exact: true }),
    ).toBeChecked();
    await page
      .getByRole('switch', { name: 'Items catalog', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Discard changes', exact: true })
      .click();
    await expect(
      page.getByRole('switch', { name: 'Items catalog', exact: true }),
    ).toBeChecked();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });

test('access control hides denied pages, revokes open drafts on focus and keeps owner settings read-only', async ({
  page,
}) => {
  await mockApi(page);
  const fixture = await adminFixtures();
  let allowedPages: StaffPage[] = [
    'submissions',
    'catalog',
    'schedules',
    'runelite',
  ];
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      json: { ...fixture.session, role: 'moderator', allowedPages },
    }),
  );
  const privateReads: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/admin/'))
      privateReads.push(request.url());
  });
  await page.goto('/admin/runelite');
  await expect(
    page.getByLabel('In-game clan name for matching', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Access control', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: 'Site settings', exact: true }),
  ).toHaveCount(0);
  await page
    .getByLabel('In-game clan name for matching', { exact: true })
    .fill('Unsaved moderator draft');
  allowedPages = [];
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(
    page.getByText('Your account is not allowed to view this page.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByLabel('In-game clan name for matching', { exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole('navigation', { name: 'Admin navigation' })
      .getByRole('link'),
  ).toHaveText(['Your account']);
  const before = privateReads.length;
  for (const path of ['/admin', '/admin/catalog', '/admin/access-control']) {
    await page.goto(path);
    await expect(page.getByRole('alert')).toBeVisible();
  }
  expect(privateReads.length).toBe(before);
  allowedPages = ['settings', 'hardcore', 'discord'];
  for (const [path, field] of [
    ['/admin/settings', 'Displayed clan name'],
    ['/admin/settings/hardcore', 'Displayed clan name'],
    ['/admin/discord', 'Application ID'],
  ]) {
    await page.goto(path!);
    await expect(page.getByLabel(field!, { exact: true })).toBeDisabled();
    await expect(
      page.getByText(/Only the administrator can change/),
    ).toBeVisible();
    if (path !== '/admin/discord')
      await expect(page.getByLabel('Logo image')).toBeDisabled();
    else {
      await expect(
        page.getByRole('switch', { name: 'Enable Discord bot' }),
      ).toBeDisabled();
      await expect(
        page.getByRole('button', { name: 'Register for main server' }),
      ).toBeDisabled();
    }
  }
  expect(staffPages).toHaveLength(7);
});

test('access control conflicts reload the saved policy without silently retrying the write', async ({
  page,
}) => {
  const { admin } = await mockApi(page);
  await page.goto('/admin/access-control');
  await page
    .getByRole('switch', { name: 'Site settings', exact: true })
    .click();
  const signal = new AbortController().signal;
  await admin.saveAccessControl([], 'access-control-1', 'test-admin', signal);
  let writes = 0;
  await page.route('**/api/v1/admin/access-control', async (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({ json: await admin.accessControl(signal) });
    writes++;
    return route.fulfill({
      status: 409,
      json: { error: 'Access control changed. Reload before saving again.' },
    });
  });
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'The latest data is loaded',
  );
  await expect(
    page.getByRole('switch', { name: 'Submissions', exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole('switch', { name: 'Site settings', exact: true }),
  ).not.toBeChecked();
  expect(writes).toBe(1);
});
