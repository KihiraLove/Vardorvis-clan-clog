import { mockApi } from '../tests/mock-api.ts';
/** Actual production Nginx/assets; staff API fixtures isolate CSP from auth (#103). */
import { expect, test, type Page } from '../tests/test.ts';
import { createServer } from 'node:http';
import sharp from 'sharp';
import { loadingFixtures } from '../tests-loading/fixtures.ts';
import { adminFixtures } from '../tests/admin-fixtures.ts';
import { forward } from './proxy.mjs';

const policy =
  "default-src 'none'; script-src 'self'; script-src-attr 'none'; style-src 'self'; style-src-attr 'none'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
async function watch(page: Page) {
  const violations: string[] = [],
    errors: string[] = [];
  await page.exposeFunction('recordSecurityViolation', (directive: string) =>
    violations.push(directive),
  );
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      void (
        window as unknown as {
          recordSecurityViolation: (value: string) => Promise<void>;
        }
      ).recordSecurityViolation(event.effectiveDirective);
    });
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return {
    violations,
    clean: () => {
      expect(violations).toEqual([]);
      expect(errors).toEqual([]);
    },
  };
}
function headers(value: Record<string, string>) {
  expect(value['content-security-policy']).toBe(policy);
  expect(value['content-security-policy-report-only']).toBeUndefined();
  expect(value['x-frame-options']).toBe('DENY');
  expect(value['x-content-type-options']).toBe('nosniff');
  expect(value['referrer-policy']).toBe('no-referrer');
}

test('proxy sends the enforced policy on HTML, assets, API, conditional and error responses', async ({
  request,
}) => {
  for (const path of [
    '/',
    '/admin/catalog',
    '/?preview=1',
    '/healthz',
    '/readyz',
    '/fonts/runescape.ttf',
    '/brand/clan-logo.png',
    '/api/v1/catalog',
  ]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    headers(response.headers());
  }
  const html = await (await request.get('/')).text();
  const script = /src="([^"]+\.js)"/u.exec(html)![1]!;
  const css = /href="([^"]+\.css)"/u.exec(html)![1]!;
  for (const path of [script, css]) {
    const response = await request.get(path);
    headers(response.headers());
    expect(response.status()).toBe(200);
    const unchanged = await request.get(path, {
      headers: { 'If-None-Match': response.headers().etag! },
    });
    expect(unchanged.status()).toBe(304);
    headers(unchanged.headers());
  }
  for (const [path, status] of [
    ['/api/v1/admin/settings', 401],
    ['/api/v1/not-a-route', 404],
  ] as const) {
    const response = await request.get(path);
    expect(response.status()).toBe(status);
    headers(response.headers());
    if (status === 401)
      expect(response.headers()['cache-control']).toBe('no-store');
  }
  const malformed = await request.post('/api/v1/auth/login', {
    data: {},
    headers: { Origin: 'https://clog.example.com' },
  });
  expect(malformed.status()).toBe(400);
  headers(malformed.headers());
  expect(malformed.headers()['cache-control']).toBe('no-store');
  // Exercise the actual Nginx body rejection, without an extra test relay that
  // can close its client connection while an early 413 is still being uploaded.
  const oversized = await request.post(
    'http://app:8080/api/v1/admin/catalog/icons',
    {
      data: Buffer.alloc(3 * 1024 * 1024 + 1),
    },
  );
  expect(oversized.status()).toBe(413);
  expect(oversized.headers()['content-type']).toContain('text/html');
  headers(oversized.headers());
});

test('live public resources, fonts and CSSOM scaling work under the enforced policy', async ({
  page,
}) => {
  const audit = await watch(page);
  await page.goto('/');
  await expect(page.getByRole('tab')).toHaveCount(5);
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(() => document.fonts.check('17px RuneScape')),
  ).toBe(true);
  const item = page.locator('.item-slot').first();
  await expect(item.locator('img')).toBeVisible();
  expect(
    await item
      .locator('img')
      .evaluate(
        (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
      ),
  ).toBe(true);
  expect(
    await page
      .locator('[style*="--log-scale"]')
      .evaluate((element) =>
        getComputedStyle(element).getPropertyValue('--log-scale').trim(),
      ),
  ).toBe('2');
  audit.clean();
});

for (const width of [1100, 320]) {
  test(`ordinary/hardcore, WOM navigation and stored animated logos at ${width}px`, async ({
    page,
    context,
  }) => {
    const audit = await watch(page);
    await page.setViewportSize({ width, height: 850 });
    await mockApi(page, { scenario: 'hardcore' });
    await page.goto('/admin/settings/hardcore');
    await page
      .getByRole('switch', { name: 'Enable hardcore worlds', exact: true })
      .click();
    await expect(
      page.getByRole('switch', { name: 'Enable hardcore worlds', exact: true }),
    ).toBeChecked();
    await page.locator('.clan-brand').click();
    await expect(page.getByRole('tab')).toHaveCount(5);

    await page
      .getByRole('button', { name: 'Hardcore worlds', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Hardcore worlds', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await page.locator('.item-slot--collected').first().click();
    await expect(page.getByRole('tooltip')).toBeVisible();
    const position = await page.getByRole('tooltip').boundingBox();
    expect(position!.x).toBeGreaterThanOrEqual(8);
    expect(position!.y).toBeGreaterThanOrEqual(8);
    expect(position!.x + position!.width).toBeLessThanOrEqual(width - 7);
    await page.keyboard.press('Escape');
    // Only the outgoing document is stubbed: no request reaches WOM.
    await context.route('https://wiseoldman.net/competitions/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<title>WOM destination</title>',
      }),
    );
    const link = page
      .locator('a[href^="https://wiseoldman.net/competitions/"]')
      .first();
    await expect(link).toHaveAttribute('rel', /noopener/u);
    const popup = context.waitForEvent('page');
    await link.click();
    const destination = await popup;
    await expect(destination).toHaveTitle('WOM destination');
    expect(await destination.evaluate(() => window.opener === null)).toBe(true);
    await destination.close();
    await mockApi(page);
    await page.goto('/admin/settings');
    const buffer = await sharp(Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]), {
      raw: { width: 1, height: 2, pageHeight: 1, channels: 4 },
    })
      .webp({ lossless: true, delay: [120, 230] })
      .toBuffer();
    await page
      .getByLabel('Logo image', { exact: true })
      .setInputFiles({ name: 'animated.webp', mimeType: 'image/webp', buffer });
    await page
      .getByRole('button', { name: 'Save clan logo', exact: true })
      .click();
    await expect(
      page.getByText('Clan logo and website icon saved.'),
    ).toBeVisible();
    const logo = page.locator('.clan-logo').first();
    await expect(logo).toHaveAttribute('src', /\/api\/v1\/branding\//u);
    await expect
      .poll(() =>
        logo.evaluate(
          (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
        ),
      )
      .toBe(true);
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
      'href',
      /\/api\/v1\/branding\//u,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.getByRole('heading', { name: 'Clan logo', exact: true }).click();
    await page.screenshot({
      path: test.info().outputPath(`csp-proof-${width}.png`),
      fullPage: true,
    });
    audit.clean();
  });
}

test('staff chunks, local icon previews and same-origin private image rendering need no policy exception', async ({
  page,
}) => {
  const audit = await watch(page);
  const f = await loadingFixtures(page);
  await page.goto('/admin/catalog');
  await page.getByRole('button', { name: '+ Add item', exact: true }).click();
  await page.getByRole('button', { name: 'Add new item', exact: true }).click();
  await expect(page.getByLabel('Item name', { exact: true })).toBeEnabled();
  const png = await sharp({
    create: { width: 16, height: 16, channels: 4, background: 'red' },
  })
    .png()
    .toBuffer();
  await page
    .getByLabel('Item icon (required)', { exact: true })
    .setInputFiles({ name: 'icon.png', mimeType: 'image/png', buffer: png });
  const icon = page.getByAltText('New item icon preview');
  await expect(icon).toHaveAttribute('src', /^blob:/u);
  await expect
    .poll(() =>
      icon.evaluate(
        (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
      ),
    )
    .toBe(true);
  const detail = (await adminFixtures()).detail;
  detail.submission.screenshotPath =
    '/api/v1/admin/submission-images/00000000-0000-4000-8000-000000000001.png';
  f.responses['/api/v1/admin/submissions/sample-hardcore'] = detail;
  f.responses['/api/v1/admin/submissions'] = {
    ...(f.responses['/api/v1/admin/submissions'] as object),
    submissions: [detail.submission],
  };
  await page.route('**/api/v1/admin/submission-images/*.png', (route) =>
    route.fulfill({ contentType: 'image/png', body: png }),
  );
  await page
    .getByLabel('Item icon (required)', { exact: true })
    .setInputFiles([]);
  await page.goto('/admin');
  await page.getByRole('button', { name: /^Review /u }).click();
  const proof = page
    .locator('.submission-editor')
    .getByAltText('Submission screenshot');
  await expect(proof).toBeVisible();
  await expect
    .poll(() =>
      proof.evaluate(
        (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
      ),
    )
    .toBe(true);
  audit.clean();
});

test('a failed public read can show its error and recover without CSP violations', async ({
  page,
}) => {
  const audit = await watch(page);
  await loadingFixtures(page);
  let fail = true;
  await page.route('**/api/v1/catalog', (route) => {
    if (fail) {
      fail = false;
      return route.fulfill({
        status: 503,
        json: { error: 'Disposable read failure' },
      });
    }
    return route.fallback();
  });
  await page.goto('/');
  await expect(
    page.getByText('Collection log unavailable', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(5);
  await expect(page.locator('.item-slot').first()).toBeVisible();
  audit.clean();
});

test('stored PNG evidence renders under enforcement', async ({ page }) => {
  const audit = await watch(page);
  await mockApi(page);
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Add manual submission' }).click();
  const form = page
    .locator('form')
    .filter({ has: page.getByLabel('Collector name', { exact: true }) });
  await form.getByLabel('Canonical item').selectOption({ index: 1 });
  await form
    .getByLabel('Collector name', { exact: true })
    .fill('CSP PNG evidence');
  const png = await sharp({
    create: { width: 16, height: 16, channels: 4, background: 'blue' },
  })
    .png()
    .toBuffer();
  await form
    .getByLabel('PNG screenshot (optional)')
    .setInputFiles({ name: 'proof.png', mimeType: 'image/png', buffer: png });
  await form.getByLabel('Approve immediately').uncheck();
  await form.getByRole('button', { name: 'Create manual submission' }).click();
  await page.getByRole('button', { name: /^Review CSP PNG evidence/u }).click();
  const proof = page
    .locator('.submission-editor')
    .getByAltText('Submission screenshot');
  await expect(proof).toHaveAttribute(
    'src',
    /^\/api\/v1\/admin\/submission-images\//u,
  );
  await expect
    .poll(() =>
      proof.evaluate(
        (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
      ),
    )
    .toBe(true);
  audit.clean();
});

test('policy blocks injected scripts/styles, foreign resources, frames and base changes', async ({
  page,
}) => {
  const audit = await watch(page);
  await page.goto('/');
  await expect(page.getByRole('tab')).toHaveCount(5);
  const outgoing: string[] = [];
  await page.route('https://blocked.invalid/**', (route) => {
    outgoing.push(route.request().url());
    return route.abort();
  });
  await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = "document.documentElement.dataset.injected = 'yes'";
    document.head.append(script);
    const handler = document.createElement('button');
    handler.setAttribute(
      'onclick',
      "document.documentElement.dataset.injected = 'yes'",
    );
    document.body.append(handler);
    handler.click();
    const remote = document.createElement('script');
    remote.src = 'https://blocked.invalid/script.js';
    document.head.append(remote);
    const style = document.createElement('style');
    style.textContent = 'body { display: none }';
    document.head.append(style);
    document.body.setAttribute('style', 'display:none');
    const image = new Image();
    image.src = 'https://blocked.invalid/image.png';
    document.body.append(image);
    const frame = document.createElement('iframe');
    frame.src = '/';
    document.body.append(frame);
    const base = document.createElement('base');
    base.href = 'https://blocked.invalid/';
    document.head.append(base);
    void fetch('https://blocked.invalid/read').catch(() => {});
    const form = document.createElement('form');
    form.action = 'https://blocked.invalid/submit';
    form.method = 'POST';
    document.body.append(form);
    form.submit();
  });
  await expect
    .poll(() => [...new Set(audit.violations)].sort())
    .toEqual([
      'base-uri',
      'connect-src',
      'form-action',
      'frame-src',
      'img-src',
      'script-src-attr',
      'script-src-elem',
      'style-src-attr',
      'style-src-elem',
    ]);
  expect(
    await page.evaluate(() => ({
      injected: document.documentElement.dataset.injected,
      display: getComputedStyle(document.body).display,
      base: document.baseURI,
    })),
  ).toEqual({
    injected: undefined,
    display: 'block',
    base: 'http://127.0.0.1:5191/',
  });
  expect(outgoing).toEqual([]);
});

for (const sameOrigin of [true, false]) {
  test(`production document refuses ${sameOrigin ? 'same-origin' : 'foreign'} embedding`, async ({
    page,
  }) => {
    const body = `<iframe src="${sameOrigin ? '/' : 'http://127.0.0.1:5191/'}" title="embedded clan"></iframe>`;
    const parent = createServer((_request, response) => {
      if (_request.url !== '/embedding-parent')
        return forward(_request, response);
      response.setHeader('Content-Type', 'text/html');
      response.end(body);
    });
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await new Promise<void>((resolve) =>
      parent.listen(0, '127.0.0.1', resolve),
    );
    try {
      const address = parent.address() as { port: number };
      const child = sameOrigin
        ? `http://127.0.0.1:${address.port}/`
        : 'http://127.0.0.1:5191/';
      const requested = page.waitForRequest(child);
      const response = await page.goto(
        `http://127.0.0.1:${address.port}/embedding-parent`,
      );
      expect(response!.headers()['content-security-policy']).toBeUndefined();
      await requested;
      await expect
        .poll(() =>
          errors.some((error) =>
            /frame-ancestors|X-Frame-Options/u.test(error),
          ),
        )
        .toBe(true);
      expect(
        await page.frameLocator('iframe').locator('.site-shell').count(),
      ).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        parent.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
}
