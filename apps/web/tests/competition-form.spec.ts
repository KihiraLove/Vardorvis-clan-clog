/** REVIEW-03/F08: shared controls keep their styling and native behavior in both hosts. */
import { expect, test, type Page } from './test.ts';
import { adminFixtures } from './admin-fixtures.ts';
import { defaultBranding } from '../src/branding.ts';
import { zeroTotals } from '../src/xp-model.ts';

test.use({ timezoneId: 'UTC' });
const paths = ['/admin/schedules', '/admin/xp'];
const now = '2026-10-13T12:00:00Z';
const pageName = 'Opening page with ' + 'LongCollectionName'.repeat(5);

async function formFixture(page: Page, role: 'admin' | 'moderator' = 'admin') {
  const f = await adminFixtures();
  let attempts = 0,
    applies = 0;
  let failNext = false,
    hold = false;
  const releases: (() => void)[] = [];
  await page.clock.setFixedTime(new Date(now));
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/v1/admin/competitions/preview') {
      attempts++;
      expect(request.headers()['x-csrf-token']).toBe('csrf-test');
      const input = request.postDataJSON();
      if (hold) await new Promise<void>((resolve) => releases.push(resolve));
      if (failNext) {
        failNext = false;
        return route.fulfill({
          status: 503,
          json: { error: 'Preview temporarily unavailable.' },
        });
      }
      const skill = input.competitionUrl.endsWith('/124');
      return route.fulfill({
        json: {
          previewToken: 'style-preview-' + attempts,
          expectedRevision: 'xp-style',
          scheduleRevision: 'schedules-1',
          expiresAt: '2099-01-01T00:00:00Z',
          competition: {
            id: skill ? 124 : 123,
            title: skill ? 'Corrected Attack results' : 'Boss week',
            kind: skill ? 'SKILL' : 'ACTIVITY',
            sourceUrl: input.competitionUrl,
            metrics: [skill ? 'attack' : 'vardorvis'],
            startsAt: '2026-10-01T12:00:00Z',
            endsAt: skill ? '2026-10-08T12:00:00Z' : '2099-01-01T12:00:00Z',
          },
          lifecycle: skill ? 'finished' : 'running',
          action: skill ? 'import-results' : 'create-schedule',
          scheduleStartsAt: skill ? null : now,
          pages: skill
            ? []
            : [
                { id: 'vardorvis', name: 'Vardorvis' },
                { id: 'other', name: pageName },
              ],
          pageIds: skill ? [] : (input.pageIds ?? ['vardorvis']),
          participants: [],
          changes: skill
            ? [{ skill: 'attack', before: '100', after: '90', change: '-10' }]
            : [],
          warnings: [],
        },
      });
    }
    if (path === '/api/v1/admin/competitions/imports') {
      applies++;
      expect(request.headers()['x-csrf-token']).toBe('csrf-test');
      expect(request.headers()['idempotency-key']).toBeTruthy();
      return route.fulfill({ json: { outcome: 'applied' } });
    }
    const responses: Record<string, unknown> = {
      '/api/v1/auth/session': { ...f.session, role },
      '/api/v1/settings': {
        revision: 'settings-style',
        clanName: 'Example clan',
        hardcoreEnabled: false,
      },
      '/api/v1/branding': defaultBranding,
      '/api/v1/admin/catalog': f.catalog,
      '/api/v1/admin/schedules': {
        revision: 'schedules-1',
        enabled: false,
        schedules: [],
      },
      '/api/v1/admin/xp/imports': {
        imports: [],
        revision: 'xp-history-1',
        pageCursor: 'xp-first',
        nextCursor: null,
      },
      '/api/v1/xp/tracker': {
        revision: 'xp-style',
        totals: zeroTotals(),
        events: [],
        podium: [],
      },
    };
    return route.fulfill({
      status: path in responses ? 200 : 404,
      json: responses[path] ?? {},
    });
  });
  return {
    attempts: () => attempts,
    applies: () => applies,
    holdFailure() {
      hold = true;
      failNext = true;
    },
    release() {
      hold = false;
      releases.splice(0).forEach((resolve) => resolve());
    },
  };
}

async function open(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByLabel('Wise Old Man competition link')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function styles(page: Page, selector: string) {
  return page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        display: s.display,
        padding: s.padding,
        margin: s.margin,
        border: s.border,
        background: s.backgroundColor,
        color: s.color,
        font: s.font,
        minHeight: s.minHeight,
        minWidth: s.minWidth,
        accentColor: s.accentColor,
      };
    });
}

async function boundedControls(page: Page) {
  const form = page.locator('.competition-import');
  const box = await form.boundingBox();
  const viewportWidth = await page.evaluate(() => innerWidth);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewportWidth);
  for (const control of await form
    .locator('.admin-input, .site-button')
    .all()) {
    const r = await control.boundingBox();
    expect(r!.height).toBeGreaterThanOrEqual(44);
    expect(r!.x).toBeGreaterThanOrEqual(box!.x);
    expect(r!.x + r!.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
  }
  for (const label of await form.locator('.admin-checkbox--touch').all()) {
    expect((await label.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  for (const group of await form.locator('.schedule-page-list').all()) {
    expect(
      await group.evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeLessThanOrEqual(1);
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(viewportWidth);
}

for (const path of paths) {
  test(`moderators import finished SKILL results in ${path}`, async ({
    page,
  }) => {
    const state = await formFixture(page, 'moderator');
    await open(page, path);
    const form = page.locator('.competition-import');
    await form
      .getByLabel('Wise Old Man competition link')
      .fill('https://wiseoldman.net/competitions/124');
    await form
      .getByRole('button', { name: 'Preview competition', exact: true })
      .click();
    await expect(
      page.getByText('Finished SKILL results require the administrator.', {
        exact: false,
      }),
    ).toHaveCount(0);
    await form
      .getByRole('checkbox', {
        name: 'I reviewed the corrections that reduce recorded XP.',
      })
      .check();
    await form.getByRole('button', { name: 'Apply import' }).click();
    await expect(form.getByRole('status')).toHaveText('Competition imported.');
    expect(state.applies()).toBe(1);
  });
}

for (const width of [1100, 320]) {
  test.describe(`${width}px competition form`, () => {
    test.use({ viewport: { width, height: 1100 }, hasTouch: width === 320 });

    test('URL/search fields, labels, fieldsets and correction checkboxes match in both hosts', async ({
      page,
    }) => {
      const state = await formFixture(page);
      const snapshots: unknown[] = [];
      for (const path of paths) {
        await open(page, path);
        const form = page.locator('.competition-import');
        const url = form.getByLabel('Wise Old Man competition link');
        const urlStyle = await styles(
          page,
          '.competition-import input[type="url"]',
        );
        const urlLabel = await styles(
          page,
          '.competition-import .admin-field-label',
        );
        const requiredGroup = await styles(
          page,
          '.competition-import .admin-fieldset',
        );
        await url.fill('https://wiseoldman.net/competitions/123');
        await form
          .getByRole('button', { name: 'Preview competition', exact: true })
          .click();
        await expect(form.getByLabel('Find opening pages')).toBeVisible();
        const openingGroup = await styles(
          page,
          '.competition-import .schedule-page-list',
        );
        const searchStyle = await styles(
          page,
          '.competition-import input[type="search"]',
        );
        const searchLabel = await styles(
          page,
          '.xp-import-preview .admin-field-label',
        );
        const checkbox = await styles(
          page,
          '.competition-import input[type="checkbox"]',
        );
        await boundedControls(page);
        await form.screenshot({
          path: test
            .info()
            .outputPath(
              `competition-${path.endsWith('xp') ? 'xp' : 'scheduling'}-${width}.png`,
            ),
          animations: 'disabled',
          style: '.skip-link:not(:focus) { visibility: hidden; }',
        });
        await url.fill('https://wiseoldman.net/competitions/124');
        await form
          .getByRole('button', { name: 'Preview competition', exact: true })
          .click();
        const correction = form.getByRole('checkbox', {
          name: 'I reviewed the corrections that reduce recorded XP.',
        });
        await expect(correction).toBeVisible();
        await expect(
          form.getByRole('button', { name: 'Apply import' }),
        ).toBeDisabled();
        const correctionStyle = await styles(
          page,
          '.competition-import input[type="checkbox"]',
        );
        if (width === 320) await correction.locator('..').tap();
        else await correction.check();
        await expect(correction).toBeChecked();
        await expect(
          form.getByRole('button', { name: 'Apply import' }),
        ).toBeEnabled();
        await boundedControls(page);
        snapshots.push({
          urlStyle,
          urlLabel,
          requiredGroup,
          searchStyle,
          searchLabel,
          openingGroup,
          checkbox,
          correctionStyle,
        });
      }
      expect(snapshots[0]).toEqual(snapshots[1]);
      expect(state.applies()).toBe(0);
    });

    for (const path of paths) {
      test(`native validation, focus, pending/error/retry and touch controls work in ${path}`, async ({
        page,
      }) => {
        const state = await formFixture(page);
        await open(page, path);
        const form = page.locator('.competition-import');
        const url = form.getByLabel('Wise Old Man competition link');
        const preview = form.getByRole('button', {
          name: 'Preview competition',
          exact: true,
        });
        await expect(url).toHaveAttribute('type', 'url');
        await expect(url).toHaveAttribute('required', '');
        await expect(preview).toBeDisabled();
        await url.fill('not-a-url');
        await preview.click();
        expect(
          await url.evaluate(
            (el) => (el as HTMLInputElement).validity.typeMismatch,
          ),
        ).toBe(true);
        expect(state.attempts()).toBe(0);
        await url.fill('https://wiseoldman.net/competitions/123');
        await preview.focus();
        await page.keyboard.press('Shift+Tab');
        await expect(url).toBeFocused();
        await expect(url).toHaveCSS('outline-width', '2px');
        await expect(url).toHaveCSS('outline-offset', '3px');
        state.holdFailure();
        await preview.click();
        await expect.poll(state.attempts).toBe(1);
        await expect(url).toBeDisabled();
        await expect(
          form.getByRole('button', { name: 'Please wait…' }),
        ).toBeDisabled();
        await boundedControls(page);
        state.release();
        const error = form.getByRole('alert');
        await expect(error).toHaveText('Preview temporarily unavailable.');
        await expect(error).toHaveCSS('color', 'rgb(241, 163, 140)');
        await expect(url).toBeEnabled();
        await preview.click();
        await expect(error).toHaveCount(0);
        const extra = form.getByRole('checkbox', { name: pageName });
        if (width === 320) await extra.locator('..').tap();
        else await extra.check();
        await expect(extra).toBeChecked();
        await expect(
          form.getByRole('button', { name: 'Apply import' }),
        ).toBeDisabled();
        await boundedControls(page);
        const update = form.getByRole('button', { name: 'Update preview' });
        if (width === 320) await update.tap();
        else await update.click();
        await expect(
          form.getByRole('button', { name: 'Apply import' }),
        ).toBeEnabled();
        if (width === 320)
          await form.getByRole('button', { name: 'Apply import' }).tap();
        else await form.getByRole('button', { name: 'Apply import' }).click();
        const success = form.getByRole('status');
        await expect(success).toHaveText('Competition imported.');
        await expect(success).toHaveCSS('color', 'rgb(180, 212, 150)');
        expect(state.applies()).toBe(1);
      });
    }
  });
}
