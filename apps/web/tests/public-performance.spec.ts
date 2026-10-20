/** Populated real-render evidence; no API/provider credentials or fixed latency threshold. */
import { expect, test } from './test.ts';
import catalog from './support/catalog.json' with { type: 'json' };
import { defaultBranding } from '../src/branding.ts';
import { zeroTotals } from '../src/xp-model.ts';
test('2,000 activities retain stable dates while idle and suspend public work in a hidden tab', async ({
  page,
}) => {
  const baseline = process.env.PUBLIC_PERF_BASELINE === 'true';
  const now = Date.parse('2026-10-14T12:00:00Z');
  await page.clock.install({ time: new Date(now) });
  await page.addInitScript(() => {
    const state = {
      constructors: 0,
      formats: 0,
      constructorMs: 0,
      formatMs: 0,
      hidden: false,
    };
    Object.assign(window, { projectionPerf: state });
    Object.defineProperty(document, 'visibilityState', {
      get: () => (state.hidden ? 'hidden' : 'visible'),
    });
    const Original = Intl.DateTimeFormat;
    const make = (args: unknown[]) => {
      const start = performance.now(),
        value = Reflect.construct(Original, args) as Intl.DateTimeFormat;
      state.constructors++;
      state.constructorMs += performance.now() - start;
      const format = value.format;
      Object.defineProperty(value, 'format', {
        value: (date: Date | number) => {
          const start = performance.now();
          const text = format(date);
          state.formats++;
          state.formatMs += performance.now() - start;
          return text;
        },
      });
      const formatToParts = value.formatToParts.bind(value);
      Object.defineProperty(value, 'formatToParts', {
        value: (date: Date | number) => {
          const start = performance.now();
          const parts = formatToParts(date);
          state.formats++;
          state.formatMs += performance.now() - start;
          return parts;
        },
      });
      return value;
    };
    Intl.DateTimeFormat = new Proxy(Original, {
      construct: (_target, args) => make(args),
      apply: (_target, _receiver, args) => make(args),
    });
  });
  const competitions = Array.from({ length: 2000 }, (_, n) => ({
    id: n + 1,
    kind: 'ACTIVITY',
    title: 'Activity ' + (n + 1),
    sourceUrl: 'https://wiseoldman.net/competitions/' + (n + 1),
    metrics: ['vardorvis'],
    startsAt: '2026-01-01T00:00:00Z',
    endsAt: '2027-01-01T00:00:00Z',
  }));
  let requests = 0;
  const conditional = new Set<string>();
  const reads: { path: string; etag: string | undefined }[] = [];
  let fail = false;
  await page.route('**/api/v1/**', async (route) => {
    requests++;
    const path = new URL(route.request().url()).pathname;
    reads.push({ path, etag: route.request().headers()['if-none-match'] });
    const headers = {
      ETag: 'W/"fixture-' + path + '"',
      'X-Server-Now': new Date(now).toISOString(),
    };
    if (
      fail &&
      ['/api/v1/settings', '/api/v1/competitions/activities'].includes(path)
    )
      return route.fulfill({ status: 503, json: {} });
    if (route.request().headers()['if-none-match'] === headers.ETag) {
      conditional.add(path);
      return route.fulfill({ status: 304, headers });
    }
    const responses: Record<string, unknown> = {
      '/api/v1/settings': {
        revision: 'settings-1',
        clanName: 'Fixture',
        hardcoreEnabled: true,
      },
      '/api/v1/branding': defaultBranding,
      '/api/v1/branding/hardcore': defaultBranding,
      '/api/v1/auth/session': { authenticated: false },
      '/api/v1/catalog': catalog,
      '/api/v1/collections': { revision: 'collections-1', credits: [] },
      '/api/v1/xp/tracker': {
        revision: 'xp-1',
        totals: zeroTotals(),
        events: [],
        podium: [],
      },
      '/api/v1/competitions/activities': {
        serverNow: new Date(now).toISOString(),
        competitions,
      },
    };
    await route.fulfill({
      status: path in responses ? 200 : 404,
      headers,
      json: responses[path] ?? {},
    });
  });
  const started = Date.now();
  await page.goto('/');
  const rows = page.locator('.activity-competitions li');
  await expect(rows).toHaveCount(2000);
  const loadedMs = Date.now() - started;
  const read = () =>
    page.evaluate(() => ({
      ...(window as unknown as { projectionPerf: Record<string, number> })
        .projectionPerf,
    }));
  const initial = await read();
  expect(initial.formats).toBeGreaterThanOrEqual(4000);
  await page.clock.runFor(3000);
  const idle = await read();
  if (!baseline) {
    expect(idle.formats).toBe(initial.formats);
    expect(idle.constructors).toBe(initial.constructors);
  }
  await page.evaluate(() => {
    (
      window as unknown as { projectionPerf: { hidden: boolean } }
    ).projectionPerf.hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const beforeHidden = requests;
  await page.clock.runFor(baseline ? 3000 : 60000);
  const hidden = await read();
  expect(requests).toBe(beforeHidden);
  if (!baseline) {
    expect(hidden.formats).toBe(idle.formats);
    expect(hidden.constructors).toBe(idle.constructors);
  }
  console.log(
    JSON.stringify({
      activities: 2000,
      loadedMs,
      initial,
      idle,
      hidden,
      hiddenSeconds: baseline ? 3 : 60,
      hiddenRequests: requests - beforeHidden,
    }),
  );
  if (baseline) return;
  await page.evaluate(() => {
    (
      window as unknown as { projectionPerf: { hidden: boolean } }
    ).projectionPerf.hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const collectionResources = [
    '/api/v1/competitions/activities',
    '/api/v1/catalog',
    '/api/v1/collections',
    '/api/v1/settings',
    '/api/v1/branding',
    '/api/v1/branding/hardcore',
  ].sort();
  await expect.poll(() => [...conditional].sort()).toEqual(collectionResources);
  expect([...new Set(reads.map(({ path }) => path))].sort()).toEqual(
    collectionResources,
  );
  const world = page.getByRole('button', {
    name: 'Hardcore worlds',
    exact: true,
  });
  await world.click();
  await expect(world).toHaveAttribute('aria-pressed', 'true');
  fail = true;
  await page.evaluate(() =>
    document.dispatchEvent(new Event('visibilitychange')),
  );
  await expect(
    page.getByRole('alert').filter({ hasText: 'Competitions could not' }),
  ).toBeVisible();
  await expect(rows).toHaveCount(2000);
  await expect(world).toHaveAttribute('aria-pressed', 'true');
  fail = false;
  await page.getByRole('button', { name: 'Retry competitions' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Competitions could not' }),
  ).toHaveCount(0);
  expect((await read()).formats).toBe(initial.formats);
});

test('activity status changes at exact boundaries, catches up on return, and unmount cancels polling', async ({
  page,
}) => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  await page.clock.install({ time: new Date(now) });
  await page.clock.pauseAt(new Date(now));
  await page.addInitScript(() => {
    Object.assign(window, { projectionPerf: { hidden: false } });
    Object.defineProperty(document, 'visibilityState', {
      get: () =>
        (window as unknown as { projectionPerf: { hidden: boolean } })
          .projectionPerf.hidden
          ? 'hidden'
          : 'visible',
    });
  });
  let activityReads = 0;
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/competitions/activities') {
      activityReads++;
      return route.fulfill({
        json: {
          serverNow: new Date(
            await page.evaluate(() => Date.now()),
          ).toISOString(),
          competitions: [
            {
              id: 1,
              kind: 'ACTIVITY',
              title: 'Boundary',
              sourceUrl: 'https://wiseoldman.net/competitions/1',
              metrics: ['vardorvis'],
              startsAt: new Date(now + 1000).toISOString(),
              endsAt: new Date(now + 2000).toISOString(),
            },
          ],
        },
      });
    }
    const responses: Record<string, unknown> = {
      '/api/v1/catalog': catalog,
      '/api/v1/collections': { revision: 'collections-1', credits: [] },
      '/api/v1/settings': {
        revision: 'settings-1',
        clanName: 'Fixture',
        hardcoreEnabled: true,
      },
      '/api/v1/branding': defaultBranding,
      '/api/v1/branding/hardcore': defaultBranding,
      '/api/v1/auth/session': { authenticated: false },
      '/api/v1/xp/tracker': {
        revision: 'xp-1',
        totals: zeroTotals(),
        events: [],
        podium: [],
      },
    };
    return route.fulfill({ json: responses[path] ?? {} });
  });
  await page.goto('/');
  const status = page.locator('.activity-competition');
  await expect(status).toHaveClass(/activity-competition--future/);
  await page.clock.runFor(999);
  await expect(status).toHaveClass(/activity-competition--future/);
  await page.clock.runFor(1);
  await expect(status).toHaveClass(/activity-competition--running/);
  await page.evaluate(() => {
    (
      window as unknown as { projectionPerf: { hidden: boolean } }
    ).projectionPerf.hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const reads = activityReads;
  await page.clock.runFor(1000);
  await expect(status).toHaveClass(/activity-competition--running/);
  expect(activityReads).toBe(reads);
  await page.evaluate(() => {
    (
      window as unknown as { projectionPerf: { hidden: boolean } }
    ).projectionPerf.hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(status).toHaveClass(/activity-competition--finished/);
  await expect.poll(() => activityReads).toBe(reads + 1);
  // Entering staff pages unmounts public polling while retaining the app.
  await page.evaluate(() => {
    history.pushState({}, '', '/admin');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(
    page.getByRole('heading', { name: 'Admin sign-in required', exact: true }),
  ).toBeVisible();
  const stopped = activityReads;
  await page.clock.runFor(60000);
  expect(activityReads).toBe(stopped);
});
