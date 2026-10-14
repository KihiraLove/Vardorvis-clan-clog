import { expect, test, type Page } from '@playwright/test';
import { adminFixtures } from './admin-fixtures.ts';
import { defaultBranding } from '../src/branding.ts';
import { zeroTotals } from '../src/xp-model.ts';

async function historyFixture(page: Page) {
  const f = await adminFixtures();
  const state = {
    generation: 1,
    failure: 0,
    sessions: 0,
    cursors: [] as (string | null)[],
    pause: undefined as Promise<void> | undefined,
  };
  const entries = Array.from({ length: 45 }, (_, index) => {
    const n = 45 - index,
      unchanged = n % 2 === 1;
    return {
      id: '00000000-0000-4000-8000-' + String(n).padStart(12, '0'),
      competitionId: 42,
      title: 'Saved receipt ' + n,
      actorName: 'History admin',
      importedAt: '2026-10-14T00:00:00Z',
      outcome: unchanged ? 'unchanged' : 'applied',
      changes: [
        {
          skill: 'attack',
          before: '9007199254740993',
          after: unchanged ? '9007199254740993' : '9007199254740994',
          change: unchanged ? '0' : '1',
        },
      ],
    };
  });
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname;
    if (path === '/api/v1/auth/session') {
      state.sessions++;
      return route.fulfill({ json: f.session });
    }
    if (path === '/api/v1/settings')
      return route.fulfill({
        json: {
          revision: 'settings-1',
          clanName: 'XP history',
          hardcoreEnabled: false,
        },
      });
    if (path.startsWith('/api/v1/branding'))
      return route.fulfill({ json: defaultBranding });
    if (path === '/api/v1/admin/catalog')
      return route.fulfill({ json: f.catalog });
    if (path === '/api/v1/xp/tracker')
      return route.fulfill({
        json: {
          revision: 'xp-1',
          totals: zeroTotals(),
          events: [],
          podium: [],
        },
      });
    if (path === '/api/v1/admin/xp/imports') {
      const cursor = url.searchParams.get('cursor');
      state.cursors.push(cursor);
      if (cursor && state.pause) await state.pause;
      if (
        cursor &&
        (state.failure || !cursor.startsWith(state.generation + ':'))
      )
        return route.fulfill({
          status: state.failure || 409,
          json: { error: 'History changed' },
        });
      const start = cursor ? Number(cursor.split(':')[1]) : 0;
      return route.fulfill({
        json: {
          revision: 'xp-history-' + state.generation,
          pageCursor: state.generation + ':' + start,
          nextCursor:
            start + 20 < entries.length
              ? state.generation + ':' + (start + 20)
              : null,
          imports: entries.slice(start, start + 20),
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: 'Unavailable' } });
  });
  return state;
}
async function openHistory(page: Page) {
  await page.goto('/admin/xp');
  await page.getByText('Import history (20 on this page)').click();
  const history = page.locator('.xp-history');
  await expect(
    history.getByText('Saved receipt 45', { exact: true }),
  ).toBeVisible();
  return history;
}
for (const width of [1100, 320]) {
  test(`XP history traverses complete receipts and exact XP at ${width}px without losing the import draft`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 850 });
    const state = await historyFixture(page),
      history = await openHistory(page);
    const input = page.getByLabel('Wise Old Man competition link');
    await input.fill('https://wiseoldman.net/competitions/9999');
    await expect(
      history.getByRole('button', { name: 'Newer imports' }),
    ).toBeDisabled();
    await expect(history.locator('ol > li').first()).toContainText('unchanged');
    await expect(history.locator('ol > li').first()).toContainText(
      '9,007,199,254,740,993 → 9,007,199,254,740,993 (0 XP)',
    );
    await expect(history.locator('ol > li').nth(1)).toContainText(
      '9,007,199,254,740,993 → 9,007,199,254,740,994 (+1 XP)',
    );
    await history.getByRole('button', { name: 'Older imports' }).click();
    await expect(history.getByText('History page 2')).toBeVisible();
    await expect(
      history.getByText('Saved receipt 25', { exact: true }),
    ).toBeVisible();
    await history.getByRole('button', { name: 'Older imports' }).click();
    await expect(history.getByText('History page 3')).toBeVisible();
    await expect(history.locator('ol > li')).toHaveCount(5);
    await expect(
      history.getByRole('button', { name: 'Older imports' }),
    ).toBeDisabled();
    await expect(
      history.getByText('Saved receipt 1', { exact: true }),
    ).toBeVisible();
    await history.getByRole('button', { name: 'Newer imports' }).click();
    await expect(history.getByText('History page 2')).toBeVisible();
    await history.getByRole('button', { name: 'Newer imports' }).click();
    await expect(history.getByText('History page 1')).toBeVisible();
    await expect(
      history.getByText('Saved receipt 45', { exact: true }),
    ).toBeVisible();
    await expect(input).toHaveValue('https://wiseoldman.net/competitions/9999');
    expect(state.cursors).toEqual([null, '1:20', '1:40', '1:20', '1:0']);
    expect(state.sessions).toBe(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
}
test('XP history rejects concurrent appends on previous traversal and explicitly reloads the first page', async ({
  page,
}) => {
  const state = await historyFixture(page),
    history = await openHistory(page);
  await history.getByRole('button', { name: 'Older imports' }).click();
  await expect(history.getByText('History page 2')).toBeVisible();
  state.generation++;
  await history.getByRole('button', { name: 'Newer imports' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'XP import history changed',
  );
  await expect(history.locator('ol > li')).toHaveCount(0);
  await expect(
    history.getByRole('button', { name: 'Older imports' }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Retry XP history' }).click();
  await expect(history.getByText('History page 1')).toBeVisible();
  await expect(
    history.getByText('Saved receipt 45', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(state.cursors).toEqual([null, '1:20', '1:0', null]);
});
for (const status of [401, 403, 503]) {
  test(`XP history page ${status} clears private rows and ${status === 401 ? 'revokes the session' : 'keeps the import screen'}`, async ({
    page,
  }) => {
    const state = await historyFixture(page),
      history = await openHistory(page);
    state.failure = status;
    await history.getByRole('button', { name: 'Older imports' }).click();
    await expect(
      page.getByText('Saved receipt 45', { exact: true }),
    ).toHaveCount(0);
    if (status === 401) {
      await expect(
        page.getByRole('heading', { name: 'Admin session expired' }),
      ).toBeVisible();
      await expect(
        page.getByRole('navigation', { name: 'Admin navigation' }),
      ).toHaveCount(0);
      await expect(page.locator('.xp-history')).toHaveCount(0);
    } else {
      await expect(page.getByRole('alert')).toBeVisible();
      await expect(
        page.getByLabel('Wise Old Man competition link'),
      ).toBeVisible();
      await expect(history.locator('ol > li')).toHaveCount(0);
      await page.getByRole('button', { name: 'Retry XP history' }).click();
      await expect(
        history.getByText('Saved receipt 45', { exact: true }),
      ).toBeVisible();
    }
    expect(state.sessions).toBe(1);
  });
}
test('XP history timeout clears busy state and ignores a late page response', async ({
  page,
}) => {
  const state = await historyFixture(page),
    history = await openHistory(page);
  let release!: () => void;
  state.pause = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.clock.install();
  await history.getByRole('button', { name: 'Older imports' }).click();
  await expect(
    history.getByRole('button', { name: 'Older imports' }),
  ).toHaveAttribute('aria-busy', 'true');
  await page.clock.fastForward(10001);
  await expect(page.getByRole('alert')).toContainText('could not be loaded');
  await expect(
    history.getByRole('button', { name: 'Older imports' }),
  ).toHaveAttribute('aria-busy', 'false');
  release();
  await page.getByRole('button', { name: 'Retry XP history' }).click();
  await expect(
    history.getByText('Saved receipt 45', { exact: true }),
  ).toBeVisible();
  await expect(
    history.getByText('Saved receipt 25', { exact: true }),
  ).toHaveCount(0);
});
