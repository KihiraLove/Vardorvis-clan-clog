import { expect, test, type Page } from '@playwright/test';
import { competition, importPreview, publicXp } from './xp-fixtures.ts';
import { skills, zeroTotals } from '../src/xp-model.ts';

const attack = (page: Page) => page.getByRole('button', { name: /^Attack:/ });
const skillGroup = (page: Page) =>
  page.getByRole('group', { name: 'Select a skill' });
const sampleLink = 'https://wiseoldman.net/competitions/1001';

async function mockPublic(page: Page) {
  await page.route('**/api/v1/xp/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const data = publicXp()[path];
    return route.fulfill({ status: data ? 200 : 404, json: data ?? {} });
  });
}

test('skill tab has all 24 local icons, millions, exact hover/focus XP and searchable competitors', async ({
  page,
}) => {
  await page.goto('/xp?preview=1');
  await expect(skillGroup(page).getByRole('button')).toHaveCount(24);
  for (const [, name] of skills)
    await expect(
      page.getByRole('button', { name: name + ': 0 XP', exact: true }),
    ).toContainText('0.00m');
  await expect
    .poll(() =>
      page
        .locator('.skill-cell img')
        .evaluateAll((images) =>
          images.every(
            (image) =>
              (image as HTMLImageElement).complete &&
              (image as HTMLImageElement).naturalWidth > 0,
          ),
        ),
    )
    .toBe(true);
  const columns = await page
    .locator('.skill-grid')
    .evaluate(
      (element) =>
        getComputedStyle(element).gridTemplateColumns.split(' ').length,
    );
  expect(columns).toBe(3);
  await page.getByRole('button', { name: 'Show sample XP' }).click();
  await expect(attack(page)).toContainText('18.34m');
  await attack(page).hover();
  await expect(page.getByRole('tooltip')).toContainText('18,345,678 XP');
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath('xp-desktop.png'),
    fullPage: true,
  });
  await attack(page).focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: /^Hitpoints:/ })).toBeFocused();
  await expect(page.getByRole('tooltip')).toContainText('0 XP');
  const members = page.getByRole('table', {
    name: 'Attack cumulative member XP',
  });
  await expect(members.getByRole('row')).toHaveCount(5);
  await expect(members.getByRole('row', { name: /Iron Fern/ })).toContainText(
    '0.00m',
  );
  await expect(members.getByRole('row', { name: /New recruit/ })).toContainText(
    'Unavailable',
  );
  await page.getByLabel('Search members', { exact: true }).fill('kihira');
  await expect(members.getByRole('row')).toHaveCount(2);
  await expect(members.getByRole('row', { name: /KihiraVD/ })).toContainText(
    '12.34m',
  );
  await page.getByLabel('Search competitors', { exact: true }).fill('iron');
  await expect(
    page
      .getByRole('table', { name: 'Vardorvis Attack week competition gains' })
      .getByRole('row', { name: /Iron Fern/ }),
  ).toContainText('0 XP');
});

test('touch selects skills and exact tooltips fit a 320px viewport', async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 320, height: 740 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto('/xp?preview=1');
  await page.getByRole('button', { name: 'Show sample XP' }).tap();
  const sailing = page.getByRole('button', { name: /^Sailing:/ });
  await expect(sailing).toContainText('7.50m');
  await sailing.tap();
  await expect(sailing).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('heading', { name: 'Sailing', exact: true }),
  ).toBeVisible();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toContainText('7,500,000 XP');
  const box = (await tooltip.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(740);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await page.screenshot({
    path: test.info().outputPath('xp-mobile-tooltip.png'),
  });
  await page.getByRole('heading', { name: 'XP gained', exact: true }).tap();
  await expect(tooltip).toHaveCount(0);
  await page.evaluate(async () => {
    window.scrollTo(0, 0);
    await document.fonts.ready;
  });
  await page.screenshot({
    path: test.info().outputPath('xp-mobile.png'),
    fullPage: true,
  });
  await context.close();
});

test('admin preview/apply, unchanged refresh, incremental gains and multi-skill import update the same tracker', async ({
  page,
}) => {
  await page.goto('/xp?preview=1');
  await expect(attack(page)).toContainText('0.00m');
  await page
    .getByRole('link', { name: 'Admin: import or refresh a competition' })
    .click();
  await expect(page).toHaveURL(/\/admin\/xp\?preview=1$/);
  const url = page.getByLabel('Wise Old Man competition link');
  const previewButton = page.getByRole('button', {
    name: 'Preview competition',
    exact: true,
  });
  const apply = page.getByRole('button', {
    name: 'Apply import',
    exact: true,
  });
  await url.fill(sampleLink);
  await previewButton.click();
  const preview = page.locator('.xp-import-preview');
  await expect(
    preview.getByRole('table', { name: 'Change to cumulative site totals' }),
  ).toContainText('+18,345,678');
  await expect(
    preview
      .getByRole('table', { name: 'Vardorvis Attack week competition gains' })
      .getByRole('row'),
  ).toHaveCount(5);
  await expect(attack(page)).toContainText('0.00m');
  await apply.click();
  await expect(attack(page)).toContainText('18.34m');
  await previewButton.click();
  await expect(
    preview.getByRole('table', { name: 'Change to cumulative site totals' }),
  ).toContainText('18,345,678');
  await apply.click();
  await expect(page.getByRole('status')).toContainText(
    'Unchanged — no XP was added.',
  );
  await expect(attack(page)).toContainText('18.34m');
  await page
    .getByRole('button', { name: 'Advance sample Attack results' })
    .click();
  await previewButton.click();
  await expect(
    preview.getByRole('table', { name: 'Change to cumulative site totals' }),
  ).toContainText('+1,250,000');
  await apply.click();
  await expect(attack(page)).toContainText('19.59m');
  await url.fill('https://wiseoldman.net/competitions/1002');
  await previewButton.click();
  await expect(
    preview.getByRole('table', { name: 'Change to cumulative site totals' }),
  ).toContainText('Sailing');
  await apply.click();
  await expect(page.getByRole('button', { name: /^Sailing:/ })).toContainText(
    '7.50m',
  );
  await page.getByText('Import history (4)', { exact: true }).click();
  await expect(page.locator('.xp-history li')).toHaveCount(4);
  await page.evaluate(async () => {
    window.scrollTo(0, 0);
    await document.fonts.ready;
  });
  await page.screenshot({
    path: test.info().outputPath('xp-admin.png'),
    fullPage: true,
  });
  await page.getByRole('link', { name: 'XP gained', exact: true }).click();
  await expect(attack(page)).toContainText('19.59m');
  await page.getByRole('link', { name: 'Collection log', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(5);
  await page.getByRole('link', { name: 'XP gained', exact: true }).click();
  await expect(attack(page)).toContainText('19.59m');
});

test('live failures and mixed revisions retain the last snapshot, and large XP remains exact', async ({
  page,
}) => {
  let status = 503,
    revision = 'xp-one',
    total = '18345678',
    inconsistent = false;
  let conditionals = 0;
  await page.route('**/api/v1/xp/**', (route) => {
    if (route.request().headers()['if-none-match']) conditionals++;
    const path = new URL(route.request().url()).pathname;
    const data = publicXp(
      total,
      inconsistent && path.endsWith('/competitions') ? 'mixed' : revision,
    )[path];
    return route.fulfill({
      status,
      json: status === 200 ? data : {},
      headers: { ETag: revision },
    });
  });
  await page.goto('/xp');
  await expect(page.getByRole('alert')).toContainText('XP tracker unavailable');
  await expect(attack(page)).toContainText('—');
  await expect(
    page.getByRole('button', { name: 'Show sample XP' }),
  ).toHaveCount(0);
  status = 200;
  await page.getByRole('button', { name: 'Retry XP' }).click();
  await expect(attack(page)).toContainText('18.34m');
  status = 503;
  await page.getByRole('button', { name: 'Refresh XP', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Showing the last successful update',
  );
  await expect(attack(page)).toContainText('18.34m');
  status = 200;
  inconsistent = true;
  await page.getByRole('button', { name: 'Retry XP' }).click();
  await expect(page.getByRole('alert')).toContainText('XP refresh failed');
  await expect(attack(page)).toContainText('18.34m');
  inconsistent = false;
  revision = 'xp-two';
  total = '9007199254740993';
  await page.getByRole('button', { name: 'Retry XP' }).click();
  await expect(attack(page)).toContainText('9,007,199,254.74m');
  await attack(page).hover();
  await expect(page.getByRole('tooltip')).toContainText(
    '9,007,199,254,740,993 XP',
  );
  expect(conditionals).toBeGreaterThan(0);
});

test('non-admin cannot import, and live empty data is zero while changing modes cannot carry sample XP into live', async ({
  page,
}) => {
  let posts = 0,
    unavailable = false;
  await page.route('**/api/v1/**', (route) => {
    if (route.request().method() === 'POST') posts++;
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/auth/session') return route.fulfill({ status: 401 });
    const revision = 'empty';
    const data = path.endsWith('/skills')
      ? {
          revision,
          updatedAt: null,
          skills: Object.entries(zeroTotals()).map(([skill, xp]) => ({
            skill,
            xp,
          })),
        }
      : path.endsWith('/competitions')
        ? { revision, competitions: [] }
        : { revision, skill: 'attack', members: [] };
    return route.fulfill({ status: unavailable ? 503 : 200, json: data });
  });
  await page.goto('/admin/xp');
  await expect(
    page.getByRole('heading', { name: 'Admin sign-in required' }),
  ).toBeVisible();
  await expect(page.getByLabel('Wise Old Man competition link')).toHaveCount(0);
  await expect(attack(page)).toContainText('0.00m');
  expect(posts).toBe(0);
  await page.goto('/xp?preview=1');
  await page.getByRole('button', { name: 'Show sample XP' }).click();
  await expect(attack(page)).toContainText('18.34m');
  unavailable = true;
  await page.getByRole('button', { name: 'View live XP', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('XP tracker unavailable');
  await expect(attack(page)).toContainText('—');
  await expect(
    page.getByRole('button', { name: 'Show sample XP' }),
  ).toHaveCount(0);
});

test('authenticated imports reject invalid links, require correction acknowledgment, handle conflict and send CSRF/idempotency', async ({
  page,
}) => {
  await mockPublic(page);
  const posts: { path: string; body: unknown; csrf?: string; key?: string }[] =
    [];
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        displayName: 'KihiraVD',
        csrfToken: 'session-csrf',
      },
    }),
  );
  await page.route('**/api/v1/admin/xp/imports**', (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({ json: { imports: [] } });
    const request = route.request(),
      path = new URL(request.url()).pathname;
    posts.push({
      path,
      body: request.postDataJSON(),
      csrf: request.headers()['x-csrf-token'],
      key: request.headers()['idempotency-key'],
    });
    return path.endsWith('/preview')
      ? route.fulfill({
          json: {
            ...importPreview,
            changes: [
              {
                skill: 'attack',
                before: '18345678',
                after: '17345678',
                change: '-1000000',
              },
            ],
          },
        })
      : route.fulfill({
          status: 409,
          json: { error: { code: 'STALE_PREVIEW' } },
        });
  });
  await page.goto('/admin/xp');
  const input = page.getByLabel('Wise Old Man competition link');
  await input.fill('https://example.com/competitions/1001');
  await page
    .getByRole('button', { name: 'Preview competition', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'Use https://wiseoldman.net',
  );
  expect(posts).toHaveLength(0);
  await input.fill(competition.sourceUrl);
  await page
    .getByRole('button', { name: 'Preview competition', exact: true })
    .click();
  const apply = page.getByRole('button', {
    name: 'Apply import',
    exact: true,
  });
  await expect(apply).toBeDisabled();
  await page.getByRole('checkbox').check();
  await apply.click();
  await expect(page.getByRole('alert')).toContainText('out of date');
  await expect(page.locator('.xp-import-preview')).toHaveCount(0);
  expect(posts).toHaveLength(2);
  expect(posts.every((p) => p.csrf === 'session-csrf')).toBe(true);
  expect(posts[1]!.key).toBeTruthy();
  expect(posts[1]!.body).toEqual({
    previewToken: 'validated-token',
    expectedRevision: 'xp-one',
  });
  await expect(attack(page)).toContainText('18.34m');
});
