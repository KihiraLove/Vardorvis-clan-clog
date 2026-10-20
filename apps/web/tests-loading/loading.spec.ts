import { expect, test } from '../tests/test.ts';
import { gzipSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
import { loadingFixtures } from './fixtures.ts';

for (const [route, query] of ['/', '/xp'].flatMap((route) =>
  ['', '?preview=1'].map((query) => [route, query] as const),
)) {
  test(`cached public assets with an unavailable API expose retry only: ${route}${query}`, async ({
    page,
  }) => {
    const scripts: string[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('.js')) scripts.push(request.url());
    });
    await page.route('**/api/v1/**', (route) => route.fulfill({ status: 503 }));
    await page.goto(route + query);
    if (route === '/') {
      await expect(
        page.getByText('Collection log unavailable', { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Try again', exact: true }),
      ).toBeVisible();
    } else {
      await expect(
        page.getByText('XP could not be refreshed. Try again shortly.', {
          exact: false,
        }),
      ).toBeVisible();
    }
    await expect(
      page.getByRole('button', { name: 'Retry XP', exact: true }),
    ).toHaveCount(route === '/xp' ? 1 : 0);
    if (route === '/xp')
      await expect(
        page.getByRole('button', { name: 'Retry XP', exact: true }),
      ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /preview|sample/i }),
    ).toHaveCount(0);
    await expect(page.locator('.item-slot')).toHaveCount(0);
    await expect(page.locator('.event-list button')).toHaveCount(0);
    expect(scripts.some((url) => /runtime-|admin-entry-/u.test(url))).toBe(
      false,
    );
  });
}

test('legacy preview URL still requires a server session before any private read', async ({
  page,
}) => {
  const f = await loadingFixtures(page);
  f.responses['/api/v1/auth/session'] = { authenticated: false };
  await page.goto('/admin/catalog?preview=1');
  await expect(
    page.getByRole('heading', { name: 'Admin sign-in required', exact: true }),
  ).toBeVisible();
  expect(f.calls).toContain('/api/v1/auth/session');
  expect(f.calls.some((path) => path.startsWith('/api/v1/admin/'))).toBe(false);
  await expect(
    page.getByRole('button', { name: /preview|sample/i }),
  ).toHaveCount(0);
});

test('measure initial public JavaScript and cold authenticated deep-link readiness', async ({
  page,
}, info) => {
  const f = await loadingFixtures(page);
  const scripts: { path: string; bytes: number; gzip: number }[] = [];
  const reads: Promise<void>[] = [];
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.endsWith('.js'))
      reads.push(
        (async () => {
          const bytes = await response.body();
          scripts.push({
            path: new URL(response.url()).pathname,
            bytes: bytes.length,
            gzip: gzipSync(bytes).length,
          });
        })(),
      );
  });
  const started = Date.now();
  await page.goto('/');
  await expect(page.getByRole('tab')).toHaveCount(5);
  await expect(
    page.getByRole('status', { name: 'Loading clan XP…' }),
  ).toHaveCount(0);
  await Promise.all(reads);
  const publicReadyMs = Date.now() - started;
  const publicScripts = [...scripts];
  expect(publicScripts.length).toBeGreaterThan(0);
  expect(
    publicScripts.some((script) => /admin-entry-|runtime-/u.test(script.path)),
  ).toBe(false);
  expect(f.calls.some((path) => /\/auth\/|\/admin\//u.test(path))).toBe(false);
  f.delays.set('/api/v1/auth/session', 400);
  f.delays.set('/api/v1/admin/catalog', 400);
  const deepStarted = Date.now();
  await page.goto('/admin/catalog');
  await expect(
    page.getByRole('heading', { name: 'Items catalog', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '+ Add section', exact: true }),
  ).toBeEnabled();
  const coldAdminReadyMs = Date.now() - deepStarted;
  const accountStarted = Date.now();
  await page.getByRole('link', { name: 'Your account', exact: true }).click();
  await expect(
    page.getByLabel('Current password', { exact: true }),
  ).toBeEnabled();
  const warmAccountReadyMs = Date.now() - accountStarted;
  const catalogStarted = Date.now();
  await page.getByRole('link', { name: 'Items catalog', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '+ Add section', exact: true }),
  ).toBeEnabled();
  const warmCatalogReadyMs = Date.now() - catalogStarted;
  const measurement = {
    publicScripts,
    publicBytes: publicScripts.reduce((n, s) => n + s.bytes, 0),
    publicGzipBytes: publicScripts.reduce((n, s) => n + s.gzip, 0),
    publicReadyMs,
    coldAdminReadyMs,
    warmAccountReadyMs,
    warmCatalogReadyMs,
    controlledDelayMs: { session: 400, catalog: 400 },
  };
  await writeFile(
    info.outputPath('loading-measurement.json'),
    JSON.stringify(measurement, null, 2) + '\n',
  );
  console.log('Loading measurement: ' + JSON.stringify(measurement));
});

test('cold staff code and authorized destination reads overlap; completed reads are consumed once', async ({
  page,
}, info) => {
  const f = await loadingFixtures(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let codeFinished = 0;
  await page.route('**/assets/admin-entry-*.js', async (route) => {
    await held;
    codeFinished = Date.now();
    await route.continue();
  });
  const started = Date.now();
  await page.goto('/admin/catalog', { waitUntil: 'domcontentloaded' });
  await expect
    .poll(
      () => f.calls.filter((path) => path === '/api/v1/admin/catalog').length,
    )
    .toBe(1);
  expect(codeFinished).toBe(0);
  await expect(page.getByLabel('Item name', { exact: true })).toHaveCount(0);
  const beforeRelease = Date.now();
  release();
  await expect(
    page.getByRole('heading', { name: 'Items catalog', exact: true }),
  ).toBeVisible();
  expect(
    f.calls.filter((path) => path === '/api/v1/auth/session'),
  ).toHaveLength(1);
  expect(
    f.calls.filter((path) => path === '/api/v1/admin/catalog'),
  ).toHaveLength(1);
  const evidence = {
    started,
    beforeRelease,
    codeFinished,
    ready: Date.now(),
    requests: f.times,
  };
  await writeFile(
    info.outputPath('code-data-overlap.json'),
    JSON.stringify(evidence, null, 2) + '\n',
  );
});

test('cold deep-link read stays cancellable in the staff shell and Retry does not reread the session', async ({
  page,
}) => {
  const f = await loadingFixtures(page);
  const release = f.block('/api/v1/admin/catalog');
  await page.goto('/admin/catalog', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.admin-route-shell')).toBeVisible();
  await expect(page.getByLabel('Item name', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel navigation' }).click();
  await expect(page.getByRole('alert')).toContainText('Loading cancelled');
  release();
  await page.getByRole('button', { name: 'Retry navigation' }).click();
  await expect(
    page.getByRole('heading', { name: 'Items catalog', exact: true }),
  ).toBeVisible();
  expect(
    f.calls.filter((path) => path === '/api/v1/auth/session'),
  ).toHaveLength(1);
  expect(
    f.calls.filter((path) => path === '/api/v1/admin/catalog'),
  ).toHaveLength(2);
});

test('failed cold staff chunk offers document reload and never mounts private forms', async ({
  page,
}) => {
  const f = await loadingFixtures(page);
  let rejected = false;
  await page.route('**/assets/admin-entry-*.js', (route) => {
    if (!rejected) {
      rejected = true;
      return route.abort('failed');
    }
    return route.continue();
  });
  await page.goto('/admin/catalog');
  await expect(page.getByRole('alert')).toContainText(
    'Page code could not be loaded',
  );
  await expect(page.getByLabel('Item name', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Reload page', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Items catalog', exact: true }),
  ).toBeVisible();
  expect(
    f.calls.filter((path) => path === '/api/v1/auth/session').length,
  ).toBeGreaterThanOrEqual(1);
});

test('an anonymous session never starts private reads while staff code is downloading', async ({
  page,
}) => {
  const f = await loadingFixtures(page);
  f.responses['/api/v1/auth/session'] = { authenticated: false };
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/assets/admin-entry-*.js', async (route) => {
    await held;
    await route.continue();
  });
  await page.goto('/admin/catalog', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => f.calls.includes('/api/v1/auth/session')).toBe(true);
  expect(f.calls.some((path) => path.startsWith('/api/v1/admin/'))).toBe(false);
  release();
  await expect(
    page.getByRole('heading', { name: 'Admin sign-in required', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Item name', { exact: true })).toHaveCount(0);
});
