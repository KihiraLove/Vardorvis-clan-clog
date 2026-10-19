import { mockApi } from './mock-api.ts';
import { expect, test } from './test.ts';
import { adminFixtures } from './admin-fixtures.ts';
import { MemoryAdminClient } from './support/admin.ts';
import { defaultBranding } from '../src/branding.ts';
import type { SchedulingState } from '@clog/domain';
test.use({ timezoneId: 'Europe/Copenhagen', locale: 'en-GB' });

test('admin configures overlapping page schedules in local time, reviews UTC, edits and deletes on mobile', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto('/admin/schedules');
  const enabled = page.getByRole('switch', {
    name: 'Collection log scheduling',
    exact: true,
  });
  await expect(enabled).toBeEnabled();
  await expect(enabled).toHaveAccessibleDescription(
    'Enable scheduled opening windows for log pages (submissions to closed pages are automatically rejected)',
  );
  const management = page.locator('section.admin-panel').filter({
    has: page.getByRole('heading', {
      name: 'Schedule management',
      exact: true,
    }),
  });
  await expect(management).toBeVisible();
  await expect(
    management.getByRole('switch', {
      name: 'Collection log scheduling',
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(enabled).not.toBeChecked();
  await expect(
    page.getByText('Europe/Copenhagen', { exact: true }),
  ).toBeVisible();
  const title = page.getByLabel('Schedule name', { exact: true });
  const start = page.getByLabel('Start date and time (local)', { exact: true });
  const end = page.getByLabel('End date and time (local)', { exact: true });
  const pages = page
    .getByRole('group', { name: 'Collection log pages', exact: true })
    .getByRole('checkbox');
  await title.fill('Boss week');
  await start.fill('2026-11-02T09:00');
  await end.fill('2026-11-02T11:00');
  await expect(
    page.getByText('Start UTC: 2026-11-02 08:00:00 UTC', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('End UTC: 2026-11-02 10:00:00 UTC', { exact: true }),
  ).toBeVisible();
  await pages.nth(0).check();
  await pages.nth(1).check();
  await page
    .getByRole('button', { name: 'Create schedule', exact: true })
    .click();
  await expect(page.getByRole('status')).toHaveText('Schedule created.');
  await expect(page.locator('.schedule-card')).toHaveCount(1);
  await title.fill('Overlap');
  await start.fill('2026-11-02T10:00');
  await end.fill('2026-11-02T12:00');
  await pages.nth(1).check();
  await page
    .getByRole('button', { name: 'Create schedule', exact: true })
    .click();
  await expect(page.locator('.schedule-card')).toHaveCount(2);
  await enabled.click();
  await expect(enabled).toBeChecked();
  await expect(page.getByRole('status')).toHaveText('Scheduling enabled.');
  await page
    .locator('.schedule-card')
    .filter({
      has: page.getByRole('heading', { name: 'Boss week', exact: true }),
    })
    .getByRole('button', { name: 'Edit', exact: true })
    .click();
  await expect(start).toHaveValue('2026-11-02T09:00');
  await expect(pages.nth(0)).toBeChecked();
  await expect(pages.nth(1)).toBeChecked();
  await title.fill('Updated boss week');
  await page
    .getByRole('button', { name: 'Save schedule', exact: true })
    .click();
  await expect(page.getByRole('status')).toHaveText('Schedule updated.');
  await page.setViewportSize({ width: 320, height: 850 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: test.info().outputPath('scheduling-mobile.png'),
    fullPage: true,
  });
  await page
    .locator('.schedule-card')
    .filter({
      has: page.getByRole('heading', { name: 'Overlap', exact: true }),
    })
    .getByRole('button', { name: 'Delete', exact: true })
    .click();
  await expect(
    page.getByRole('dialog', { name: 'Delete schedule' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Keep schedule', exact: true })
    .click();
  await expect(page.locator('.schedule-card')).toHaveCount(2);
  await page
    .locator('.schedule-card')
    .filter({
      has: page.getByRole('heading', { name: 'Overlap', exact: true }),
    })
    .getByRole('button', { name: 'Delete', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Confirm delete schedule', exact: true })
    .click();
  await expect(page.locator('.schedule-card')).toHaveCount(1);
  await enabled.click();
  await expect(page.getByRole('status')).toHaveText('Scheduling disabled.');
  await expect(page.locator('.schedule-card')).toHaveCount(1);
  await page.getByRole('link', { name: 'Submissions', exact: true }).click();
  await page
    .getByRole('link', { name: 'Scheduling and Competitions', exact: true })
    .click();
  await expect(page.locator('.schedule-card')).toHaveCount(1);
  await expect(enabled).not.toBeChecked();
});

test('moderators can create windows but cannot see or write the administrator enable switch', async ({
  page,
}) => {
  const fixture = await adminFixtures();
  const settings = await new MemoryAdminClient().settings(
    new AbortController().signal,
  );
  let state: SchedulingState = {
    revision: 'schedules-1',
    enabled: true,
    schedules: [],
    permanentlyOpenPageIds: [],
  };
  let created = false;
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    expect(path).not.toBe('/api/v1/admin/schedules/settings');
    if (path === '/api/v1/admin/schedules') {
      if (route.request().method() === 'POST') {
        expect(route.request().headers()['x-csrf-token']).toBe('csrf-test');
        const { expectedRevision, ...input } = route.request().postDataJSON();
        expect(expectedRevision).toBe('schedules-1');
        expect(input.startsAt).toBe('2026-10-12T07:00:00.000Z');
        state = {
          ...state,
          revision: 'schedules-2',
          schedules: [{ id: '00000000-0000-4000-8000-000000000001', ...input }],
        };
        created = true;
      }
      await route.fulfill({
        status: route.request().method() === 'POST' ? 201 : 200,
        json: state,
      });
      return;
    }
    const values: Record<string, unknown> = {
      '/api/v1/auth/session': { ...fixture.session, role: 'moderator' },
      '/api/v1/admin/catalog': fixture.catalog,
      '/api/v1/settings': settings,
      '/api/v1/branding': defaultBranding,
      '/api/v1/branding/hardcore': defaultBranding,
    };
    await route.fulfill({
      status: path in values ? 200 : 404,
      json: values[path] ?? {},
    });
  });
  await page.goto('/admin/schedules');
  await expect(page.getByLabel('Schedule name', { exact: true })).toBeEnabled();
  await expect(page.getByRole('switch')).toHaveCount(0);
  await expect(
    page.getByRole('link', {
      name: 'Scheduling and Competitions',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'RuneLite submissions', exact: true }),
  ).toBeVisible();
  await page
    .getByLabel('Schedule name', { exact: true })
    .fill('Moderator window');
  await page
    .getByLabel('Start date and time (local)', { exact: true })
    .fill('2026-10-12T09:00');
  await page
    .getByLabel('End date and time (local)', { exact: true })
    .fill('2026-10-12T11:00');
  await page
    .getByRole('group', { name: 'Collection log pages', exact: true })
    .getByRole('checkbox')
    .first()
    .check();
  await page
    .getByRole('button', { name: 'Create schedule', exact: true })
    .click();
  await expect(page.getByRole('status')).toHaveText('Schedule created.');
  expect(created).toBe(true);
});
