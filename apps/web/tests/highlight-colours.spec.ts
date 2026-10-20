import { expect, test } from './test.ts';
import { mockApi } from './mock-api.ts';
import { adminFixtures } from './admin-fixtures.ts';
const signal = () => new AbortController().signal;

test('preview swatch and HEX input save independently, reject invalid drafts and discard changes', async ({
  page,
}) => {
  const { admin } = await mockApi(page);
  await page.goto('/admin/settings');
  const picker = page.getByRole('group', {
    name: 'Event collection highlight',
    exact: true,
  });
  await expect(
    picker.getByLabel('Choose highlight colour', { exact: true }),
  ).toHaveValue('#e7bd52');
  await picker
    .getByLabel('Choose highlight colour', { exact: true })
    .fill('#12abef');
  await expect(picker.getByLabel('HEX', { exact: true })).toHaveValue(
    '#12abef',
  );
  await expect(picker.locator('input[type="color"]')).toHaveCount(1);
  await expect(picker.getByLabel(/^(Red|Green|Blue)$/)).toHaveCount(0);
  const swatch = picker.locator('.highlight-picker__preview');
  await swatch.scrollIntoViewIfNeeded();
  expect(
    await swatch.evaluate((node) => {
      const r = node.getBoundingClientRect();
      return (
        document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) ===
        node.querySelector('input[type="color"]')
      );
    }),
  ).toBe(true);
  await picker.getByLabel('Alpha (%)', { exact: true }).fill('37.5');
  await expect(picker.locator('.highlight-picker__preview span')).toHaveCSS(
    'background-color',
    /rgba\(18, 171, 239, 0\.37[56]\)/,
  );
  const save = page.getByRole('button', {
    name: 'Save site settings',
    exact: true,
  });
  await picker.getByLabel('HEX', { exact: true }).fill('#12zz00');
  await expect(save).toBeDisabled();
  await picker.getByLabel('HEX', { exact: true }).fill('00ABEF');
  await save.click();
  await expect(
    page.getByText('Site settings saved.', { exact: true }),
  ).toBeVisible();
  expect((await admin.settings(signal())).eventHighlight).toEqual({
    red: 0,
    green: 171,
    blue: 239,
    alpha: 0.375,
  });
  await picker.getByLabel('Alpha (%)', { exact: true }).fill('');
  await expect(save).toBeDisabled();
  await page
    .getByRole('button', { name: 'Discard changes', exact: true })
    .click();
  await expect(picker.getByLabel('Alpha (%)', { exact: true })).toHaveValue(
    '37.5',
  );
  await page
    .getByRole('link', { name: 'Hardcore worlds', exact: true })
    .click();
  const hc = page.getByRole('group', {
    name: 'Hardcore collection highlight',
    exact: true,
  });
  await expect(
    hc.getByLabel('Choose highlight colour', { exact: true }),
  ).toHaveValue('#ff2929');
  await hc
    .getByLabel('Choose highlight colour', { exact: true })
    .fill('#44cc22');
  await hc.getByLabel('Alpha (%)', { exact: true }).fill('0');
  // The independent release switch must preserve the colour draft.
  await page
    .getByRole('switch', { name: 'Enable hardcore worlds', exact: true })
    .click();
  await expect(
    hc.getByLabel('Choose highlight colour', { exact: true }),
  ).toHaveValue('#44cc22');
  await page
    .getByRole('button', { name: 'Save hardcore settings', exact: true })
    .click();
  await expect(
    page.getByText('Hardcore worlds settings saved.', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(hc.getByLabel('Alpha (%)', { exact: true })).toHaveValue('0');
  await page.getByRole('link', { name: 'Site settings', exact: true }).click();
  await expect(
    picker.getByLabel('Choose highlight colour', { exact: true }),
  ).toHaveValue('#00abef');
  expect((await admin.settings(signal())).hardcoreHighlight).toEqual({
    red: 68,
    green: 204,
    blue: 34,
    alpha: 0,
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await picker.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: test.info().outputPath('highlight-picker-mobile.png'),
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test('stale colour save reloads current values once and permitted moderators see disabled channels', async ({
  page,
}) => {
  const { admin } = await mockApi(page);
  await page.goto('/admin/settings');
  const picker = page.getByRole('group', {
    name: 'Event collection highlight',
    exact: true,
  });
  await picker.getByLabel('HEX', { exact: true }).fill('#19bd52');
  const current = await admin.settings(signal());
  await admin.saveSettings(
    false,
    current.revision,
    'test-admin',
    signal(),
    undefined,
    undefined,
    undefined,
    undefined,
    { eventHighlight: { red: 80, green: 90, blue: 100, alpha: 0.6 } },
  );
  let writes = 0;
  page.on('request', (r) => {
    if (r.url().endsWith('/api/v1/admin/settings') && r.method() === 'PUT')
      writes++;
  });
  await page
    .getByRole('button', { name: 'Save site settings', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'The latest data is loaded',
  );
  await expect(picker.getByLabel('HEX', { exact: true })).toHaveValue(
    '#505a64',
  );
  expect(writes).toBe(1);
  const fixture = await adminFixtures();
  await page.route('**/api/v1/auth/session', (r) =>
    r.fulfill({
      json: {
        ...fixture.session,
        role: 'moderator',
        allowedPages: ['settings', 'hardcore'],
      },
    }),
  );
  await page.reload();
  await expect(
    picker.getByLabel('Choose highlight colour', { exact: true }),
  ).toBeDisabled();
  await expect(picker.getByLabel('Alpha (%)', { exact: true })).toBeDisabled();
  await page
    .getByRole('link', { name: 'Hardcore worlds', exact: true })
    .click();
  await expect(
    page
      .getByRole('group', {
        name: 'Hardcore collection highlight',
        exact: true,
      })
      .getByLabel('HEX', { exact: true }),
  ).toBeDisabled();
});

test('saved colours reach silhouette filters and portalled Event/hardcore menus and refresh without reload', async ({
  page,
}) => {
  const { admin } = await mockApi(page);
  const itemId = (await admin.catalog(signal())).items.find(
    (i) => i.name === 'Virtus mask',
  )!.id;
  for (const hardcore of [false, true])
    await admin.addManual(
      {
        itemId,
        collectorName: hardcore ? 'HC collector' : 'Event collector',
        collectedOn: '2026-10-01',
        collectionType: hardcore ? 'regular' : 'event',
        hardcore,
        approve: true,
      },
      crypto.randomUUID(),
      'test-admin',
      signal(),
    );
  const current = await admin.settings(signal());
  await admin.saveSettings(
    true,
    current.revision,
    'test-admin',
    signal(),
    undefined,
    undefined,
    undefined,
    undefined,
    {
      eventHighlight: { red: 0, green: 128, blue: 255, alpha: 0.5 },
      hardcoreHighlight: { red: 100, green: 200, blue: 50, alpha: 0.25 },
    },
  );
  await page.goto('/');
  const slot = page.getByRole('button', {
    name: 'Virtus mask: collected',
    exact: true,
  });
  await expect(slot).toHaveClass(/item-slot--event/);
  await expect(page.locator('#event-outline feFlood')).toHaveAttribute(
    'flood-opacity',
    '0.5',
  );
  await expect(page.locator('#event-outline feFlood')).toHaveAttribute(
    'flood-color',
    'rgba(0, 128, 255, 1)',
  );
  await expect(slot.locator('img')).toHaveCSS('opacity', '1');
  await slot.focus();
  const event = page.getByRole('tooltip').locator('.item-menu__event');
  await expect(event).toHaveCSS('border-top-color', 'rgba(0, 128, 255, 0.5)');
  // Public metadata polling updates an already-open portal as well as the SVG.
  const next = await admin.settings(signal());
  await admin.saveSettings(
    true,
    next.revision,
    'test-admin',
    signal(),
    undefined,
    undefined,
    undefined,
    undefined,
    { eventHighlight: { red: 255, green: 120, blue: 0, alpha: 0 } },
  );
  await page.evaluate(() =>
    document.dispatchEvent(new Event('visibilitychange')),
  );
  await expect(event).toHaveCSS('border-top-color', 'rgba(255, 120, 0, 0)');
  await expect(page.locator('#event-outline feFlood')).toHaveAttribute(
    'flood-opacity',
    '0',
  );
  await page.keyboard.press('Escape');
  await page
    .getByRole('button', { name: 'Hardcore worlds', exact: true })
    .click();
  const hc = page.getByRole('button', {
    name: 'Virtus mask: collected, hardcore',
    exact: true,
  });
  await hc.focus();
  await expect(hc.locator('img')).toHaveCSS('opacity', '1');
  await expect(page.getByRole('tooltip')).toHaveCSS(
    'border-top-color',
    'rgba(100, 200, 50, 0.25)',
  );
  await expect(page.locator('#hardcore-outline feFlood')).toHaveAttribute(
    'flood-opacity',
    '0.25',
  );
  await page.screenshot({
    path: test.info().outputPath('hardcore-highlight.png'),
  });
});
