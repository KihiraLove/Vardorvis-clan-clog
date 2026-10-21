import { mockApi } from './mock-api.ts';
import { expect, test } from './test.ts';
import { skills, zeroTotals } from '../src/xp-model.ts';
import { importPreview } from './xp-fixtures.ts';
import { adminFixtures } from './admin-fixtures.ts';
const tracker = {
  revision: 'one',
  totals: { ...zeroTotals(), attack: '1234567890', fishing: '5000000' },
  events: [
    {
      id: 1001,
      title: 'Attack week',
      sourceUrl: 'https://wiseoldman.net/competitions/1001',
      skills: ['attack'],
      gains: { attack: '1234567890' },
    },
    {
      id: 1002,
      title: 'All-skill weekend',
      sourceUrl: 'https://wiseoldman.net/competitions/1002',
      skills: skills.map(([id]) => id),
      gains: { ...zeroTotals(), fishing: '5000000' },
    },
  ],
};
test('Total and event sidebar display exact event gains and links with four-digit million labels', async ({
  page,
}) => {
  await page.route('**/api/v1/xp/tracker', (route) =>
    route.fulfill({ json: tracker }),
  );
  await page.goto('/xp');
  await expect(
    page
      .getByRole('navigation', { name: 'XP events' })
      .getByRole('button', { name: 'Total', exact: true }),
  ).toHaveAttribute('aria-current', 'true');
  const group = page.getByRole('group', { name: 'Event skill XP' });
  await expect(group.locator('img')).toHaveCount(24);
  const attack = group.getByLabel('Attack: 1,234,567,890 XP', { exact: true });
  await expect(attack).toContainText('1234.56m');
  await attack.hover();
  await expect(page.getByRole('tooltip')).toHaveText('1,234,567,890 XP');
  const fits = await attack
    .locator('.xp-amount__number')
    .evaluate((el) => el.scrollWidth <= el.getBoundingClientRect().width + 1);
  expect(fits).toBe(true);
  await page.getByRole('button', { name: 'Attack week', exact: true }).click();
  await expect(page.locator('.event-source strong')).toHaveCount(0);
  await expect(
    page.locator('.xp-podium > p').filter({ hasText: 'Attack week' }),
  ).toHaveCount(0);
  await expect(
    group.getByLabel('Fishing: 0 XP', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: /View event on Wise Old Man/ }),
  ).toHaveAttribute('href', tracker.events[0]!.sourceUrl);
  await expect(
    page
      .locator('.xp-podium')
      .getByRole('link', { name: /View event on Wise Old Man/ }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'All-skill weekend', exact: true })
    .click();
  await expect(group.getByLabel('Attack: 0 XP', { exact: true })).toBeVisible();
  await expect(
    group.getByLabel('Fishing: 5,000,000 XP', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Total', exact: true }).click();
  await expect(attack).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('event-tracker-desktop.png'),
    fullPage: true,
  });
});
test('event list scrolls while Total stays above it', async ({ page }) => {
  const events = Array.from({ length: 20 }, (_, index) => ({
    ...tracker.events[0],
    id: index + 1,
    title: 'Event ' + (index + 1),
    sourceUrl: 'https://wiseoldman.net/competitions/' + (index + 1),
  }));
  await page.route('**/api/v1/xp/tracker', (route) =>
    route.fulfill({ json: { ...tracker, events } }),
  );
  await page.goto('/xp');
  await expect(
    page.getByRole('button', { name: 'Event 20', exact: true }),
  ).toBeAttached();
  expect(
    await page
      .locator('.event-list')
      .evaluate((el) => el.scrollHeight > el.clientHeight),
  ).toBe(true);
  await page.getByRole('button', { name: 'Event 20', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Total', exact: true }),
  ).toBeVisible();
});
test('touch exact values and skill cells fit at 320px', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 320, height: 850 },
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.route('**/api/v1/xp/tracker', (route) =>
    route.fulfill({ json: tracker }),
  );
  await page.goto('/xp');
  await page.getByLabel('Attack: 1,234,567,890 XP', { exact: true }).tap();
  await expect(page.getByRole('tooltip')).toContainText('1,234,567,890 XP');
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  const box = await page.getByRole('tooltip').boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  await page.screenshot({
    path: test.info().outputPath('event-tracker-mobile.png'),
    fullPage: true,
  });
  await context.close();
});
test('stored results switch by event changes totals without showing member tables', async ({
  page,
}) => {
  await mockApi(page, { xpSamples: true });
  await page.goto('/xp');
  const attack = page.getByLabel('Attack: 18,345,678 XP', { exact: true });
  await expect(attack).toBeVisible();
  await expect(attack).toBeVisible();
  await page
    .getByRole('button', { name: 'Clan skilling weekend', exact: true })
    .click();
  await expect(page.getByLabel('Attack: 0 XP', { exact: true })).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const podium = await page.locator('.xp-podium').boundingBox();
  expect(podium!.width).toBeCloseTo(480, 0);
  await page
    .locator('.event-tracker')
    .screenshot({ path: test.info().outputPath('wide-podium.png') });
  await page
    .locator('.footer-support')
    .screenshot({ path: test.info().outputPath('support-buttons.png') });
});
test('failed or malformed refresh retains the last exact snapshot', async ({
  page,
}) => {
  let fail = false;
  await page.route('**/api/v1/xp/tracker', (route) =>
    fail
      ? route.fulfill({ json: { ...tracker, totals: { attack: 'bad' } } })
      : route.fulfill({ json: tracker }),
  );
  await page.goto('/xp');
  await expect(
    page.getByLabel('Attack: 1,234,567,890 XP', { exact: true }),
  ).toBeVisible();
  fail = true;
  await page.evaluate(() =>
    document.dispatchEvent(new Event('visibilitychange')),
  );
  await expect(
    page.getByRole('alert').filter({ hasText: 'XP could not' }),
  ).toBeVisible();
  await expect(
    page.getByLabel('Attack: 1,234,567,890 XP', { exact: true }),
  ).toBeVisible();
});
test('direct admin imports require access, review corrections and send CSRF plus stable request identity', async ({
  page,
}) => {
  await page.route('**/api/v1/xp/tracker', (route) =>
    route.fulfill({ json: tracker }),
  );
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({ json: { authenticated: false } }),
  );
  await page.goto('/admin/xp');
  await expect(
    page.getByText('Admin sign-in required', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply import' })).toHaveCount(
    0,
  );
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        csrfToken: 'csrf',
        displayName: 'Reviewer',
        username: 'reviewer',
        role: 'admin',
        mustChangePassword: false,
      },
    }),
  );
  await page.route('**/api/v1/admin/xp/imports', (route) =>
    route.fulfill({
      json: {
        imports: [],
        revision: 'xp-history-1',
        pageCursor: 'xp-first',
        nextCursor: null,
      },
    }),
  );
  await page.route('**/api/v1/admin/competitions/preview', (route) =>
    route.fulfill({
      json: {
        ...importPreview,
        competition: {
          ...importPreview.competition,
          kind: 'SKILL',
          metrics: ['attack'],
        },
        lifecycle: 'finished',
        action: 'import-results',
        scheduleRevision: 'schedules-1',
        scheduleStartsAt: null,
        pageIds: [],
        pages: [],
        participants: [
          { playerId: 1, displayName: 'KihiraVD', gains: { attack: '1' } },
        ],
        changes: [
          {
            skill: 'attack',
            before: '18345678',
            after: '1',
            change: '-18345677',
          },
        ],
      },
    }),
  );
  const fixture = await adminFixtures();
  await page.route('**/api/v1/admin/catalog', (route) =>
    route.fulfill({ json: fixture.catalog }),
  );
  await page.route('**/api/v1/admin/schedules', (route) =>
    route.fulfill({
      json: { revision: 'schedules-1', enabled: false, schedules: [] },
    }),
  );
  await page.reload();
  await expect(
    page.getByRole('link', { name: 'XP imports', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('heading', {
      name: 'Track Event collections during scheduled windows',
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByLabel('Wise Old Man competition link')
    .fill('https://wiseoldman.net/competitions/1001');
  await expect(page.getByLabel('Competition kind')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Preview competition', exact: true })
    .click();
  await expect(page.getByText(/Detected kind: SKILL/)).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Apply import' }),
  ).toBeDisabled();
  await page
    .getByLabel('I reviewed the corrections that reduce recorded XP.')
    .check();
  await page.route('**/api/v1/admin/competitions/imports', (route) => {
    if (route.request().method() === 'POST') {
      expect(route.request().headers()['x-csrf-token']).toBe('csrf');
      expect(route.request().headers()['idempotency-key']).toBeTruthy();
      return route.fulfill({ json: { outcome: 'applied', revision: 'two' } });
    }
    return route.fulfill({
      json: {
        imports: [],
        revision: 'xp-history-1',
        pageCursor: 'xp-first',
        nextCursor: null,
      },
    });
  });
  await page.getByRole('button', { name: 'Apply import' }).click();
  await expect(
    page.getByText('Competition imported.', { exact: true }),
  ).toBeVisible();
});
