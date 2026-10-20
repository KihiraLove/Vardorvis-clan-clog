import { expect, test } from './test.ts';
import { mockApi } from './mock-api.ts';
import type { Credit } from '../src/model.ts';

test('obtain counts refresh after approvals, replay, revocation and item/world corrections without changing unique progress', async ({
  page,
}) => {
  const { admin } = await mockApi(page);
  const signal = new AbortController().signal;
  const catalog = await admin.catalog(signal);
  const itemId = catalog.items.find((item) => item.name === 'Virtus mask')!.id;
  const other = catalog.items.find((item) => item.name === 'Virtus robe top')!;
  const settings = await admin.settings(signal);
  await admin.saveSettings(true, settings.revision, 'test-admin', signal);
  const fields = {
    itemId,
    collectorName: 'Repeated collector',
    collectedOn: '2026-10-18',
    hardcore: false,
    collectionType: 'regular' as const,
    approve: true,
  };
  const refresh = () =>
    page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const slot = page.getByRole('button', { name: /^Virtus mask:/ });
  const count = slot.locator('.item-obtain-count');
  const progress = page.locator('.game-titlebar h2');
  await page.goto('/');
  await expect(slot).toHaveAccessibleName('Virtus mask: not collected');
  await expect(count).toHaveCount(0);
  const pending = await admin.addManual(
    { ...fields, approve: false },
    crypto.randomUUID(),
    'test-admin',
    signal,
  );
  await refresh();
  await expect(slot).toHaveAccessibleName('Virtus mask: not collected');
  const first = await admin.decide(
    pending.id,
    pending.version,
    'approve',
    '',
    'test-admin',
    signal,
  );
  await refresh();
  await expect(slot).toHaveAccessibleName('Virtus mask: collected');
  await expect(count).toHaveCount(0);
  const uniqueProgress = await progress.textContent();
  const replayKey = crypto.randomUUID();
  const second = await admin.addManual(fields, replayKey, 'test-admin', signal);
  const replay = await admin.addManual(fields, replayKey, 'test-admin', signal);
  expect(replay.id).toBe(second.id);
  await refresh();
  await expect(count).toHaveText('2');
  await expect(slot).toHaveAccessibleName('Virtus mask: collected, 2 obtains');
  await expect(progress).toHaveText(uniqueProgress!);
  const event = await admin.addManual(
    { ...fields, collectorName: 'Event collector', collectionType: 'event' },
    crypto.randomUUID(),
    'test-admin',
    signal,
  );
  await refresh();
  await expect(count).toHaveText('3');
  await expect(slot).toHaveClass(/item-slot--event/);
  await expect(progress).toHaveText(uniqueProgress!);
  await slot.focus();
  await expect(slot).toBeFocused();
  const menu = page.getByRole('tooltip');
  await expect(menu.locator('.item-menu__event')).toContainText(
    'Event collector',
  );
  await expect(menu.locator('.item-menu__regular p')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await page.screenshot({
    path: test.info().outputPath('mixed-obtain-count.png'),
  });
  await page
    .getByRole('button', { name: 'Duke Sucellus', exact: true })
    .click();
  await expect(count).toHaveText('3');
  for (let i = 0; i < 2; i++)
    await admin.addManual(
      { ...fields, hardcore: true },
      crypto.randomUUID(),
      'test-admin',
      signal,
    );
  await refresh();
  await page
    .getByRole('button', { name: 'Hardcore worlds', exact: true })
    .click();
  await expect(count).toHaveText('2');
  await expect(slot).toHaveAccessibleName(
    'Virtus mask: collected, hardcore, 2 obtains',
  );
  await expect(slot).not.toHaveClass(/item-slot--event/);
  await expect(slot.locator('img')).toHaveCSS('filter', /hardcore-outline/);
  await page
    .getByRole('button', { name: 'Hardcore worlds', exact: true })
    .click();
  await expect(count).toHaveText('3');
  await admin.decide(
    event.id,
    event.version,
    'revoke',
    'Wrong event',
    'test-admin',
    signal,
  );
  await refresh();
  await expect(count).toHaveText('2');
  await expect(slot).not.toHaveClass(/item-slot--event/);
  await expect(progress).toHaveText(uniqueProgress!);
  await admin.edit(
    second.id,
    second.version,
    {
      itemId: other.id,
      collectorName: fields.collectorName,
      collectedOn: fields.collectedOn,
      hardcore: false,
      collectionType: 'regular',
      reason: 'Correct canonical item',
    },
    'test-admin',
    signal,
  );
  await refresh();
  await expect(slot).toHaveAccessibleName('Virtus mask: collected');
  await expect(count).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: `${other.name}: collected`, exact: true }),
  ).toBeVisible();
  await admin.edit(
    first.id,
    first.version,
    {
      itemId,
      collectorName: fields.collectorName,
      collectedOn: fields.collectedOn,
      hardcore: true,
      collectionType: 'regular',
      reason: 'Correct world mode',
    },
    'test-admin',
    signal,
  );
  await refresh();
  await expect(slot).toHaveAccessibleName('Virtus mask: not collected');
  await expect(count).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Hardcore worlds', exact: true })
    .click();
  await expect(count).toHaveText('3');
  await expect(slot).toHaveAccessibleName(
    'Virtus mask: collected, hardcore, 3 obtains',
  );
});

for (const width of [1440, 320]) {
  test(`obtain overlays fit icons and preserve keyboard/touch history at ${width}px`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      hasTouch: width === 320,
    });
    try {
      const page = await context.newPage();
      const { admin } = await mockApi(page);
      const catalog = admin.publicLog().catalog;
      const items = catalog.items.slice(0, 4);
      const counts = [0, 1, 2, 12345];
      const credits: Credit[] = items.flatMap((item, itemIndex) =>
        Array.from({ length: counts[itemIndex]! }, (_, n) => ({
          submissionId: `count-${item.id}-${n}`,
          itemId: item.id,
          collectorName: 'Repeated collector',
          collectedOn: '2026-10-18',
          hardcore: false,
          status: 'approved' as const,
          collectionType: n === 0 ? ('event' as const) : ('regular' as const),
        })),
      );
      await page.route('**/api/v1/catalog', (route) =>
        route.fulfill({
          json: {
            revision: 'count-catalog',
            items,
            pages: [
              {
                id: 'counts',
                name: 'Count examples',
                category: 'bosses',
                itemIds: items.map((item) => item.id),
              },
            ],
          },
        }),
      );
      await page.route('**/api/v1/collections', (route) =>
        route.fulfill({
          json: {
            revision: 'count-credits',
            credits,
          },
        }),
      );
      await page.goto('/');
      await page.evaluate(() => document.fonts.ready);
      const slots = page.locator('.item-grid .item-slot');
      await expect(slots).toHaveCount(4);
      await expect(slots.nth(0).locator('.item-obtain-count')).toHaveCount(0);
      await expect(slots.nth(1).locator('.item-obtain-count')).toHaveCount(0);
      for (const index of [2, 3]) {
        const slot = slots.nth(index),
          count = slot.locator('.item-obtain-count');
        await expect(count).toHaveText(String(counts[index]));
        await expect(count).toHaveCSS('color', 'rgb(255, 255, 0)');
        await expect(count).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(count).toHaveCSS('pointer-events', 'none');
        await expect(count).toHaveAttribute('aria-hidden', 'true');
        await expect(slot).toHaveAccessibleName(
          `${items[index]!.name}: collected, ${counts[index]} obtains`,
        );
        const bounds = (await slot.boundingBox())!,
          overlay = (await count.boundingBox())!;
        expect(overlay.x).toBeGreaterThan(bounds.x);
        expect(overlay.y).toBeGreaterThan(bounds.y);
        expect(overlay.x + overlay.width).toBeLessThanOrEqual(
          bounds.x + bounds.width,
        );
        expect(overlay.y + overlay.height).toBeLessThan(
          bounds.y + bounds.height / 2,
        );
        await expect(slot).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
        await expect(slot).toHaveCSS('box-shadow', 'none');
        await expect(slot.locator('img')).toHaveCSS('filter', /event-outline/);
      }
      await expect(page.locator('.page-heading p')).toHaveText('Obtained: 3/4');
      const two = slots.nth(2);
      await two.scrollIntoViewIfNeeded();
      if (width === 320) {
        const bounds = (await two.boundingBox())!;
        await page.touchscreen.tap(bounds.x + 8, bounds.y + 8);
      } else await two.focus();
      await expect(page.getByRole('tooltip')).toBeVisible();
      await expect(
        page.getByRole('tooltip').locator('.item-menu__event'),
      ).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('tooltip')).toHaveCount(0);
      await slots.nth(3).scrollIntoViewIfNeeded();
      await page.screenshot({
        path: test.info().outputPath(`obtain-counts-${width}.png`),
      });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
    } finally {
      await context.close();
    }
  });
}
