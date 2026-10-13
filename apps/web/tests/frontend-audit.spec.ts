/** Issue #60: live-adapter coverage and executable, explicitly expected regressions.
 * Remove each test.fail annotation when its acceptance criterion is implemented.
 * An unexpected pass fails CI so resolved defects cannot remain hidden here.
 */
import { expect, test, type Page } from '@playwright/test';
import { adminFixtures } from './admin-fixtures.ts';
import { defaultBranding } from '../src/branding.ts';
import { zeroTotals } from '../src/xp-model.ts';

const issue = 'https://github.com/KihiraLove/Vardorvis-clan-clog/issues/60';

async function liveAdmin(page: Page, authenticated = true) {
  const f = await adminFixtures();
  const state = {
    detail: structuredClone(f.detail),
    cursors: [] as (string | null)[],
    decisions: [] as { action: string; body: Record<string, unknown> }[],
  };
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === '/api/v1/auth/session')
      return route.fulfill({
        json: authenticated ? f.session : { authenticated: false },
      });
    if (path === '/api/v1/settings')
      return route.fulfill({
        json: {
          revision: 'settings-1',
          clanName: 'Audit',
          hardcoreEnabled: true,
        },
      });
    if (path.startsWith('/api/v1/branding'))
      return route.fulfill({ json: defaultBranding });
    if (path === '/api/v1/admin/catalog')
      return route.fulfill({ json: f.catalog });
    if (path === '/api/v1/admin/schedules')
      return route.fulfill({
        json: { revision: 'schedules-1', enabled: false, schedules: [] },
      });
    if (path === '/api/v1/xp/tracker')
      return route.fulfill({
        json: {
          revision: 'xp-1',
          totals: zeroTotals(),
          events: [],
          podium: [],
        },
      });
    if (path === '/api/v1/admin/xp/imports')
      return route.fulfill({ json: { imports: [] } });
    if (path === '/api/v1/admin/submissions') {
      const cursor = url.searchParams.get('cursor');
      state.cursors.push(cursor);
      return route.fulfill({
        json: {
          revision: 'queue-audit',
          submissions: [state.detail.submission],
          nextCursor: cursor ? null : 'audit-page-2',
        },
      });
    }
    const base = '/api/v1/admin/submissions/' + state.detail.submission.id;
    if (path === base && request.method() === 'GET')
      return route.fulfill({ json: state.detail });
    for (const [action, status] of [
      ['approve', 'approved'],
      ['reject', 'rejected'],
      ['revoke', 'revoked'],
    ] as const) {
      if (path !== base + '/' + action) continue;
      state.decisions.push({ action, body: request.postDataJSON() });
      expect(request.headers()['x-csrf-token']).toBe('csrf-test');
      state.detail.submission = {
        ...state.detail.submission,
        status,
        version: state.detail.submission.version + 1,
      };
      return route.fulfill({ json: state.detail.submission });
    }
    return route.fulfill({
      status: 404,
      json: { error: 'Unmocked audit route' },
    });
  });
  return state;
}

async function openReview(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: /^Review .+ ·/ }).click();
  const editor = page.locator('.submission-editor');
  await expect(
    editor.getByLabel('Collector name', { exact: true }),
  ).toBeEnabled();
  return editor;
}

test('audit: live queue follows next and previous cursors and respects boundaries', async ({
  page,
}) => {
  const state = await liveAdmin(page);
  await page.goto('/admin');
  const previous = page.getByRole('button', {
    name: 'Previous page',
    exact: true,
  });
  const next = page.getByRole('button', { name: 'Next page', exact: true });
  await expect(next).toBeEnabled();
  await expect(previous).toBeDisabled();
  await next.click();
  await expect(page.getByText('Page 2', { exact: true })).toBeVisible();
  await expect(previous).toBeEnabled();
  await expect(next).toBeDisabled();
  await previous.click();
  await expect(next).toBeEnabled();
  expect(state.cursors).toEqual([null, 'audit-page-2', null]);
});

for (const hardcore of [false, true]) {
  test(`audit: saved hardcore=${hardcore} allows proof acknowledgement and approval`, async ({
    page,
  }) => {
    const state = await liveAdmin(page);
    state.detail.submission.hardcore = hardcore;
    const editor = await openReview(page);
    await editor.getByLabel(/^I checked the linked proof/).check();
    await editor
      .getByRole('button', { name: 'Approve submission', exact: true })
      .click();
    await expect(
      page.getByText('Saved submission state: approved.', { exact: true }),
    ).toBeVisible();
    expect(state.decisions[0]?.action).toBe('approve');
  });
}

test('audit: rejection needs a reason but does not need proof acknowledgement', async ({
  page,
}) => {
  const state = await liveAdmin(page);
  const editor = await openReview(page);
  const reject = editor.getByRole('button', {
    name: 'Reject submission',
    exact: true,
  });
  await editor.getByLabel(/^I checked the linked proof/).check();
  await expect(reject).toBeDisabled();
  await editor.getByLabel(/^I checked the linked proof/).uncheck();
  await editor
    .getByLabel('Review reason')
    .fill('The evidence does not establish this claim.');
  await reject.click();
  await expect(
    page.getByText('Saved submission state: rejected.', { exact: true }),
  ).toBeVisible();
  expect(state.decisions[0]).toEqual({
    action: 'reject',
    body: {
      expectedVersion: 1,
      reason: 'The evidence does not establish this claim.',
    },
  });
});

test('audit: reviewed approved credit can be revoked with a reason', async ({
  page,
}) => {
  const state = await liveAdmin(page);
  await page.goto('/admin');
  await expect(
    page.getByRole('button', { name: /^Review .+ ·/ }),
  ).toBeEnabled();
  state.detail.submission.status = 'approved';
  await page.getByRole('button', { name: 'Reviewed', exact: true }).click();
  await page.getByRole('button', { name: /^Review .+ ·/ }).click();
  const editor = page.locator('.submission-editor');
  const revoke = editor.getByRole('button', {
    name: 'Revoke credit',
    exact: true,
  });
  await expect(revoke).toBeDisabled();
  await editor.getByLabel('Review reason').fill('Evidence withdrawn.');
  await revoke.click();
  await expect(
    page.getByText('Saved submission state: revoked.', { exact: true }),
  ).toBeVisible();
  expect(state.decisions[0]?.action).toBe('revoke');
});

test('audit: logged-out sessions have no admin navigation', async ({
  page,
}) => {
  await liveAdmin(page, false);
  await page.goto('/admin');
  await expect(
    page.getByRole('heading', { name: 'Admin sign-in required' }),
  ).toBeVisible();
  // F02: no navigation or private loader mounts without a verified session.
  await expect(
    page.getByRole('navigation', { name: 'Admin navigation' }),
  ).toHaveCount(0);
});

test('audit: a pagination boundary does not use a loading cursor', async ({
  page,
}) => {
  await liveAdmin(page);
  await page.goto('/admin');
  await expect(
    page.getByRole('button', { name: 'Next page', exact: true }),
  ).toBeEnabled();
  const previous = page.getByRole('button', {
    name: 'Previous page',
    exact: true,
  });
  test.fail(true, issue + ': disabled and busy styling are conflated');
  await expect(previous).not.toHaveCSS('cursor', 'wait');
});

test('audit: a reason-only draft can be saved or discarded in ordinary worlds', async ({
  page,
}) => {
  const state = await liveAdmin(page);
  state.detail.submission.hardcore = false;
  const editor = await openReview(page);
  await editor
    .getByLabel('Review reason')
    .fill('Reviewed the collection date.');
  test.fail(
    true,
    issue +
      ': reason is omitted from dirty tracking and the server rejects note-only edits',
  );
  await expect(
    editor.getByRole('button', { name: 'Save corrections', exact: true }),
  ).toBeEnabled();
  await expect(
    editor.getByRole('button', { name: 'Discard corrections', exact: true }),
  ).toBeEnabled();
});

test('audit: retain the current admin page until destination data is ready', async ({
  page,
}) => {
  await liveAdmin(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route('**/api/v1/admin/catalog', async (route) => {
    requested = true;
    await gate;
    await route.fallback();
  });
  await page.goto('/admin/account');
  const account = page.getByRole('heading', {
    name: 'Your account',
    exact: true,
  });
  await expect(account).toBeVisible();
  await page.getByRole('link', { name: 'Items catalog', exact: true }).click();
  await expect.poll(() => requested).toBe(true);
  test.fail(true, issue + ': route commits before its data loads');
  try {
    await expect(account).toBeVisible();
  } finally {
    release();
  }
});

test('audit: XP and Scheduling competition fields share input styling', async ({
  page,
}) => {
  await liveAdmin(page);
  const input = page.getByLabel('Wise Old Man competition link');
  const style = () =>
    input.evaluate((element) => {
      const css = getComputedStyle(element);
      return {
        padding: css.padding,
        background: css.backgroundColor,
        font: css.fontFamily,
      };
    });
  await page.goto('/admin/schedules');
  await expect(input).toBeVisible();
  const scheduling = await style();
  await page.getByRole('link', { name: 'XP imports', exact: true }).click();
  await expect(input).toBeVisible();
  test.fail(
    true,
    issue + ': shared importer styling depends on its parent panel',
  );
  expect(await style()).toEqual(scheduling);
});
