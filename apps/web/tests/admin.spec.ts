import { mockApi } from './mock-api.ts';
/** Mocked HTTP browser review flows; these do not verify real backend authorization. */
import { expect, test, pngFile, type Page } from './test.ts';
import { resolve } from 'node:path';
import { adminFixtures } from './admin-fixtures.ts';
import { defaultBranding } from '../src/branding.ts';
import type { AdminCatalog, SubmissionDetail } from '../src/admin-model.ts';

const editor = (page: Page) => page.locator('.submission-editor');
const proofCheck = (page: Page) =>
  editor(page).getByLabel(/^I checked the linked proof/);
const review = (page: Page, collector: string) =>
  page.getByRole('button', { name: new RegExp('^Review ' + collector + ' ·') });
const itemIcon = resolve('public/skills/sailing.png');
async function closeReviewIfOpen(page: Page) {
  if (await page.getByRole('dialog', { name: 'Submission review' }).count())
    await page
      .getByRole('button', { name: 'Close review', exact: true })
      .click();
}

test('collected-item filtering sits between manual entry and the queue and survives navigation', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto('/admin/submissions');
  const filter = page.getByRole('switch', {
    name: 'Filter out duplicates',
    exact: true,
  });
  await expect(filter).toBeEnabled();
  await expect(filter).not.toBeChecked();
  const manual = await page
    .getByRole('heading', { name: 'Manual submission', exact: true })
    .boundingBox();
  const toggle = await filter.boundingBox();
  const submissions = await page
    .getByRole('heading', { name: 'Submissions', exact: true })
    .boundingBox();
  expect(toggle!.y).toBeGreaterThan(manual!.y);
  expect(toggle!.y).toBeLessThan(submissions!.y);
  await filter.click();
  await expect(filter).toBeChecked();
  await page.getByRole('link', { name: 'Items catalog', exact: true }).click();
  await page.getByRole('link', { name: 'Submissions', exact: true }).click();
  await expect(filter).toBeChecked();
  await filter.click();
  await expect(filter).not.toBeChecked();
});

async function approve(page: Page, collector: string) {
  await review(page, collector).click();
  await proofCheck(page).check();
  await editor(page)
    .getByRole('button', { name: 'Approve submission', exact: true })
    .click();
  await expect(
    page.getByText('Saved submission state: approved.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close review', exact: true }).click();
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
    catalogReads: number;
  } = {
    catalog: structuredClone(f.catalog),
    detail: structuredClone(f.detail),
    authenticated: true,
    privateReads: 0,
    catalogReads: 0,
  };
  await page.route('**/api/v1/**', (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/api/v1/settings')
      return route.fulfill({
        json: {
          revision: 'settings-1',
          clanName: 'Example clan',
          hardcoreEnabled: false,
        },
      });
    if (path === '/api/v1/auth/session')
      return route.fulfill({
        json: state.authenticated ? f.session : { authenticated: false },
      });
    if (path === '/api/v1/branding' || path === '/api/v1/admin/branding')
      return route.fulfill({ json: defaultBranding });
    if (path === '/api/v1/admin/clan-api-key')
      return route.fulfill({
        json: {
          revision: 'clan-key-1',
          enabled: true,
          key: 'a'.repeat(32),
        },
      });
    if (path.startsWith('/api/v1/admin/')) state.privateReads++;
    if (path === '/api/v1/admin/catalog') {
      state.catalogReads++;
      return route.fulfill({ json: state.catalog });
    }
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
          pageCursor: 'first-page',
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

test('unmatched RuneLite review displays submitted provenance before and after canonical resolution', async ({
  page,
}) => {
  const state = await mockAdmin(page);
  Object.assign(state.detail.submission, {
    source: 'runelite',
    itemId: null,
    rawItemText: 'Unlisted rare variant',
    gameItemId: 987654,
    hardcore: false,
    proofUrl: '',
    chatMessage: 'Valuable drop: Unlisted rare variant',
  });
  await page.goto('/admin/submissions');
  const card = page.locator('.submission-card');
  await expect(card).toContainText('Unlisted rare variant');
  await expect(card).toContainText('Unmatched · Game item ID 987654');
  await expect(card.locator('.submission-card__icon-fallback')).toBeVisible();
  await review(page, state.detail.submission.collectorName).click();
  await expect(
    editor(page).getByText('Submitted item name', { exact: true }),
  ).toBeVisible();
  await expect(editor(page).getByText('987654', { exact: true })).toBeVisible();
  await expect(
    editor(page).getByText('Unlisted rare variant', { exact: true }),
  ).toBeVisible();
  await expect(
    editor(page).getByText('Unmatched', { exact: true }),
  ).toBeVisible();
  await expect(
    editor(page).getByRole('button', {
      name: 'Approve submission',
      exact: true,
    }),
  ).toBeDisabled();
  await page.screenshot({
    path: test.info().outputPath('unmatched-review-desktop.png'),
  });
  await page.getByRole('button', { name: 'Close review', exact: true }).click();
  state.detail.submission.itemId = state.catalog.items[0]!.id;
  state.detail.submission.version++;
  await page
    .getByRole('button', { name: 'Refresh submissions', exact: true })
    .click();
  await expect(card).toContainText(state.catalog.items[0]!.name);
  await review(page, state.detail.submission.collectorName).click();
  await expect(editor(page).getByText('987654', { exact: true })).toBeVisible();
  await expect(
    editor(page).getByText('Unlisted rare variant', { exact: true }),
  ).toBeVisible();
  await expect(
    editor(page).getByText('Unmatched', { exact: true }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    editor(page).getByText('987654', { exact: true }),
  ).toBeInViewport();
  await page.screenshot({
    path: test.info().outputPath('matched-review-mobile.png'),
  });
});

test('review filters reuse the authorized catalog until an explicit refresh', async ({
  page,
}) => {
  const state = await mockAdmin(page);
  await page.goto('/admin');
  await expect(page.locator('.submission-results')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  const initial = state.catalogReads;
  expect(initial).toBeGreaterThan(0);
  for (const name of ['Reviewed', 'Unmatched', 'Pending']) {
    await page
      .getByRole('group', { name: 'Submission views' })
      .getByRole('button', { name, exact: true })
      .click();
    await expect(page.locator('.submission-results')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    expect(state.catalogReads).toBe(initial);
  }
  await page
    .getByRole('button', { name: 'Refresh submissions', exact: true })
    .click();
  await expect.poll(() => state.catalogReads).toBe(initial + 1);
  await expect(page.locator('.submission-results')).toHaveAttribute(
    'aria-busy',
    'false',
  );
});

test('paged unmatched review saves a specific shared item, approves hardcore credit and revokes it with an audit reason', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const f = await adminFixtures(),
    maskId = f.detail.submission.itemId!;
  await mockApi(page);
  await page.goto('/admin');
  await page
    .getByRole('link', { name: 'Hardcore worlds', exact: true })
    .click();
  await page.getByLabel('Enable hardcore worlds', { exact: true }).click();
  await expect(
    page.getByRole('switch', { name: 'Enable hardcore worlds', exact: true }),
  ).toBeChecked();
  await page.getByRole('link', { name: 'Submissions', exact: true }).click();
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
    editor(page).getByText('approve · Test admin', { exact: true }),
  ).toBeVisible();
  await closeReviewIfOpen(page);
  await page.locator('header a.clan-brand').click();
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
  await page.getByRole('link', { name: 'Admin panel', exact: true }).click();
  if (!page.url().includes('/admin/submissions'))
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
  await closeReviewIfOpen(page);
  await page.locator('header a.clan-brand').click();
  await expect(page.locator('.item-slot--collected')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('approved corrections require a reason and move the single credit into a free normal slot', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto('/admin');
  await approve(page, 'KihiraVD');
  await review(page, 'KihiraVD').click();
  await editor(page)
    .getByLabel('Collected on hardcore worlds', { exact: true })
    .uncheck();
  await expect(
    editor(page).getByRole('button', { name: 'Save corrections', exact: true }),
  ).toBeDisabled();
  await expect(
    editor(page).getByText(
      'Enter an audit reason before changing an approved credit.',
    ),
  ).toBeVisible();
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
  await closeReviewIfOpen(page);
  await page.locator('header a.clan-brand').click();
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
  await mockApi(page);
  await page.goto('/admin/catalog');
  await page.getByRole('button', { name: '+ Add item', exact: true }).click();
  await page.getByRole('button', { name: 'Add new item', exact: true }).click();
  await page
    .getByLabel('Item icon (required)', { exact: true })
    .setInputFiles(await pngFile(itemIcon));
  await expect(page.getByAltText('New item icon preview')).toBeVisible();
  await page.getByLabel('Item name', { exact: true }).fill('New clan drop');
  await page
    .getByLabel('In-game item ID (required)', { exact: true })
    .fill('900001');
  await page.getByRole('button', { name: 'Create item', exact: true }).click();
  await expect(page.locator('.item-creator').getByRole('status')).toContainText(
    'created.',
  );
  const rows = page.locator('.catalog-item');
  const id = Number(await rows.last().getAttribute('data-item-id'));
  await page
    .getByRole('button', { name: 'Duke Sucellus', exact: true })
    .click();
  await page.getByRole('button', { name: '+ Add item', exact: true }).click();
  await page
    .getByRole('button', { name: 'Add existing item', exact: true })
    .click();
  await page
    .getByRole('searchbox', { name: 'Search items', exact: true })
    .fill('New clan drop');
  await page
    .getByRole('button', { name: 'Add New clan drop to page', exact: true })
    .click();
  await page.getByRole('button', { name: 'Vardorvis', exact: true }).click();
  const count = await rows.count();
  const added = page.locator('.catalog-item[data-item-id="' + id + '"]');
  for (let i = count - 1; i > 0; i--) {
    await added
      .getByRole('button', { name: 'Reorder item New clan drop', exact: true })
      .press('Alt+ArrowUp');
    await expect(rows.nth(i - 1)).toHaveAttribute('data-item-id', String(id));
  }
  await rows
    .first()
    .getByRole('button', { name: /^Reorder item / })
    .dragTo(rows.nth(1));
  await expect(rows.nth(1)).toHaveAttribute('data-item-id', String(id));
  await added
    .getByRole('button', { name: 'Reorder item New clan drop', exact: true })
    .press('Alt+ArrowUp');
  await expect(rows.first()).toHaveAttribute('data-item-id', String(id));
  await page
    .locator('.catalog-order-save')
    .getByRole('button', { name: 'Save changes', exact: true })
    .click();
  await expect(
    page.getByText('Item order saved.', { exact: true }),
  ).toBeVisible();
  await capture(page, 'admin-catalog-desktop.png');
  await closeReviewIfOpen(page);
  await page.locator('header a.clan-brand').click();
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
  const fact = (name: string) =>
    editor(page)
      .locator('.submission-facts > div')
      .filter({ has: page.getByText(name, { exact: true }) })
      .getByRole('definition');
  await expect(fact('Canonical item')).toHaveText('#' + id);
  await expect(fact('Item origin')).toHaveText('Manual item');
  await expect(fact('Collection log pages')).toHaveText(
    'Duke Sucellus, Vardorvis',
  );
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
  await closeReviewIfOpen(page);
  await page.locator('header a.clan-brand').click();
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
  await mockApi(page);
  await page.goto('/admin');
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
  await page.getByRole('button', { name: 'Close review', exact: true }).tap();
  await page.getByRole('link', { name: 'Items catalog', exact: true }).tap();
  const first = page.locator('.catalog-item').first();
  const id = await first.getAttribute('data-item-id');
  await first.getByRole('button', { name: /^Item settings for / }).tap();
  await page.getByRole('button', { name: 'Move later', exact: true }).tap();
  await expect(page.locator('.catalog-item').nth(1)).toHaveAttribute(
    'data-item-id',
    id!,
  );
  await page
    .locator('.catalog-order-save')
    .getByRole('button', { name: 'Save changes', exact: true })
    .click();
  await expect(
    page.getByText('Item order saved.', { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await capture(page, 'admin-catalog-mobile.png');
  await context.close();
});

test('anonymous access makes no private reads while forbidden review preserves a valid login', async ({
  page,
}) => {
  const state = await mockAdmin(page);
  state.authenticated = false;
  await page.goto('/admin');
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
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
  // This is a role/business-rule denial, not proof that authentication
  // expired: keep the valid shell session and show only a safe error.
  await expect(
    page.getByRole('navigation', { name: 'Admin navigation' }),
  ).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
  await expect(
    page.getByText('Your account is not allowed to administer the clan.'),
  ).toBeVisible();
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
  await page.getByRole('button', { name: '+ Add item', exact: true }).click();
  await page.getByRole('button', { name: 'Add new item', exact: true }).click();
  await page
    .getByLabel('In-game item ID (required)', { exact: true })
    .fill('900001');
  await page.getByLabel('Item name', { exact: true }).fill('New live drop');
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
    .setInputFiles(await pngFile(itemIcon));
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
  await expect(page.locator('.catalog-item').last()).toHaveAttribute(
    'data-item-id',
    '50001',
  );
  expect(uploads).toBe(1);
  expect(creates).toBe(2);
  await page
    .locator('.catalog-item')
    .first()
    .getByRole('button', { name: /^Reorder item / })
    .press('Alt+ArrowDown');
  await page
    .locator('.catalog-order-save')
    .getByRole('button', { name: 'Save changes', exact: true })
    .click();
  await expect(
    page.locator('.catalog-log-wrap').getByRole('alert'),
  ).toContainText('The latest data is loaded');
  await expect(page.locator('.catalog-item[data-item-id="50001"]')).toHaveCount(
    1,
  );
  await expect(
    page
      .locator('.catalog-order-save')
      .getByRole('button', { name: 'Save changes', exact: true }),
  ).toBeEnabled();
  expect(orders).toBe(1);
});

test('logout clears reviews and also denies the XP import form in the same SPA session', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto('/admin');
  await expect(page.locator('.submission-card')).toHaveCount(2);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await expect(page.locator('.submission-card')).toHaveCount(0);
  await expect(
    page.getByRole('navigation', { name: 'Admin navigation' }),
  ).toHaveCount(0);
  // Change routes in the same SPA instance: reinstalling fixtures would create a
  // new fixture session and fail to test the original logout.
  await page.evaluate(() => {
    window.history.pushState(null, '', '/admin/xp');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(
    page.getByRole('heading', { name: 'Admin sign-in required' }),
  ).toBeVisible();
  await expect(page.getByLabel('Wise Old Man competition link')).toHaveCount(0);
});

test('staff can add a manual credit without a Discord claim', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Add manual submission' }).click();
  await page.getByLabel('Search catalog items').fill('Virtus mask');
  const catalog = await adminFixtures();
  const maskId = catalog.catalog.items.find(
    (item) => item.name === 'Virtus mask',
  )!.id;
  await page
    .getByLabel('Canonical item', { exact: true })
    .selectOption(String(maskId));
  await page
    .getByLabel('Collector name', { exact: true })
    .fill('Manual tester');
  await page.getByLabel('Collection date', { exact: true }).fill('2026-10-06');
  await page.getByRole('button', { name: 'Create manual submission' }).click();
  await expect(
    page.getByText('Manual submission created: approved.'),
  ).toBeVisible();
  await expect(
    page.getByText('Manual tester', { exact: true }).first(),
  ).toBeVisible();
  const form = page.locator('section.admin-panel').filter({
    has: page.getByRole('heading', {
      name: 'Manual submission',
      exact: true,
    }),
  });
  await expect(form.getByRole('status')).toHaveText(
    'Manual submission created successfully.',
  );
  await expect(form.getByLabel('Canonical item', { exact: true })).toHaveValue(
    '',
  );
  await expect(form.getByLabel('Search catalog items')).toHaveValue('');
  await expect(form.getByLabel('Collector name', { exact: true })).toHaveValue(
    '',
  );
  await expect(form.getByLabel('Collection date', { exact: true })).toHaveValue(
    '',
  );
});

test('live admin shows a password form and submits a password without Discord OAuth', async ({
  page,
}) => {
  const fixture = await adminFixtures();
  let authenticated = false;
  let submittedPassword = '';
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/auth/session')
      return route.fulfill({
        json: authenticated ? fixture.session : { authenticated: false },
      });
    if (path === '/api/v1/auth/login') {
      submittedPassword = route.request().postDataJSON().password;
      authenticated = true;
      return route.fulfill({ json: { authenticated: true } });
    }
    if (path === '/api/v1/branding' || path === '/api/v1/admin/branding')
      return route.fulfill({ json: defaultBranding });
    if (path === '/api/v1/admin/clan-api-key')
      return route.fulfill({
        json: {
          revision: 'clan-key-1',
          enabled: true,
          key: 'mock-test-clan-key',
        },
      });
    if (path === '/api/v1/admin/settings')
      return route.fulfill({
        json: {
          revision: 'settings-1',
          clanName: 'Example clan',
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
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Sign in with Discord' }),
  ).toHaveCount(0);
  await page.getByLabel('Username', { exact: true }).fill('admin');
  await page
    .getByLabel('Password', { exact: true })
    .fill('browser-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Submissions' }),
  ).toBeVisible();
  expect(submittedPassword).toBe('browser-test-password');
});

test('manual entry reports duplicate item and world rather than a stale-version error', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto('/admin');
  const add = page.getByRole('button', { name: 'Add manual submission' });
  await add.click();
  await page.getByLabel('Search catalog items').fill('Virtus mask');
  const catalog = await adminFixtures();
  const item = catalog.catalog.items.find(
    (entry) => entry.name === 'Virtus mask',
  )!;
  await page
    .getByLabel('Canonical item', { exact: true })
    .selectOption(String(item.id));
  await page
    .getByLabel('Collector name', { exact: true })
    .fill('First collector');
  await page.getByLabel('Collection date', { exact: true }).fill('2026-10-06');
  await page.getByRole('button', { name: 'Create manual submission' }).click();
  await expect(
    page.getByText('Manual submission created: approved.'),
  ).toBeVisible();
  await page
    .getByLabel('Canonical item', { exact: true })
    .selectOption(String(item.id));
  await page.getByLabel('Collection date', { exact: true }).fill('2026-10-06');
  await page
    .locator('section.admin-panel')
    .filter({ has: page.getByRole('heading', { name: 'Manual submission' }) })
    .getByLabel('Collector name', { exact: true })
    .fill('Second collector');
  await page.getByRole('button', { name: 'Create manual submission' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Virtus mask is already collected in ordinary worlds.',
  );
  await expect(page.getByRole('alert')).toContainText('Revoke or edit');
});

test('ADMIN-01 live HTTP view shows claim date provenance and permits verified proofless manual review', async ({
  page,
}) => {
  const state = await mockAdmin(page);
  state.detail.submission = {
    ...state.detail.submission,
    source: 'manual',
    status: 'pending',
    proofUrl: '',
    dateSource: 'admin',
  };
  let approvals = 0;
  await page.route(
    '**/api/v1/admin/submissions/sample-hardcore/approve',
    (route) => {
      approvals++;
      expect(route.request().headers()['x-csrf-token']).toBe('csrf-test');
      expect(route.request().postDataJSON()).toEqual({ expectedVersion: 1 });
      state.detail.submission = {
        ...state.detail.submission,
        status: 'approved',
        version: 2,
      };
      return route.fulfill({ json: state.detail.submission });
    },
  );
  await page.goto('/admin');
  const card = page.locator('.submission-card');
  await expect(card).toContainText('Virtus mask');
  await expect(card.locator('.submission-facts')).toHaveCount(0);
  await expect(card).not.toContainText('Invalid proof link');
  await review(page, 'KihiraVD').click();
  await expect(editor(page)).toContainText('Admin correction');
  await expect(editor(page)).toContainText('No proof supplied (manual entry)');
  await expect(editor(page)).not.toContainText('Invalid proof link');
  const check = editor(page).getByLabel(/^I verified this manual claim/);
  await expect(check).toBeEnabled();
  await check.check();
  await editor(page)
    .getByRole('button', { name: 'Approve submission' })
    .click();
  await expect(
    page.getByText('Saved submission state: approved.'),
  ).toBeVisible();
  expect(approvals).toBe(1);
});

test('ADMIN-01 occupied-credit conflict retains the precise reason and reloads for manual review', async ({
  page,
}) => {
  await mockAdmin(page);
  await page.route(
    '**/api/v1/admin/submissions/sample-hardcore/approve',
    (route) =>
      route.fulfill({
        status: 409,
        json: {
          error:
            'An approved credit already exists for this item and world mode. Revoke the existing credit or select a different item or mode.',
        },
      }),
  );
  await page.goto('/admin');
  await review(page, 'KihiraVD').click();
  await proofCheck(page).check();
  await editor(page)
    .getByRole('button', { name: 'Approve submission' })
    .click();
  await expect(editor(page).getByRole('alert')).toContainText(
    'An approved credit already exists for this item and world mode.',
  );
  await expect(editor(page).getByRole('alert')).toContainText(
    'The latest data is loaded',
  );
  await expect(proofCheck(page)).not.toBeChecked();
  await expect(
    editor(page).getByRole('button', { name: 'Approve submission' }),
  ).toBeDisabled();
});

test('mobile Imgur proof remains reviewable and can be approved', async ({
  page,
}) => {
  const state = await mockAdmin(page);
  state.detail.submission.proofUrl = 'https://m.imgur.com/a/evidence';
  await page.route(
    '**/api/v1/admin/submissions/sample-hardcore/approve',
    (route) => {
      state.detail.submission = {
        ...state.detail.submission,
        status: 'approved',
        version: 2,
      };
      return route.fulfill({ json: state.detail.submission });
    },
  );
  await page.goto('/admin');
  await review(page, 'KihiraVD').click();
  await expect(
    editor(page).locator('a[href="https://m.imgur.com/a/evidence"]'),
  ).toBeVisible();
  await expect(proofCheck(page)).toBeEnabled();
  await proofCheck(page).check();
  await editor(page)
    .getByRole('button', { name: 'Approve submission', exact: true })
    .click();
  await expect(
    page.getByText('Saved submission state: approved.'),
  ).toBeVisible();
});

test('stalled login times out, ignores a late reply, and cancels on navigation', async ({
  page,
}) => {
  const state = await mockAdmin(page);
  state.authenticated = false;
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, options) => {
      if (String(input).endsWith('/api/v1/auth/login')) {
        document.documentElement.dataset.loginCalls = String(
          Number(document.documentElement.dataset.loginCalls ?? 0) + 1,
        );
        options?.signal?.addEventListener(
          'abort',
          () => {
            document.documentElement.dataset.loginAborts = String(
              Number(document.documentElement.dataset.loginAborts ?? 0) + 1,
            );
          },
          { once: true },
        );
        return new Promise<Response>((resolve) => {
          window.addEventListener(
            'release-login',
            () => resolve(new Response('{}')),
            { once: true },
          );
        });
      }
      return original(input, options);
    };
  });
  await page.goto('/admin');
  await page.clock.install();
  await page.getByLabel('Username', { exact: true }).fill('admin');
  await page
    .getByLabel('Password', { exact: true })
    .fill('timeout-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Signing in…' }),
  ).toBeDisabled();
  await page.clock.fastForward(15001);
  await expect(
    page.getByRole('alert').filter({ hasText: 'timed out' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Sign in', exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => window.dispatchEvent(new Event('release-login')));
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-login-calls', '1');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await closeReviewIfOpen(page);
  await page.locator('header a.clan-brand').click();
  await expect(page.locator('html')).toHaveAttribute('data-login-aborts', '2');
});

for (const approveImmediately of [false, true]) {
  test(
    'manual timeout retries the original request and key: approve=' +
      approveImmediately,
    async ({ page }) => {
      const state = await mockAdmin(page);
      const requests: { key: string | undefined; body: unknown }[] = [];
      await page.route('**/api/v1/admin/submissions', async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        const body = route.request().postDataJSON();
        requests.push({
          key: route.request().headers()['idempotency-key'],
          body,
        });
        if (requests.length === 1) return;
        return route.fulfill({
          status: 201,
          json: {
            ...state.detail.submission,
            id: 'manual-retry',
            version: 1,
            source: 'manual',
            ...body,
            dateSource: 'admin',
            status: approveImmediately ? 'approved' : 'pending',
            submittedAt: '2026-10-06T12:00:00.000Z',
            rawItemText: 'Virtus mask',
          },
        });
      });
      await page.goto('/admin');
      await page.clock.install();
      await page.getByRole('button', { name: 'Add manual submission' }).click();
      const item = state.catalog.items.find((x) => x.name === 'Virtus mask')!;
      await page
        .getByLabel('Canonical item', { exact: true })
        .selectOption(String(item.id));
      await page
        .getByLabel('Collector name', { exact: true })
        .fill('Retry collector');
      await page
        .getByLabel('Collection date', { exact: true })
        .fill('2026-10-06');
      await page
        .getByLabel('Approve immediately')
        .setChecked(approveImmediately);
      await page
        .getByRole('button', { name: 'Create manual submission' })
        .click();
      await expect.poll(() => requests.length).toBe(1);
      await page.clock.fastForward(15001);
      await expect(
        page.getByRole('alert').filter({ hasText: 'timed out' }),
      ).toBeVisible();
      await expect(
        page.getByLabel('Collector name', { exact: true }),
      ).toBeDisabled();
      await page
        .getByRole('button', { name: 'Retry manual submission' })
        .click();
      await expect(
        page.getByText(
          'Manual submission created: ' +
            (approveImmediately ? 'approved.' : 'pending.'),
        ),
      ).toBeVisible();
      expect(requests).toHaveLength(2);
      expect(requests[0]!.key).toMatch(/^[a-f0-9-]{36}$/);
      expect(requests[1]).toEqual(requests[0]);
    },
  );
}

test('navigation preserves a pending manual write; logout aborts and removes the private form', async ({
  page,
}) => {
  await mockAdmin(page);
  await page.route('**/api/v1/auth/logout', (route) =>
    route.fulfill({ status: 204 }),
  );
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, options) => {
      if (
        String(input).endsWith('/api/v1/admin/submissions') &&
        options?.method === 'POST'
      ) {
        options.signal?.addEventListener(
          'abort',
          () => {
            document.documentElement.dataset.manualAborted = 'true';
          },
          { once: true },
        );
        return new Promise<Response>(() => {});
      }
      return original(input, options);
    };
  });
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Add manual submission' }).click();
  const f = await adminFixtures();
  await page
    .getByLabel('Canonical item', { exact: true })
    .selectOption(String(f.catalog.items[0]!.id));
  await page
    .getByLabel('Collector name', { exact: true })
    .fill('Cancel collector');
  await page.getByRole('button', { name: 'Create manual submission' }).click();
  await expect(
    page.getByRole('button', { name: 'Saving…', exact: true }),
  ).toBeDisabled();
  await page.getByRole('link', { name: 'Items catalog', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Wait for the current staff operation',
  );
  await expect(page.locator('html')).not.toHaveAttribute(
    'data-manual-aborted',
    'true',
  );
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute(
    'data-manual-aborted',
    'true',
  );
  await expect(
    page.getByRole('navigation', { name: 'Admin navigation' }),
  ).toHaveCount(0);
});
