/** Issue #60: live-adapter coverage and executable regressions for remediated findings. */
import { expect, test, type Page } from '@playwright/test';
import { adminFixtures } from './admin-fixtures.ts';
import { defaultBranding } from '../src/branding.ts';
import { zeroTotals } from '../src/xp-model.ts';

async function liveAdmin(page: Page, authenticated = true) {
  const f = await adminFixtures();
  const state = {
    detail: structuredClone(f.detail),
    cursors: [] as (string | null)[],
    decisions: [] as { action: string; body: Record<string, unknown> }[],
    claimWrites: 0,
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
    if (path === base && request.method() === 'PATCH') {
      state.claimWrites++;
      const input = request.postDataJSON();
      if (input.expectedVersion !== state.detail.submission.version)
        return route.fulfill({ status: 409, json: { error: 'Stale version' } });
      state.detail.submission = {
        ...state.detail.submission,
        itemId: Number(input.itemId),
        collectorName: String(input.collectorName),
        collectedOn: String(input.collectedOn),
        hardcore: Boolean(input.hardcore),
        version: state.detail.submission.version + 1,
      };
      return route.fulfill({ json: state.detail.submission });
    }
    if (path === base + '/note' && request.method() === 'PATCH') {
      const input = request.postDataJSON();
      if (input.expectedVersion !== state.detail.submission.version)
        return route.fulfill({ status: 409, json: { error: 'Stale version' } });
      const before = structuredClone(state.detail.submission);
      const note = String(input.note).trim();
      if (note === before.reviewNote)
        return route.fulfill({ status: 422, json: { error: 'No change' } });
      state.detail.submission = {
        ...before,
        reviewNote: note,
        version: before.version + 1,
      };
      state.detail.audit.unshift({
        id: 'note-' + state.detail.submission.version,
        actorName: 'Audit fixture',
        at: new Date().toISOString(),
        action: 'edit',
        reason: null,
        before,
        after: structuredClone(state.detail.submission),
      });
      return route.fulfill({ json: state.detail.submission });
    }
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
  const next = page.getByRole('button', { name: 'Next page', exact: true });
  await expect(next).toBeEnabled();
  const previous = page.getByRole('button', {
    name: 'Previous page',
    exact: true,
  });
  // F04: boundary disabled states are not ongoing requests.
  await expect(previous).not.toHaveCSS('cursor', 'wait');
  await expect(previous).toHaveAttribute('aria-describedby', /.+/);
  await expect(
    page.getByText('Previous page: Already on the first page.'),
  ).toBeVisible();
  await expect(next).not.toHaveAttribute('aria-busy', 'true');
  await next.click();
  await expect(next).toBeDisabled();
  await expect(next).not.toHaveCSS('cursor', 'wait');
  await expect(
    page.getByText('Next page: Already on the last page.'),
  ).toBeVisible();
  await expect(previous).toBeEnabled();
});

test('audit: an ordinary-world review note can be saved, discarded, cleared and reloaded independently', async ({
  page,
}) => {
  const state = await liveAdmin(page);
  state.detail.submission.hardcore = false;
  const editor = await openReview(page);
  const note = editor.getByLabel('Review note');
  const save = editor.getByRole('button', { name: 'Save review note' });
  const discard = editor.getByRole('button', { name: 'Discard review note' });
  await note.fill('Reviewed the collection date.');
  await expect(save).toBeEnabled();
  await expect(discard).toBeEnabled();
  await expect(
    editor.getByRole('button', { name: 'Save corrections' }),
  ).toBeDisabled();
  await discard.click();
  await expect(note).toHaveValue('');
  await expect(save).toBeDisabled();
  await note.fill('Reviewed the collection date.');
  await save.click();
  await expect(note).toHaveValue('Reviewed the collection date.');
  await expect(save).toBeDisabled();
  await expect(state.detail.submission.reviewNote).toBe(
    'Reviewed the collection date.',
  );
  await expect(state.detail.submission.version).toBe(2);
  await expect(state.detail.audit).toHaveLength(1);
  await expect(state.detail.audit[0]?.reason).toBeNull();
  await editor.getByRole('button', { name: 'Close review' }).click();
  await page.getByRole('button', { name: /^Review .+ ·/ }).click();
  await expect(
    page.locator('.submission-editor').getByLabel('Review note'),
  ).toHaveValue('Reviewed the collection date.');
  await page.locator('.submission-editor').getByLabel('Review note').fill('');
  await page
    .locator('.submission-editor')
    .getByRole('button', { name: 'Save review note' })
    .click();
  await expect(
    page.locator('.submission-editor').getByLabel('Review note'),
  ).toHaveValue('');
  expect(state.detail.audit).toHaveLength(2);
  expect(state.detail.submission.reviewNote).toBe('');
});

test('audit: hardcore review note is versioned without changing claim mode or approval', async ({
  page,
}) => {
  const state = await liveAdmin(page);
  state.detail.submission.hardcore = true;
  const editor = await openReview(page);
  await editor.getByLabel('Review note').fill('HC-only evidence checked');
  await editor.getByRole('button', { name: 'Save review note' }).click();
  await expect(editor.getByLabel('Collected on hardcore worlds')).toBeChecked();
  expect(state.detail.submission.hardcore).toBe(true);
  expect(state.detail.submission.status).toBe('pending');
  expect(state.detail.submission.reviewNote).toBe('HC-only evidence checked');
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
  expect(await style()).toEqual(scheduling);
});

test('audit: a pending session check gates navigation and concurrent private XP loads', async ({
  page,
}) => {
  const f = await adminFixtures();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let checks = 0;
  let privateReads = 0;
  await liveAdmin(page);
  await page.route('**/api/v1/auth/session', async (route) => {
    checks++;
    await gate;
    await route.fulfill({ json: f.session });
  });
  await page.route('**/api/v1/admin/xp/imports', async (route) => {
    privateReads++;
    await route.fulfill({ json: { imports: [] } });
  });
  try {
    await page.goto('/admin/xp');
    await expect(page.getByText('Checking admin access…')).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Admin navigation' }),
    ).toHaveCount(0);
    await expect(page.getByLabel('Wise Old Man competition link')).toHaveCount(
      0,
    );
    expect(privateReads).toBe(0);
  } finally {
    release();
  }
  await expect(
    page.getByRole('navigation', { name: 'Admin navigation' }),
  ).toBeVisible();
  await expect(page.getByLabel('Wise Old Man competition link')).toBeVisible();
  await expect.poll(() => privateReads).toBe(1);
  expect(checks).toBe(1);
});

test('audit: mandatory first-login password setup hides navigation and XP imports', async ({
  page,
}) => {
  const f = await adminFixtures();
  await liveAdmin(page);
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({ json: { ...f.session, mustChangePassword: true } }),
  );
  await page.goto('/admin/xp');
  await expect(
    page.getByRole('navigation', { name: 'Admin navigation' }),
  ).toHaveCount(0);
  await expect(page.getByLabel('Wise Old Man competition link')).toHaveCount(0);
  await expect(page.getByLabel('Current password')).toBeVisible();
});

test('audit: XP history expiry clears private content without a second session waterfall', async ({
  page,
}) => {
  const f = await adminFixtures();
  let checks = 0;
  let denied = false;
  await liveAdmin(page);
  await page.route('**/api/v1/auth/session', async (route) => {
    checks++;
    await route.fulfill({ json: f.session });
  });
  await page.route('**/api/v1/admin/xp/imports', (route) =>
    route.fulfill(
      denied
        ? { status: 401, json: { error: 'expired' } }
        : {
            json: {
              imports: [
                {
                  id: 'import-1',
                  competitionId: 42,
                  title: 'Private XP history',
                  actorName: 'Admin',
                  importedAt: '2026-10-13T06:00:00.000Z',
                  outcome: 'applied',
                  changes: [],
                },
              ],
            },
          },
    ),
  );
  await page.goto('/admin/xp');
  await expect(page.getByText('Import history (1)')).toBeVisible();
  await page.getByText('Import history (1)').click();
  await expect(page.getByText('Private XP history')).toBeVisible();
  expect(checks).toBe(1);
  denied = true;
  await page.getByRole('link', { name: 'Your account' }).click();
  await page.getByRole('link', { name: 'XP imports' }).click();
  await expect(
    page.getByRole('heading', { name: 'Admin session expired' }),
  ).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Admin navigation' }),
  ).toHaveCount(0);
  await expect(page.getByText('Private XP history')).toHaveCount(0);
  await expect(page.getByLabel('Wise Old Man competition link')).toHaveCount(0);
  expect(checks).toBe(1);
});

test('audit: denied XP history is not mistaken for an expired login', async ({
  page,
}) => {
  await liveAdmin(page);
  await page.route('**/api/v1/admin/xp/imports', (route) =>
    route.fulfill({ status: 403, json: { error: 'role denied' } }),
  );
  await page.goto('/admin/xp');
  await expect(
    page.getByText('Your account is not allowed to view XP import history.'),
  ).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Admin navigation' }),
  ).toBeVisible();
  await expect(page.getByLabel('Wise Old Man competition link')).toBeVisible();
});

test('audit: retrying a failed session refresh clears the prior error and restores navigation', async ({
  page,
}) => {
  const f = await adminFixtures();
  let unavailable = true;
  await liveAdmin(page);
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill(
      unavailable
        ? { status: 503, json: { error: 'unavailable' } }
        : { json: f.session },
    ),
  );
  await page.goto('/admin');
  await expect(
    page.getByRole('heading', { name: 'Admin access unavailable' }),
  ).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Admin navigation' }),
  ).toHaveCount(0);
  unavailable = false;
  await page.getByRole('button', { name: 'Retry admin access' }).click();
  await expect(
    page.getByRole('navigation', { name: 'Admin navigation' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Admin access unavailable' }),
  ).toHaveCount(0);
});

for (const status of [401, 403]) {
  test(`audit: competition preview ${status} ${status === 401 ? 'expires' : 'preserves'} the shell session`, async ({
    page,
  }) => {
    await liveAdmin(page);
    await page.route('**/api/v1/admin/competitions/preview', (route) =>
      route.fulfill({ status, json: { error: 'private diagnostic' } }),
    );
    await page.goto('/admin/xp');
    await page
      .getByLabel('Wise Old Man competition link')
      .fill('https://wiseoldman.net/competitions/42');

    await page.getByRole('button', { name: 'Preview competition' }).click();
    if (status === 401) {
      await expect(
        page.getByRole('heading', { name: 'Admin session expired' }),
      ).toBeVisible();
      await expect(
        page.getByLabel('Wise Old Man competition link'),
      ).toHaveCount(0);
      await expect(
        page.getByRole('navigation', { name: 'Admin navigation' }),
      ).toHaveCount(0);
    } else {
      await expect(
        page.getByText(
          'Your account is not allowed to perform this competition import.',
        ),
      ).toBeVisible();
      await expect(
        page.getByRole('navigation', { name: 'Admin navigation' }),
      ).toBeVisible();
    }
  });
}

for (const hardcore of [false, true]) {
  test(`audit: approval blockers explain unmatched, unsaved, proof acknowledgment and saved hardcore=${hardcore}`, async ({
    page,
  }) => {
    const state = await liveAdmin(page);
    state.detail.submission.hardcore = hardcore;
    state.detail.submission.itemId = null;
    const editor = await openReview(page);
    const approve = editor.getByRole('button', { name: 'Approve submission' });
    const check = editor.getByLabel(/^I checked the linked proof/);
    await expect(approve).toBeDisabled();
    await expect(
      editor
        .getByText('Select and save an active canonical item before approving.')
        .first(),
    ).toBeVisible();
    await expect(check).toBeDisabled();
    await editor
      .locator('#canonical-item')
      .selectOption(String((await adminFixtures()).detail.submission.itemId));
    await expect(approve).toBeDisabled();
    await expect(
      editor
        .getByText('Save or discard claim corrections before deciding.')
        .first(),
    ).toBeVisible();
    await editor.getByRole('button', { name: 'Save corrections' }).click();
    await expect.poll(() => state.claimWrites).toBe(1);
    await expect(check).toBeEnabled();
    await expect(approve).toBeDisabled();
    await expect(
      editor.getByText(/then tick the proof acknowledgement/u),
    ).toBeVisible();
    await check.check();
    await expect(approve).toBeEnabled();
    // Any claim-field change invalidates the saved proof acknowledgment.
    await editor
      .getByLabel('Collected on hardcore worlds')
      .setChecked(!hardcore);
    await expect(check).not.toBeChecked();
    await expect(check).toBeDisabled();
    await editor.getByRole('button', { name: 'Discard corrections' }).click();
    await expect(
      editor.getByLabel('Collected on hardcore worlds'),
    ).toHaveJSProperty('checked', hardcore);
    await expect(check).toBeEnabled();
    await expect(check).not.toBeChecked();
    await check.check();
    await approve.click();
    await expect(
      page.getByText('Saved submission state: approved.'),
    ).toBeVisible();
    expect(state.decisions).toHaveLength(1);
  });
}

test('audit: missing proof blocks approval but not reasoned rejection', async ({
  page,
}) => {
  const state = await liveAdmin(page);
  state.detail.submission.proofUrl = 'https://example.com/not-valid';
  const editor = await openReview(page);
  await expect(
    editor.getByRole('button', { name: 'Approve submission' }),
  ).toBeDisabled();
  await expect(
    editor
      .getByText(
        'A valid proof link or saved screenshot is required for approval.',
      )
      .first(),
  ).toBeVisible();
  await expect(editor.getByLabel(/^I checked the linked proof/)).toBeDisabled();
  const reject = editor.getByRole('button', { name: 'Reject submission' });
  await expect(reject).toBeDisabled();
  await expect(
    editor.getByText('Enter a reason before rejecting a submission.'),
  ).toBeVisible();
  await editor
    .getByLabel('Review reason')
    .fill('The proof does not match the claimed item');
  await expect(reject).toBeEnabled();
  await reject.click();
  expect(state.decisions[0]?.action).toBe('reject');
});

test('audit: approved credit requires an audit reason for claim corrections or revocation', async ({
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
  const revoke = editor.getByRole('button', { name: 'Revoke credit' });
  await expect(revoke).toBeDisabled();
  await expect(
    editor.getByText('Enter a reason before revoking a credit.'),
  ).toBeVisible();
  await editor.getByLabel('Collected on hardcore worlds').uncheck();
  const save = editor.getByRole('button', { name: 'Save corrections' });
  await expect(save).toBeDisabled();
  await expect(
    editor.getByText(
      'Enter an audit reason before changing an approved credit.',
    ),
  ).toBeVisible();
  await editor
    .getByLabel('Review reason')
    .fill('Corrected world mode after proof review');
  await expect(save).toBeEnabled();
  await expect(revoke).toBeDisabled();
  await editor.getByRole('button', { name: 'Discard corrections' }).click();
  await expect(revoke).toBeDisabled();
  await expect(
    editor.getByText('Enter a reason before revoking a credit.'),
  ).toBeVisible();
  await editor
    .getByLabel('Review reason')
    .fill('Revoking after independent proof review');
  await expect(revoke).toBeEnabled();
  await revoke.click();
  expect(state.decisions[0]?.action).toBe('revoke');
});

test('audit: a pending approve request shows progress, serializes clicks and never replays a rejected write', async ({
  page,
}) => {
  const state = await liveAdmin(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let attempts = 0;
  await page.route('**/api/v1/admin/submissions/*/approve', async (route) => {
    attempts++;
    await gate;
    await route.fulfill({ status: 409, json: { error: 'stale request' } });
  });
  const editor = await openReview(page);
  await editor.getByLabel(/^I checked the linked proof/).check();
  const approve = editor.getByRole('button', { name: 'Approve submission' });
  try {
    await approve.click();
    await expect(page.getByText('Approving saved claim…')).toBeVisible();
    await expect(approve).toBeDisabled();
    await expect(approve).toHaveAttribute('aria-busy', 'true');
    await expect(approve).toHaveCSS('cursor', 'wait');
    expect(attempts).toBe(1);
  } finally {
    release();
  }
  await expect(approve).not.toHaveAttribute('aria-busy', 'true');
  await expect(approve).toBeDisabled();
  await expect(
    editor.getByLabel(/^I checked the linked proof/),
  ).not.toBeChecked();
  await expect(editor.getByRole('alert')).toContainText(
    'Another change was saved.',
  );
  expect(attempts).toBe(1);
  expect(state.decisions).toHaveLength(0);
});
