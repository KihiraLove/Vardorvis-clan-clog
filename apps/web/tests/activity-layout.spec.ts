/** REVIEW-03/F01: compare the activity panel to the rendered frame, not a fixed height. */
import { expect, test, type Page } from '@playwright/test';
import catalog from '../src/preview/catalog.json' with { type: 'json' };
import { defaultBranding } from '../src/branding.ts';
import { zeroTotals } from '../src/xp-model.ts';
import { defaultSiteCopy } from '@clog/domain';

test.use({
  timezoneId: 'UTC',
  // Playwright hides all scrollbars by default in headless Chromium.
  launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] },
});
const now = '2026-10-13T12:00:00Z';
const caption =
  'Collected during BOTW events, including the longest competition names and collection captions that wrap across several lines';

function competitions(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    kind: 'ACTIVITY',
    title: `Activity ${i + 1}: ${'LongCompetitionNameWithoutSpaces'.repeat(3)}`,
    sourceUrl: `https://wiseoldman.net/competitions/${i + 1}`,
    metrics: ['vardorvis'],
    startsAt: '2026-10-01T12:00:00Z',
    endsAt: '2026-10-20T12:00:00Z',
  }));
}

async function publicLayout(page: Page, count: number) {
  await page.clock.setFixedTime(new Date(now));
  await page.route('**/api/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/v1/auth/session': { authenticated: false },
      '/api/v1/settings': {
        revision: 'settings-layout',
        clanName: 'Vardorvis',
        hardcoreEnabled: true,
        copy: { ...defaultSiteCopy, collectionCaption: caption },
        hardcore: {
          clanName: 'Hardcore Vardorvis',
          copy: {
            ...defaultSiteCopy,
            collectionCaption: 'Hardcore collection',
          },
        },
      },
      '/api/v1/branding': defaultBranding,
      '/api/v1/branding/hardcore': defaultBranding,
      '/api/v1/catalog': catalog,
      '/api/v1/collections': { revision: 'collections-layout', credits: [] },
      '/api/v1/competitions/activities': {
        serverNow: now,
        competitions: competitions(count),
      },
      '/api/v1/xp/tracker': {
        revision: 'xp-layout',
        totals: zeroTotals(),
        events: [],
        podium: [],
      },
    };
    return route.fulfill({
      status: path in responses ? 200 : 404,
      json: responses[path] ?? { error: 'Unmocked layout route' },
    });
  });
}

async function geometry(page: Page) {
  // Preview is a deferred entry; measure only after its actual layout exists.
  await expect(page.locator('.activity-competitions ol')).toBeAttached();
  return page.evaluate(() => {
    const box = (selector: string) => {
      const r = document.querySelector(selector)!.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height };
    };
    const list = document.querySelector<HTMLOListElement>(
      '.activity-competitions ol',
    )!;
    return {
      caption: box('.log-help'),
      panel: box('.activity-competitions'),
      frame: box('.log-sizing'),
      list: box('.activity-competitions ol'),
      scrollHeight: list.scrollHeight,
      clientHeight: list.clientHeight,
    };
  });
}

async function aligned(page: Page) {
  await expect
    .poll(async () => {
      const r = await geometry(page);
      return Math.max(
        Math.abs(r.panel.top - r.frame.top),
        Math.abs(r.panel.bottom - r.frame.bottom),
      );
    })
    .toBeLessThanOrEqual(1);
  const r = await geometry(page);
  expect(r.caption.bottom).toBeLessThan(r.frame.top);
  expect(r.list.bottom).toBeLessThan(r.panel.bottom);
  expect(r.list.height).toBeGreaterThan(0);
  return r;
}

for (const width of [1440, 1100]) {
  for (const count of [0, 2, 24]) {
    test(`activity panel aligns with the frame at ${width}px with ${count} competitions in both world modes`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1100 });
      await publicLayout(page, count);
      await page.goto('/');
      const panel = page.getByRole('complementary', {
        name: 'Activity competitions',
      });
      await expect(panel.locator('li')).toHaveCount(count);
      await expect(page.locator('.log-help')).toHaveText(caption);
      await page.evaluate(() => document.fonts.ready);
      for (const mode of ['normal', 'hardcore']) {
        if (mode === 'hardcore') {
          await page
            .getByRole('button', { name: 'Hardcore worlds', exact: true })
            .click();
          await expect(page.locator('.log-help')).toContainText(
            'Hardcore collection',
          );
        }
        const r = await aligned(page);
        if (count === 24)
          expect(r.scrollHeight).toBeGreaterThan(r.clientHeight);
        else if (count === 0)
          expect(r.scrollHeight).toBeLessThanOrEqual(r.clientHeight);
        if (count === 0)
          await expect(panel).toContainText('No activity competitions yet.');
        if (count === 24) {
          await page.locator('.public-log-layout').screenshot({
            path: test.info().outputPath(`activity-${width}-${mode}.png`),
            animations: 'disabled',
          });
        }
      }
      if (count === 24) {
        const links = panel.getByRole('link');
        await links.first().focus();
        for (let i = 1; i < count; i++) await page.keyboard.press('Tab');
        await expect(links.last()).toBeFocused();
        expect(
          await panel.locator('ol').evaluate((el) => el.scrollTop),
        ).toBeGreaterThan(0);
        const last = await links.last().boundingBox();
        const list = await panel.locator('ol').boundingBox();
        expect(last!.y).toBeGreaterThanOrEqual(list!.y);
        expect(last!.y + last!.height).toBeLessThanOrEqual(
          list!.y + list!.height + 1,
        );
        await aligned(page);
      }
    });
  }
}

test.describe('touch mobile layout', () => {
  test.use({ hasTouch: true });
  for (const count of [0, 2, 24]) {
    test(`activity list stacks naturally at 320px with ${count} competitions and touch links`, async ({
      page,
      context,
    }) => {
      await page.setViewportSize({ width: 320, height: 850 });
      await publicLayout(page, count);
      await context.route('https://wiseoldman.net/**', (r) =>
        r.fulfill({
          contentType: 'text/html',
          body: '<h1>Competition fixture</h1>',
        }),
      );
      await page.goto('/');
      const panel = page.getByRole('complementary', {
        name: 'Activity competitions',
      });
      await expect(panel.locator('li')).toHaveCount(count);
      await page.evaluate(() => document.fonts.ready);
      for (const mode of ['normal', 'hardcore']) {
        if (mode === 'hardcore')
          await page
            .getByRole('button', { name: 'Hardcore worlds', exact: true })
            .tap();
        const r = await geometry(page);
        expect(r.caption.bottom).toBeLessThan(r.panel.top);
        expect(r.panel.bottom).toBeLessThan(r.frame.top);
        expect(r.panel.height).toBeLessThan(r.frame.height);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBeLessThanOrEqual(320);
        if (count === 24)
          await page.screenshot({
            path: test.info().outputPath(`activity-320-${mode}.png`),
            fullPage: true,
            animations: 'disabled',
          });
      }
      if (count > 0) {
        const link = panel.getByRole('link').last();
        await link.scrollIntoViewIfNeeded();
        expect(
          await panel.locator('ol').evaluate((el) => el.scrollLeft),
        ).toBeGreaterThan(0);
        const [popup] = await Promise.all([
          page.waitForEvent('popup'),
          link.tap(),
        ]);
        await popup.waitForLoadState('domcontentloaded');
        expect(popup.url()).toBe('https://wiseoldman.net/competitions/1');
        await popup.close();
      }
    });
  }
});

test('alignment follows delayed font loading, responsive resizing and a resized log frame', async ({
  page,
}) => {
  await publicLayout(page, 24);
  let releaseFont!: () => void;
  const fontReady = new Promise<void>((resolve) => {
    releaseFont = resolve;
  });
  await page.route('**/fonts/runescape.ttf', async (r) => {
    await fontReady;
    await r.continue();
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.activity-competitions li')).toHaveCount(24);
  await aligned(page);
  releaseFont();
  await page.evaluate(() => document.fonts.ready);
  await aligned(page);
  await page.setViewportSize({ width: 1100, height: 1100 });
  await page.addStyleTag({
    content: `
      .log-viewport { scrollbar-color: auto; scrollbar-width: auto; }
      .log-viewport::-webkit-scrollbar { height: 15px; }
      .log-viewport::-webkit-scrollbar-thumb { background: #706247; }
    `,
  });
  await expect
    .poll(() =>
      page.locator('.log-viewport').evaluate((el) => {
        const viewport = el as HTMLElement;
        return viewport.offsetHeight - viewport.clientHeight;
      }),
    )
    .toBe(15);
  await aligned(page);
  // The panel must follow actual frame geometry if the renderer's scale changes.
  await page.locator('.public-log-layout').evaluate((el) => {
    (el as HTMLElement).style.setProperty('--log-scale', '1.5');
  });
  expect((await aligned(page)).panel.height).toBe(471);
  await page.setViewportSize({ width: 320, height: 850 });
  const mobile = await geometry(page);
  expect(mobile.panel.bottom).toBeLessThan(mobile.frame.top);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await aligned(page);
});

test('preview controls occupy their own row above the aligned frame and panel', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/?preview=1');
  await page.evaluate(() => document.fonts.ready);
  const initial = await aligned(page);
  await page
    .getByText('Frontend preview · sample data', { exact: true })
    .click();
  await expect(page.getByLabel('Review scenario')).toBeVisible();
  const expanded = await aligned(page);
  expect(expanded.frame.top).toBeGreaterThan(initial.frame.top);
});

test('loading, failure and retry leave the activity panel aligned with the log frame', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await publicLayout(page, 24);
  let releaseActivities!: () => void;
  const responseReady = new Promise<void>((resolve) => {
    releaseActivities = resolve;
  });
  let attempts = 0;
  await page.route('**/api/v1/competitions/activities', async (r) => {
    if (++attempts > 1) return r.fallback();
    await responseReady;
    return r.fulfill({ status: 503, json: { error: 'Fixture unavailable' } });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const panel = page.getByRole('complementary', {
    name: 'Activity competitions',
  });
  await expect(panel.getByRole('status')).toHaveText('Loading competitions…');
  await aligned(page);
  releaseActivities();
  await expect(panel.getByRole('alert')).toContainText(
    'Competitions could not be refreshed.',
  );
  const failed = await aligned(page);
  await panel.getByRole('button', { name: 'Retry competitions' }).click();
  await expect(panel.locator('li')).toHaveCount(24);
  const retried = await aligned(page);
  expect(retried.panel.height).toBe(failed.panel.height);
  expect(retried.scrollHeight).toBeGreaterThan(retried.clientHeight);
});
