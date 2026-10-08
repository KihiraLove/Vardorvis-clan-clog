/** Preview/mocked browser review flows; these do not verify real backend authorization. */
import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { adminFixtures } from './admin-fixtures.ts';
import type { AdminCatalog, SubmissionDetail } from '../src/admin-model.ts';

const editor = (page: Page) => page.locator('.submission-editor');
const proofCheck = (page: Page) =>
  editor(page).getByLabel(/^I checked the linked proof/);
const review = (page: Page, collector: string) =>
  page.getByRole('button', { name: new RegExp('^Review ' + collector + ' ·') });
const itemIcon = resolve('public/skills/sailing.png');

async function approve(page: Page, collector: string) {
  await review(page, collector).click();
  await proofCheck(page).check();
  await editor(page)
    .getByRole('button', { name: 'Approve submission', exact: true })
    .click();
  await expect(
    page.getByText('Saved submission state: approved.', { exact: true }),
  ).toBeVisible();
}
async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: test.info().outputPath(name), fullPage: true });
}
async function mockAdmin(page: Page) {
  const f = await adminFixtures();
  const state: {
    catalog: AdminCatalog;
    detail: SubmissionDetail;
    authenticated: boolean;
    privateReads: number;
  } = {
    catalog: structuredClone(f.catalog),
    detail: structuredClone(f.detail),
    authenticated: true,
    privateReads: 0,
  };
  await page.route('**/api/v1/**', (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/api/v1/auth/session')
      return route.fulfill({
        json: state.authenticated ? f.session : { authenticated: false },
      });
    if (path.startsWith('/api/v1/admin/')) state.privateReads++;
    if (path === '/api/v1/admin/catalog')
      return route.fulfill({ json: state.catalog });
    if (path === '/api/v1/admin/submissions') {
      const row = state.detail.submission;
      const visible =
        url.searchParams.get('status') === 'reviewed'
          ? row.status !== 'pending'
          : row.status === 'pending' &&
            (url.searchParams.get('unmatched') !== 'true' ||
              row.itemId === null);
      return route.fulfill({
        json: {
          revision: 'queue-' + row.version,
          submissions: visible ? [row] : [],
          nextCursor: null,
        },
      });
    }
    if (
      path === '/api/v1/admin/submissions/sample-hardcore' &&
      route.request().method() === 'GET'
    )
      return route.fulfill({ json: state.detail });
    return route.fulfill({ status: 404, json: {} });
  });
  return state;
}

test('paged unmatched review saves a specific shared item, approves hardcore credit and revokes it with an audit reason', async ({
  page,
}) => {
  const f = await adminFixtures(),
    maskId = f.detail.submission.itemId!;
  await page.goto('/admin?preview=1');
  await page.getByLabel('Enable hardcore worlds', { exact: true }).check();
  await page.getByRole('button', { name: 'Save site settings' }).click();
  await expect(page.getByText('Hardcore visibility saved.')).toBeVisible();
  await expect(page.locator('.submission-card')).toHaveCount(2);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await review(page, 'Iron Fern').click();
  await expect(
    editor(page).getByRole('button', {
      name: 'Approve submission',
      exact: true,
    }),
  ).toBeDisabled();
  await editor(page).getByLabel('Search catalog items').fill('Virtus mask');
  await editor(page)
    .getByLabel('Canonical item', { exact: true })
    .selectOption(String(maskId));
  await editor(page)
    .getByLabel('Collector name', { exact: true })
    .fill('Matched collector');
  await editor(page)
    .getByLabel('Collection date', { exact: true })
    .fill('2026-10-04');
  await editor(page)
    .getByLabel('Collected on hardcore worlds', { exact: true })
    .check();
  await expect(proofCheck(page)).toBeDisabled();
  await editor(page)
    .getByRole('button', { name: 'Save corrections', exact: true })
    .click();
  await expect(
    editor(page).getByLabel('Collector name', { exact: true }),
  ).toHaveValue('Matched collector');
  await expect(page.getByText('Page 1', { exact: true })).toBeVisible();
  await proofCheck(page).check();
  const link = editor(page).getByRole('link', { name: /^Open proof on / });
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(link).toHaveAttribute('referrerpolicy', 'no-referrer');
  await capture(page, 'admin-review-desktop.png');
  await editor(page)
    .getByRole('button', { name: 'Approve submission', exact: true })
    .click();
  await expect(
    page.getByText('Saved submission state: approved.', { exact: true }),
  ).toBeVisible();
  await editor(page)
    .getByText(/^Audit history/)
    .click();
  await expect(
    editor(page).getByText('approve · Preview admin', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('link', { name: 'Vardorvis clan collection log', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Hardcore worlds', exact: true })
    .click();
  await page
    .getByRole('button', {
      name: 'Virtus mask: collected, hardcore',
      exact: true,
    })
    .hover();
  await expect(page.getByRole('tooltip')).toContainText(
    'Collected by Matched collector on 04/10/26 on hardcore worlds',
  );
  await page
    .getByRole('button', { name: 'Duke Sucellus', exact: true })
    .click();
  await expect(
    page.getByRole('button', {
      name: 'Virtus mask: collected, hardcore',
      exact: true,
    }),
  ).toBeVisible();
  await page.goBack();
  if (page.url().includes('/admin/catalog'))
    await page.getByRole('link', { name: 'Submissions', exact: true }).click();
  await page.getByRole('button', { name: 'Reviewed', exact: true }).click();
  await review(page, 'Matched collector').click();
  await editor(page)
    .getByLabel('Review reason')
    .fill('Evidence withdrawn by collector');
  await editor(page)
    .getByRole('button', { name: 'Revoke credit', exact: true })
    .click();
  await expect(
    page.getByText('Saved submission state: revoked.', { exact: true }),
  ).toBeVisible();
  await editor(page)
    .getByText(/^Audit history/)
    .click();
  await expect(
    editor(page).getByText('Reason: Evidence withdrawn by collector', {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole('link', { name: 'Vardorvis clan collection log', exact: true })
    .click();
  await expect(page.locator('.item-slot--collected')).toHaveCount(0);
});

test('approved corrections require a reason and move the single credit into a free normal slot', async ({
  page,
}) => {
  await page.goto('/admin?preview=1');
  await approve(page, 'KihiraVD');
  await review(page, 'KihiraVD').click();
  await editor(page)
    .getByLabel('Collected on hardcore worlds', { exact: true })
    .uncheck();
  await editor(page)
    .getByRole('button', { name: 'Save corrections', exact: true })
    .click();
  await expect(editor(page).getByRole('alert')).toContainText(
    'Enter a reason for correcting an approved credit.',
  );
  await editor(page)
    .getByLabel('Review reason')
    .fill('Proof was from ordinary worlds');
  await editor(page)
    .getByRole('button', { name: 'Save corrections', exact: true })
    .click();
  await expect(
    editor(page).getByLabel('Collected on hardcore worlds', { exact: true }),
  ).not.toBeChecked();
  await expect(
    editor(page).getByRole('button', { name: 'Save corrections', exact: true }),
  ).toBeDisabled();
  await editor(page)
    .getByText(/^Audit history/)
    .click();
  await expect(
    editor(page).getByText('Reason: Proof was from ordinary worlds', {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole('link', { name: 'Vardorvis clan collection log', exact: true })
    .click();
  await expect(page.locator('.item-slot--hardcore')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Virtus mask: collected', exact: true })
    .hover();
  await expect(page.getByRole('tooltip')).toContainText(
    'Collected by KihiraVD on 05/10/26',
  );
  await expect(page.getByRole('tooltip')).not.toContainText('Oakheart');
});

test('manual item creation shares one identity, keyboard and drag order affect one page, and later review credits every occurrence', async ({
  page,
}) => {
  await page.goto('/admin/catalog?preview=1');
  await page
    .getByLabel('Item icon (required)', { exact: true })
    .setInputFiles(itemIcon);
  await expect(page.getByAltText('New item icon preview')).toBeVisible();
  await page.getByLabel('Item name', { exact: true }).fill('New clan drop');
  for (const name of ['Vardorvis', 'Duke Sucellus'])
    await page
      .locator('.page-picker')
      .getByLabel(name, { exact: true })
      .check();
  await page.getByRole('button', { name: 'Create item', exact: true }).click();
  await expect(page.locator('.item-creator').getByRole('status')).toContainText(
    'created. Every selected page starts uncollected.',
  );
  const rows = page.locator('.page-order-list li');
  await expect(rows.last()).toContainText('New clan drop');
  const id = Number(await rows.last().getAttribute('data-item-id'));
  const count = await rows.count();
  const added = page.locator(`.page-order-list li[data-item-id="${id}"]`);
  await added.focus();
  for (let i = 1; i < count; i++) await added.press('Alt+ArrowUp');
  await expect(rows.first()).toHaveAttribute('data-item-id', String(id));
  await rows.first().dragTo(rows.nth(1));
  await expect(rows.nth(1)).toHaveAttribute('data-item-id', String(id));
  await page
    .getByRole('button', { name: 'Move New clan drop up', exact: true })
    .focus();
  await page.keyboard.press('Enter');
  await expect(rows.first()).toHaveAttribute('data-item-id', String(id));
  await page.getByRole('button', { name: 'Save order', exact: true }).click();
  await expect(page.getByText(/Page order saved\./)).toBeVisible();
  await capture(page, 'admin-catalog-desktop.png');
  await page
    .getByRole('link', { name: 'Vardorvis clan collection log', exact: true })
    .click();
  await expect(page.locator('.item-slot').first()).toHaveAttribute(
    'aria-label',
    'New clan drop: not collected',
  );
  await page
    .getByRole('button', { name: 'Duke Sucellus', exact: true })
    .click();
  await expect(page.locator('.item-slot').last()).toHaveAttribute(
    'aria-label',
    'New clan drop: not collected',
  );
  await page.goBack();
  if (page.url().includes('/admin/catalog'))
    await page.getByRole('link', { name: 'Submissions', exact: true }).click();
  await page.getByRole('button', { name: 'Unmatched', exact: true }).click();
  await review(page, 'Iron Fern').click();
  await editor(page).getByLabel('Search catalog items').fill('New clan drop');
  await editor(page)
    .getByLabel('Canonical item', { exact: true })
    .selectOption(String(id));
  await expect(
    editor(page).getByText(
      new RegExp('Canonical item #' + id + ' · Manual item'),
    ),
  ).toBeVisible();
  await editor(page)
    .getByRole('button', { name: 'Save corrections', exact: true })
    .click();
  await proofCheck(page).check();
  await editor(page)
    .getByRole('button', { name: 'Approve submission', exact: true })
    .click();
  await expect(
    page.getByText('Saved submission state: approved.', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('link', { name: 'Vardorvis clan collection log', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'New clan drop: collected', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: 'Virtus mask: not collected',
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Duke Sucellus', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'New clan drop: collected', exact: true }),
  ).toBeVisible();
});

test('320-pixel touch review and order controls fit without horizontal overflow', async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 320, height: 740 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto('/admin?preview=1');
  await review(page, 'KihiraVD').tap();
  await editor(page)
    .getByLabel('Collector name', { exact: true })
    .fill('Mobile collector');
  await editor(page)
    .getByRole('button', { name: 'Save corrections', exact: true })
    .tap();
  await expect(
    editor(page).getByRole('button', { name: 'Save corrections', exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await capture(page, 'admin-review-mobile.png');
  await page.getByRole('link', { name: 'Catalog items', exact: true }).tap();
  const first = page.locator('.page-order-list li').first();
  const id = await first.getAttribute('data-item-id');
  await first.getByRole('button', { name: / down$/ }).tap();
  await expect(page.locator('.page-order-list li').nth(1)).toHaveAttribute(
    'data-item-id',
    id!,
  );
  await page.getByRole('button', { name: 'Save order', exact: true }).tap();
  await expect(page.getByText(/Page order saved\./)).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await capture(page, 'admin-catalog-mobile.png');
  await context.close();
});

test('anonymous access makes no private reads and forbidden review clears private records', async ({
  page,
}) => {
  const state = await mockAdmin(page);
  state.authenticated = false;
  await page.goto('/admin');
  await expect(
    page.getByLabel('Admin password'),
  ).toBeVisible();
  expect(state.privateReads).toBe(0);
  await expect(page.locator('.submission-card')).toHaveCount(0);
  state.authenticated = true;
  await page.reload();
  await review(page, 'KihiraVD').click();
  await proofCheck(page).check();
  let calls = 0;
  await page.route(
    '**/api/v1/admin/submissions/sample-hardcore/approve',
    (route) => {
      calls++;
      expect(route.request().headers()['x-csrf-token']).toBe('csrf-test');
      expect(route.request().postDataJSON()).toEqual({ expectedVersion: 1 });
      return route.fulfill({
        status: 403,
        json: { error: { message: 'private details must not render' } },
      });
    },
  );
  await editor(page)
    .getByRole('button', { name: 'Approve submission', exact: true })
    .click();
  await expect(
    page.getByLabel('Admin password'),
  ).toBeVisible();
  await expect(
    page.locator('.submission-editor, .submission-card'),
  ).toHaveCount(0);
  await expect(page.getByText('private details must not render')).toHaveCount(
    0,
  );
  expect(calls).toBe(1);
});

test('stale review reloads the latest version and proof must be checked again before an explicit retry', async ({
  page,
}) => {
  const state = await mockAdmin(page);
  let calls = 0;
  await page.route(
    '**/api/v1/admin/submissions/sample-hardcore/approve',
    (route) => {
      calls++;
      expect(route.request().headers()['x-csrf-token']).toBe('csrf-test');
      if (calls === 1) {
        expect(route.request().postDataJSON()).toEqual({ expectedVersion: 1 });
        state.detail.submission = {
          ...state.detail.submission,
          version: 2,
          collectorName: 'Changed by another admin',
        };
        return route.fulfill({ status: 409, json: {} });
      }
      expect(route.request().postDataJSON()).toEqual({ expectedVersion: 2 });
      state.detail.submission = {
        ...state.detail.submission,
        status: 'approved',
        version: 3,
      };
      return route.fulfill({ json: state.detail.submission });
    },
  );
  await page.goto('/admin');
  await review(page, 'KihiraVD').click();
  await proofCheck(page).check();
  await editor(page)
    .getByRole('button', { name: 'Approve submission', exact: true })
    .click();
  await expect(editor(page).getByRole('alert')).toContainText(
    'The latest data is loaded; review it before trying again.',
  );
  await expect(
    editor(page).getByLabel('Collector name', { exact: true }),
  ).toHaveValue('Changed by another admin');
  await expect(proofCheck(page)).not.toBeChecked();
  await expect(
    editor(page).getByRole('button', {
      name: 'Approve submission',
      exact: true,
    }),
  ).toBeDisabled();
  expect(calls).toBe(1);
  await proofCheck(page).check();
  await editor(page)
    .getByRole('button', { name: 'Approve submission', exact: true })
    .click();
  await expect(
    page.getByText('Saved submission state: approved.', { exact: true }),
  ).toBeVisible();
  expect(calls).toBe(2);
});

test('unsafe proof cannot approve but an unmatched or malformed claim can be rejected with a reason', async ({
  page,
}) => {
  const state = await mockAdmin(page);
  state.detail.submission.itemId = null;
  state.detail.submission.proofUrl = 'javascript:alert(1)';
  let calls = 0;
  await page.route(
    '**/api/v1/admin/submissions/sample-hardcore/reject',
    (route) => {
      calls++;
      expect(route.request().postDataJSON()).toEqual({
        expectedVersion: 1,
        reason: 'No usable evidence or exact item',
      });
      state.detail.submission = {
        ...state.detail.submission,
        status: 'rejected',
        version: 2,
      };
      return route.fulfill({ json: state.detail.submission });
    },
  );
  await page.goto('/admin');
  await review(page, 'KihiraVD').click();
  await expect(
    editor(page).getByRole('link', { name: /^Open proof on / }),
  ).toHaveCount(0);
  await expect(proofCheck(page)).toBeDisabled();
  await expect(
    editor(page).getByRole('button', {
      name: 'Approve submission',
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    editor(page).getByRole('button', {
      name: 'Reject submission',
      exact: true,
    }),
  ).toBeDisabled();
  await editor(page)
    .getByLabel('Review reason')
    .fill('No usable evidence or exact item');
  await editor(page)
    .getByRole('button', { name: 'Reject submission', exact: true })
    .click();
  await expect(
    page.getByText('Saved submission state: rejected.', { exact: true }),
  ).toBeVisible();
  expect(calls).toBe(1);
});

test('invalid icons do not upload; an uncertain create retries identical payload/key and a stale order loads current membership', async ({
  page,
}) => {
  const state = await mockAdmin(page);
  let uploads = 0,
    creates = 0,
    orders = 0;
  let firstBody: unknown, firstKey: string | undefined;
  await page.route('**/api/v1/admin/catalog/icons', (route) => {
    uploads++;
    expect(route.request().headers()['x-csrf-token']).toBe('csrf-test');
    expect(route.request().headers()['content-type']).toContain(
      'multipart/form-data; boundary=',
    );
    return route.fulfill({
      json: {
        assetId: 'staged-icon',
        iconPath: '/skills/sailing.png',
        expiresAt: '2099-01-01T00:00:00Z',
      },
    });
  });
  await page.route('**/api/v1/admin/catalog/items', (route) => {
    creates++;
    const body = route.request().postDataJSON(),
      key = route.request().headers()['idempotency-key'];
    expect(route.request().headers()['x-csrf-token']).toBe('csrf-test');
    const item = {
      id: 50001,
      name: 'New live drop',
      iconPath: '/skills/sailing.png',
      origin: 'manual' as const,
      overrides: ['name', 'icon', 'pages'] as ('name' | 'icon' | 'pages')[],
    };
    if (creates === 1) {
      firstBody = body;
      firstKey = key;
      state.catalog.items.push(item);
      const target = state.catalog.pages.find((p) => p.id === 'vardorvis')!;
      target.itemIds.push(item.id);
      target.version = 'page-created';
      state.catalog.revision = 'catalog-created';
      return route.fulfill({ status: 500, json: {} });
    }
    expect(body).toEqual(firstBody);
    expect(key).toBe(firstKey);
    return route.fulfill({
      status: 201,
      json: {
        item,
        pageIds: ['vardorvis'],
        catalogRevision: state.catalog.revision,
      },
    });
  });
  await page.route('**/api/v1/admin/catalog/pages/vardorvis/order', (route) => {
    orders++;
    expect(route.request().postDataJSON().expectedVersion).toBe('page-created');
    const target = state.catalog.pages.find((p) => p.id === 'vardorvis')!;
    target.itemIds.reverse();
    target.version = 'page-concurrent';
    state.catalog.revision = 'catalog-concurrent';
    return route.fulfill({ status: 409, json: {} });
  });
  await page.goto('/admin/catalog');
  await page.getByLabel('Item name', { exact: true }).fill('New live drop');
  await page
    .locator('.page-picker')
    .getByLabel('Vardorvis', { exact: true })
    .check();
  await page.getByLabel('Item icon (required)', { exact: true }).setInputFiles({
    name: 'spoof.png',
    mimeType: 'image/png',
    buffer: Buffer.from('<svg/>'),
  });
  await expect(page.locator('.icon-picker').getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Create item', exact: true }).click();
  await expect(
    page.locator('.item-creator').getByRole('alert').first(),
  ).toContainText('Choose a valid item icon');
  expect(uploads).toBe(0);
  expect(creates).toBe(0);
  await page
    .getByLabel('Item icon (required)', { exact: true })
    .setInputFiles(itemIcon);
  await expect(page.getByAltText('New item icon preview')).toBeVisible();
  await page.getByRole('button', { name: 'Create item', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Retry item save', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Item name', { exact: true })).toBeDisabled();
  await page
    .getByRole('button', { name: 'Retry item save', exact: true })
    .click();
  await expect(page.locator('.admin-created')).toContainText(
    'New live drop · #50001',
  );
  await expect(page.locator('.page-order-list li').last()).toHaveAttribute(
    'data-item-id',
    '50001',
  );
  expect(uploads).toBe(1);
  expect(creates).toBe(2);
  await page
    .locator('.page-order-list li')
    .first()
    .getByRole('button', { name: / down$/ })
    .click();
  await page.getByRole('button', { name: 'Save order', exact: true }).click();
  await expect(
    page.locator('.page-order-editor').getByRole('alert'),
  ).toContainText('The latest data is loaded');
  await expect(page.locator('.page-order-list li').first()).toHaveAttribute(
    'data-item-id',
    '50001',
  );
  await expect(
    page.getByRole('button', { name: 'Save order', exact: true }),
  ).toBeDisabled();
  expect(orders).toBe(1);
});

test('preview logout clears reviews and also denies the XP import form in the same SPA session', async ({
  page,
}) => {
  await page.goto('/admin?preview=1');
  await expect(page.locator('.submission-card')).toHaveCount(2);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(
    page.getByLabel('Admin password'),
  ).toBeVisible();
  await expect(page.locator('.submission-card')).toHaveCount(0);
  await page.getByRole('link', { name: 'XP imports', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Admin sign-in required' }),
  ).toBeVisible();
  await expect(page.getByLabel('Wise Old Man competition link')).toHaveCount(0);
});

test('live local admin session shows test indicator and no Discord sign-out', async ({
  page,
}) => {
  const fixture = await adminFixtures();
  await mockAdmin(page);
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({ json: { ...fixture.session, development: true } }),
  );
  await page.goto('/admin');
  await expect(
    page.getByText(/Local test admin — no Discord login required/),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
  await expect(page.locator('.submission-card')).toHaveCount(1);
});

test('admin preview can add a manual credit without a Discord claim', async ({ page }) => {
  await page.goto('/admin?preview=1');
  await page.getByRole('button', { name: 'Add manual submission' }).click();
  await page.getByLabel('Search catalog items').fill('Virtus mask');
  const catalog = await adminFixtures();
  const maskId = catalog.catalog.items.find((item) => item.name === 'Virtus mask')!.id;
  await page.getByLabel('Canonical item', { exact: true }).selectOption(String(maskId));
  await page.getByLabel('Collector name', { exact: true }).fill('Manual tester');
  await page.getByLabel('Collection date', { exact: true }).fill('2026-10-06');
  await page.getByRole('button', { name: 'Create manual submission' }).click();
  await expect(page.getByText('Manual submission created: approved.')).toBeVisible();
  await expect(page.getByText('Manual tester', { exact: true }).first()).toBeVisible();
});

test('live admin shows a password form and submits a password without Discord OAuth', async ({ page }) => {
  const fixture = await adminFixtures();
  let authenticated = false;
  let submittedPassword = '';
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/auth/session')
      return route.fulfill({ json: authenticated ? fixture.session : { authenticated: false } });
    if (path === '/api/v1/auth/login') {
      submittedPassword = route.request().postDataJSON().password;
      authenticated = true;
      return route.fulfill({ json: { authenticated: true } });
    }
    if (path === '/api/v1/admin/settings')
      return route.fulfill({ json: { revision: 'settings-1', hardcoreEnabled: false } });
    if (path === '/api/v1/admin/catalog')
      return route.fulfill({ json: fixture.catalog });
    if (path === '/api/v1/admin/submissions')
      return route.fulfill({ json: fixture.pending });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto('/admin');
  await expect(page.getByLabel('Admin password')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in with Discord' })).toHaveCount(0);
  await page.getByLabel('Admin password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Submissions' })).toBeVisible();
  expect(submittedPassword).toBe('browser-test-password');
});

test('manual entry reports duplicate item and world rather than a stale-version error', async ({ page }) => {
  await page.goto('/admin?preview=1');
  const add = page.getByRole('button', { name: 'Add manual submission' });
  await add.click();
  await page.getByLabel('Search catalog items').fill('Virtus mask');
  const catalog = await adminFixtures();
  const item = catalog.catalog.items.find((entry) => entry.name === 'Virtus mask')!;
  await page.getByLabel('Canonical item', { exact: true }).selectOption(String(item.id));
  await page.getByLabel('Collector name', { exact: true }).fill('First collector');
  await page.getByLabel('Collection date', { exact: true }).fill('2026-10-06');
  await page.getByRole('button', { name: 'Create manual submission' }).click();
  await expect(page.getByText('Manual submission created: approved.')).toBeVisible();
  await add.click();
  await page.getByLabel('Collector name', { exact: true }).fill('Second collector');
  await page.getByRole('button', { name: 'Create manual submission' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Virtus mask is already collected in ordinary worlds.',
  );
  await expect(page.getByRole('alert')).toContainText('Revoke or edit');
});
