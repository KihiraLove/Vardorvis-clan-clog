/** No API response fixtures: real TLS/cookies → production Nginx/API → disposable PG. */
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import sharp from 'sharp';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const origin = 'https://clog.example.com';
const password = 'ci-only-test-admin-password'; // Set by review-smoke in this disposable stack only.
const editor = (page: Page) => page.locator('.submission-editor');
async function login(page: Page, username = 'admin', secret = password) {
  await page.goto('/admin');
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(secret);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
async function owner(page: Page) {
  await login(page);
  await expect(
    page.getByRole('heading', { name: 'Submissions', exact: true }),
  ).toBeVisible();
}
async function database<T>(
  query: string,
  values: unknown[] = [],
): Promise<T[]> {
  if (
    !/^clog-checks-[a-z0-9-]+$/u.test(process.env.COMPOSE_PROJECT_NAME ?? '') ||
    !process.env.POSTGRES_PASSWORD
  )
    throw new Error('Disposable database required');
  const client = new pg.Client({
    host: 'db',
    user: 'clog',
    password: process.env.POSTGRES_PASSWORD,
    database: 'clog',
  });
  await client.connect();
  try {
    return (await client.query(query, values)).rows;
  } finally {
    await client.end();
  }
}
async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  if (test.info().project.name === 'webkit') {
    // Playwright's WebKit raster capture unconditionally toggles an inline "body {}"
    // stylesheet. Keep CSP fully enforced and preserve an accessible snapshot instead.
    await writeFile(
      test.info().outputPath(name.replace(/\.png$/u, '.aria.yml')),
      await page.locator('body').ariaSnapshot(),
    );
    return;
  }
  await page.screenshot({
    path: test.info().outputPath(name),
    fullPage: true,
    // Avoid injecting screenshot-only CSS, which WebKit correctly rejects under CSP.
    animations: 'allow',
    caret: 'initial',
  });
}
test.beforeEach(async ({ page, browser, browserName }, info) => {
  await writeFile(
    info.outputPath('browser-environment.json'),
    JSON.stringify(
      {
        engine: browserName,
        version: browser.version(),
        platform: process.platform,
        origin,
        viewport: info.project.use.viewport,
      },
      null,
      2,
    ),
  );
  const violations: string[] = [],
    errors: string[] = [];
  await page.exposeFunction('recordStackViolation', (value: string) =>
    violations.push(value),
  );
  await page.addInitScript(() =>
    document.addEventListener('securitypolicyviolation', (event) => {
      void (
        window as unknown as {
          recordStackViolation: (value: string) => Promise<void>;
        }
      ).recordStackViolation(event.effectiveDirective);
    }),
  );
  page.on('pageerror', (error) => errors.push(error.message));
  await page.exposeFunction('stackAudit', () => ({ violations, errors }));
});
test.afterEach(async ({ page }) => {
  if (!page.isClosed())
    expect(
      await page.evaluate(() =>
        (
          window as unknown as { stackAudit: () => Promise<unknown> }
        ).stackAudit(),
      ),
    ).toEqual({ violations: [], errors: [] });
});

test('GitHub Pages tester can preflight and read authenticated intake errors across origins', async ({
  page,
  context,
  browserName,
}) => {
  // Only the tester document is local test HTML; OPTIONS/POST reach production Nginx/API.
  // This disposable target is loopback; grant that permission without bypassing CORS.
  if (browserName === 'chromium')
    await context.grantPermissions(['local-network-access'], {
      origin: 'https://kihiralove.github.io',
    });
  await page.route('https://kihiralove.github.io/clog-test', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>RuneLite browser tester</title>',
    }),
  );
  await page.goto('https://kihiralove.github.io/clog-test');
  const response = await page.evaluate(async () => {
    const body = new FormData();
    body.set('username', 'Browser tester');
    const result = await fetch(
      'https://clog.example.com/api/v1/runelite/submissions',
      {
        method: 'POST',
        headers: {
          'Idempotency-Key': crypto.randomUUID(),
          'X-Clan-API-Key': 'deliberately-invalid-key',
        },
        body,
        credentials: 'omit',
      },
    );
    return {
      status: result.status,
      body: await result.json(),
      category: result.headers.get('X-Error-Category'),
    };
  });
  expect(response.status).toBe(401);
  expect(response.body.error).toBeTruthy();
  expect(response.category).toBeTruthy();
});

test('real login, PNG claim, independent note/correction, canonical public credit and audited revoke', async ({
  page,
  context,
  browser,
  browserName,
}) => {
  await owner(page);
  const cookie = (await context.cookies()).find(
    (value) => value.name === '__Host-clog-session',
  );
  expect(
    cookie
      ? {
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          sameSite: cookie.sameSite,
          domain: cookie.domain,
          path: cookie.path,
        }
      : null,
  ).toEqual({
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
    domain: 'clog.example.com',
    path: '/',
  });
  expect(
    await page.evaluate(() => document.cookie.includes('__Host-clog-session')),
  ).toBe(false);
  const catalog = await (await page.request.get('/api/v1/catalog')).json();
  const mask = catalog.items.find(
    (item: { name: string }) => item.name === 'Virtus mask',
  );
  expect(
    catalog.pages.filter((entry: { itemIds: number[] }) =>
      entry.itemIds.includes(mask.id),
    ).length,
  ).toBeGreaterThan(1);
  const collector = `Browser ${browserName}`,
    corrected = `${collector} corrected`,
    note = `Private ${browserName} evidence note`;
  await page.getByRole('button', { name: 'Add manual submission' }).click();
  const form = page
    .locator('form')
    .filter({ has: page.getByLabel('Collector name', { exact: true }) });
  await form.getByLabel('Search catalog items').fill('Virtus mask');
  await form
    .getByLabel('Canonical item', { exact: true })
    .selectOption(String(mask.id));
  await form.getByLabel('Collector name', { exact: true }).fill(collector);
  await form.getByLabel('Collection date', { exact: true }).fill('2026-10-01');
  const png = await sharp({
    create: { width: 32, height: 32, channels: 4, background: 'blue' },
  })
    .png()
    .toBuffer();
  await form.getByLabel('PNG screenshot (optional)').setInputFiles({
    name: 'evidence.png',
    mimeType: 'image/png',
    buffer: png,
  });
  await form
    .getByLabel('Approve immediately and show in the collection log')
    .uncheck();
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/admin/submissions/upload') &&
      response.request().method() === 'POST',
  );
  await form.getByRole('button', { name: 'Create manual submission' }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const claim = await response.json();
  await page
    .getByRole('button', { name: new RegExp(`^Review ${collector} ·`, 'u') })
    .click();
  await expect(
    editor(page).getByAltText('Submission screenshot'),
  ).toBeVisible();
  const proof = await page.request.get(claim.screenshotPath);
  expect(proof.status()).toBe(200);
  expect(proof.headers()['cache-control']).toBe('private, no-store');
  await editor(page).getByLabel('Review note').fill(note);
  await editor(page)
    .getByLabel('Collector name', { exact: true })
    .fill(corrected);
  await editor(page)
    .getByRole('button', { name: 'Save review note', exact: true })
    .click();
  await expect(
    editor(page).getByText('Review note saved.', { exact: true }),
  ).toBeVisible();
  const noted = await (
    await page.request.get(`/api/v1/admin/submissions/${claim.id}`)
  ).json();
  expect(noted.submission).toMatchObject({
    reviewNote: note,
    collectorName: collector,
    status: 'pending',
    version: 2,
  });
  await editor(page)
    .getByRole('button', { name: 'Save corrections', exact: true })
    .click();
  await expect(
    editor(page).getByLabel('Collector name', { exact: true }),
  ).toHaveValue(corrected);
  await expect(
    editor(page).getByRole('button', { name: 'Save corrections', exact: true }),
  ).toBeDisabled();
  await editor(page)
    .getByLabel(/^I verified this manual claim/u)
    .check();
  await capture(page, 'real-review-desktop.png');
  await editor(page)
    .getByRole('button', { name: 'Approve submission', exact: true })
    .click();
  await expect(
    page.getByText('Saved submission state: approved.', {
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await database(
      'SELECT status, collector_name, review_note, version FROM submissions WHERE id=$1',
      [claim.id],
    ),
  ).toEqual([
    {
      status: 'approved',
      collector_name: corrected,
      review_note: note,
      version: 4,
    },
  ]);

  const anonymous = await browser.newContext({
    baseURL: origin,
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
    hasTouch: browserName !== 'firefox',
    timezoneId: 'UTC',
  });
  try {
    expect((await anonymous.request.get(claim.screenshotPath)).status()).toBe(
      401,
    );
    const publicResult = await (
      await anonymous.request.get('/api/v1/collections')
    ).json();
    expect(Object.keys(publicResult).sort()).toEqual(['credits', 'revision']);
    const credits = publicResult.credits.filter(
      (credit: { itemId: number }) => credit.itemId === mask.id,
    );
    expect(credits).toHaveLength(1);
    expect(JSON.stringify(publicResult)).not.toContain(note);
    for (const forbidden of [
      'proofUrl',
      'screenshotPath',
      'reviewNote',
      'reviewReason',
      'actorName',
    ])
      expect(JSON.stringify(publicResult)).not.toContain(`"${forbidden}"`);
    const publicPage = await anonymous.newPage();
    await publicPage.goto('/');
    for (const name of ['Vardorvis', 'Duke Sucellus']) {
      await publicPage.getByRole('button', { name, exact: true }).click();
      const item = publicPage.getByRole('button', {
        name: 'Virtus mask: collected',
        exact: true,
      });
      await item.click();
      await expect(publicPage.getByRole('tooltip')).toContainText(corrected);
      await publicPage.keyboard.press('Escape');
    }
    await publicPage
      .getByRole('button', { name: 'Vardorvis', exact: true })
      .click();
    await expect(
      publicPage.getByRole('heading', { name: /Collection Log - 1\/1717/u }),
    ).toBeVisible();
    await capture(publicPage, 'real-public-desktop.png');
    await publicPage.setViewportSize({ width: 320, height: 850 });
    const item = publicPage.getByRole('button', {
      name: 'Virtus mask: collected',
      exact: true,
    });
    if (browserName === 'firefox') {
      await item.focus();
      await publicPage.keyboard.press('Enter');
    } else await item.tap();
    await expect(publicPage.getByRole('tooltip')).toContainText(corrected);
    const box = await publicPage.getByRole('tooltip').boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(8);
    expect(box!.x + box!.width).toBeLessThanOrEqual(313);
    expect(
      await publicPage.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(320);
    await publicPage.keyboard.press('Escape');
    await capture(publicPage, 'real-public-320.png');
    await editor(page)
      .getByLabel('Review reason')
      .fill('Browser acceptance: evidence withdrawn');
    await editor(page)
      .getByRole('button', { name: 'Revoke credit', exact: true })
      .click();
    await expect(
      page.getByText('Saved submission state: revoked.', {
        exact: true,
      }),
    ).toBeVisible();
    await publicPage.reload();
    await expect(
      publicPage.getByRole('button', {
        name: 'Virtus mask: not collected',
        exact: true,
      }),
    ).toBeVisible();
    await publicPage
      .getByRole('button', { name: 'Duke Sucellus', exact: true })
      .click();
    await expect(
      publicPage.getByRole('button', {
        name: 'Virtus mask: not collected',
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await database(
        'SELECT status, version, review_note FROM submissions WHERE id=$1',
        [claim.id],
      ),
    ).toEqual([{ status: 'revoked', version: 5, review_note: note }]);
    expect(
      (
        await database<{ action: string }>(
          'SELECT action FROM audit_events WHERE submission_id=$1 ORDER BY id',
          [claim.id],
        )
      ).map((row) => row.action),
    ).toEqual(['create', 'edit', 'edit', 'approve', 'revoke']);
  } finally {
    await anonymous.close();
  }
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Admin sign-in required', exact: true }),
  ).toBeVisible();
  expect((await page.request.get(claim.screenshotPath)).status()).toBe(401);
});

test('real moderator setup, role denial and server-side access revocation clear private drafts', async ({
  page,
  browser,
  browserName,
}) => {
  await owner(page);
  const username = `browser_${browserName}`;
  await page
    .getByRole('link', { name: 'Moderator accounts', exact: true })
    .click();
  await page.getByLabel('Moderator username', { exact: true }).fill(username);
  await page
    .getByLabel('Temporary password', { exact: true })
    .fill('temporary-browser-password');
  await page
    .getByRole('button', { name: 'Create moderator', exact: true })
    .click();
  await expect(
    page.getByText(`Moderator ${username} created.`, { exact: true }),
  ).toBeVisible();
  const moderator = await browser.newContext({
    baseURL: origin,
    ignoreHTTPSErrors: true,
  });
  try {
    const staff = await moderator.newPage();
    await login(staff, username, 'temporary-browser-password');
    await expect(
      staff.getByRole('heading', {
        name: 'Change your password to continue',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      staff.getByRole('navigation', { name: 'Admin navigation' }),
    ).toHaveCount(0);
    await staff
      .getByLabel('Current password', { exact: true })
      .fill('temporary-browser-password');
    await staff
      .getByLabel('New password', { exact: true })
      .fill('changed-browser-password');
    await staff
      .getByLabel('Confirm new password', { exact: true })
      .fill('changed-browser-password');
    await staff
      .getByRole('button', { name: 'Save account', exact: true })
      .click();
    await expect(
      staff.getByRole('navigation', { name: 'Admin navigation' }),
    ).toBeVisible();
    expect((await staff.request.get('/api/v1/admin/settings')).status()).toBe(
      403,
    );
    expect(
      (await (await staff.request.get('/api/v1/auth/session')).json())
        .authenticated,
    ).toBe(true);
    await staff
      .getByRole('link', { name: 'Items catalog', exact: true })
      .click();
    await staff
      .getByLabel('Item name', { exact: true })
      .fill('Private unsaved browser draft');
    // First-password setup advances the account revision; refresh the owner's view.
    await page.reload();
    await page
      .getByRole('button', { name: `Disable ${username}`, exact: true })
      .click();
    await expect(
      page.getByText(`Moderator ${username} disabled.`, { exact: true }),
    ).toBeVisible();
    staff.once('dialog', (dialog) => dialog.accept());
    await staff.getByRole('link', { name: 'Submissions', exact: true }).click();
    await expect(
      staff.getByRole('heading', {
        name: 'Admin session expired',
        exact: true,
      }),
    ).toBeVisible();
    await expect(staff.getByLabel('Item name', { exact: true })).toHaveCount(0);
    await expect(
      staff.getByRole('navigation', { name: 'Admin navigation' }),
    ).toHaveCount(0);
    expect((await staff.request.get('/api/v1/admin/catalog')).status()).toBe(
      401,
    );
    await staff.reload();
    await expect(
      staff.getByRole('heading', {
        name: 'Admin sign-in required',
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    await moderator.close();
  }
  await page
    .getByRole('button', { name: `Delete ${username}`, exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Confirm delete moderator', exact: true })
    .click();
  await expect(
    page.getByText(`Moderator ${username} deleted.`, { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Admin sign-in required', exact: true }),
  ).toBeVisible();
});

test('slow real reads preserve keyboard navigation; catalog geometry and both proxy logo uploads work', async ({
  page,
}) => {
  await owner(page);
  let release!: () => void, requested!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route('**/api/v1/admin/catalog', async (route) => {
    requested();
    await held;
    await route.continue().catch(() => {});
  });
  await page.getByRole('link', { name: 'Items catalog', exact: true }).click();
  await seen;
  await expect(page).toHaveURL(origin + '/admin');
  await expect(
    page.getByRole('heading', { name: 'Submissions', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Item name', { exact: true })).toHaveCount(0);
  const cancel = page.getByRole('button', {
    name: 'Cancel navigation',
    exact: true,
  });
  await cancel.focus();
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Enter');
  release();
  await page.unrouteAll({ behavior: 'wait' });
  await page.getByRole('link', { name: 'Items catalog', exact: true }).click();
  await expect(page.getByLabel('Item name', { exact: true })).toBeEnabled();
  const geometry = await page.evaluate(() => {
    const box = (selector: string) => {
      const r = document.querySelector(selector)!.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height };
    };
    return {
      creator: box('.item-creator'),
      manager: box('.page-order-editor'),
      choices: box('.page-picker-choices'),
      submit: box('.item-creator button[type="submit"]'),
    };
  });
  expect(
    Math.abs(geometry.creator.top - geometry.manager.top),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(geometry.creator.bottom - geometry.manager.bottom),
  ).toBeLessThanOrEqual(1);
  expect(geometry.choices.height).toBeGreaterThan(100);
  expect(geometry.choices.bottom).toBeLessThan(geometry.submit.top);
  await writeFile(
    test.info().outputPath('catalog-geometry.json'),
    JSON.stringify(geometry, null, 2),
  );
  await capture(page, 'real-catalog-desktop.png');
  await page.setViewportSize({ width: 320, height: 850 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await page.getByLabel('Item name', { exact: true }).focus();
  await expect(page.getByLabel('Item name', { exact: true })).toBeFocused();
  await capture(page, 'real-catalog-320.png');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const buffer = await sharp(randomBytes(1220 * 1220 * 3), {
    raw: { width: 1220, height: 1220, channels: 3 },
  })
    .png({ compressionLevel: 0 })
    .toBuffer();
  expect(buffer.length).toBeGreaterThan(4 * 1024 * 1024);
  for (const [link, path] of [
    ['Site settings', '/api/v1/branding'],
    ['Hardcore worlds', '/api/v1/branding/hardcore'],
  ] as const) {
    await page.getByRole('link', { name: link, exact: true }).click();
    await page.getByLabel('Logo image', { exact: true }).setInputFiles({
      name: 'browser-logo.png',
      mimeType: 'image/png',
      buffer,
    });
    await page
      .getByRole('button', { name: 'Save clan logo', exact: true })
      .click();
    await expect(
      page.getByText('Clan logo and website icon saved.', { exact: true }),
    ).toBeVisible();
    const branding = await (await page.request.get(path)).json();
    const image = page.getByAltText('Current clan logo');
    await expect(image).toHaveAttribute('src', branding.logoPath);
    await expect
      .poll(() =>
        image.evaluate(
          (element: HTMLImageElement) =>
            element.complete && element.naturalWidth > 0,
        ),
      )
      .toBe(true);
    expect(
      (await page.request.get(branding.faviconPath)).headers()['content-type'],
    ).toBe('image/png');
    await page
      .getByRole('button', { name: 'Restore default logo', exact: true })
      .click();
    await expect(
      page.getByText('Default clan logo restored.', { exact: true }),
    ).toBeVisible();
  }
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Admin sign-in required', exact: true }),
  ).toBeVisible();
});
