import { expect, test } from './test.ts';
import { mockApi } from './mock-api.ts';

test('migrated Regular credits keep their type unless staff explicitly choose saved intake timing', async ({
  page,
}) => {
  const { admin } = await mockApi(page);
  const signal = new AbortController().signal;
  const itemId = (await admin.catalog(signal)).items.find(
    (i) => i.name === 'Virtus mask',
  )!.id;
  const row = await admin.addManual(
    {
      itemId,
      collectorName: 'Legacy collector',
      collectedOn: '2026-10-18',
      hardcore: false,
      approve: true,
      collectionType: 'regular',
    },
    crypto.randomUUID(),
    'test-admin',
    signal,
  );
  const detail = await admin.detail(row.id, signal);
  await page.route('**/api/v1/admin/submissions/' + row.id, (route) =>
    route.fulfill({
      json: {
        ...detail,
        submission: {
          ...detail.submission,
          source: 'runelite',
          collectionType: 'regular',
          collectionReason: 'legacy',
          chatMessage: 'Original proof',
        },
      },
    }),
  );
  await page.goto('/admin/submissions');
  await page.getByRole('button', { name: 'Reviewed', exact: true }).click();
  await page
    .getByRole('button', {
      name: 'Review Legacy collector · Virtus mask',
      exact: true,
    })
    .click();
  const editor = page.locator('.submission-editor');
  await expect(
    editor.getByLabel('Obtained during events', { exact: true }),
  ).not.toBeChecked();
  await editor
    .getByLabel('Collector name', { exact: true })
    .fill('Corrected collector');
  await expect(
    editor.getByLabel('Obtained during events', { exact: true }),
  ).not.toBeChecked();
  await editor
    .getByRole('button', { name: 'Use saved intake timing', exact: true })
    .click();
  await editor
    .getByLabel(/^Review reason/)
    .fill('Restore original timed eligibility');
  await expect(
    editor.getByRole('button', { name: 'Save collection flags', exact: true }),
  ).toBeEnabled();
});

test('Event gold outline and event-first history coexist with complete oldest-first Regular history across shared pages', async ({
  page,
}) => {
  const { admin } = await mockApi(page);
  const signal = new AbortController().signal;
  const catalog = await admin.catalog(signal);
  const itemId = catalog.items.find((i) => i.name === 'Virtus mask')!.id;
  const create = (
    collectorName: string,
    collectedOn: string,
    collectionType: 'regular' | 'event',
    hardcore = false,
  ) =>
    admin.addManual(
      {
        itemId,
        collectorName,
        collectedOn,
        collectionType,
        hardcore,
        approve: true,
      },
      crypto.randomUUID(),
      'test-admin',
      signal,
    );
  await create('Earliest regular', '2026-10-01', 'regular');
  await create('Repeated collector', '2026-10-15', 'regular');
  await create('Repeated collector', '2026-10-16', 'regular');
  const event = await create('Event winner', '2026-10-18', 'event');
  await create('HC collector', '2026-10-01', 'regular', true);
  const settings = await admin.settings(signal);
  await admin.saveSettings(true, settings.revision, 'test-admin', signal);
  await page.goto('/');
  const slot = page.getByRole('button', {
    name: /^Virtus mask: collected, \d+ obtains$/,
  });
  await expect(slot).toHaveClass(/item-slot--event/);
  await slot.focus();
  const menu = page.getByRole('tooltip');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.item-menu__event')).toContainText('Event winner');
  await expect(menu.locator('.item-menu__event')).toHaveCSS(
    'border-top-color',
    'rgb(231, 189, 82)',
  );
  const regular = menu.locator('.item-menu__regular p');
  await expect(regular.first()).toContainText('Earliest regular');
  await expect(regular.nth((await regular.count()) - 2)).toContainText(
    '15/10/26',
  );
  await expect(regular.last()).toContainText('16/10/26');
  await expect(menu.locator('.item-menu__regular')).not.toContainText(
    'HC collector',
  );
  const eventBox = await menu.locator('.item-menu__event').boundingBox(),
    regularBox = await menu.locator('.item-menu__regular').boundingBox();
  expect(eventBox!.y).toBeLessThan(regularBox!.y);
  await page.screenshot({
    path: test.info().outputPath('event-and-regular-history.png'),
  });
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Duke Sucellus', exact: true })
    .click();
  await expect(slot).toHaveClass(/item-slot--event/);
  await page.screenshot({
    path: test.info().outputPath('event-outline-shared-page.png'),
  });
  await page
    .getByRole('button', { name: 'Hardcore worlds', exact: true })
    .click();
  const hc = page.getByRole('button', {
    name: 'Virtus mask: collected, hardcore',
    exact: true,
  });
  await expect(hc).not.toHaveClass(/item-slot--event/);
  await hc.click();
  await expect(menu).toContainText('HC collector');
  await expect(menu.locator('.item-menu__event')).toHaveCount(0);
  await expect(menu).not.toContainText('Event winner');
  await admin.decide(
    event.id,
    event.version,
    'revoke',
    'Incorrect event evidence',
    'test-admin',
    signal,
  );
  await page.goto('/');
  await expect(slot).toBeVisible();
  await expect(slot).not.toHaveClass(/item-slot--event/);
  await slot.hover();
  await expect(menu.locator('.item-menu__event')).toHaveCount(0);
  await expect(menu).toContainText('Repeated collector');
});

test.describe('mobile collection history', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test('pinned mixed history scrolls inside the viewport and retains every repeated collector', async ({
    page,
  }) => {
    const { admin } = await mockApi(page);
    const signal = new AbortController().signal;
    const itemId = (await admin.catalog(signal)).items.find(
      (i) => i.name === 'Virtus mask',
    )!.id;
    for (let i = 0; i < 70; i++)
      await admin.addManual(
        {
          itemId,
          collectorName: 'Regular collector ' + String(i).padStart(2, '0'),
          collectedOn: '2026-10-18',
          hardcore: false,
          collectionType: 'regular',
          approve: true,
        },
        crypto.randomUUID(),
        'test-admin',
        signal,
      );
    await admin.addManual(
      {
        itemId,
        collectorName: 'Event winner',
        collectedOn: '2026-10-18',
        hardcore: false,
        collectionType: 'event',
        approve: true,
      },
      crypto.randomUUID(),
      'test-admin',
      signal,
    );
    await page.goto('/');
    await page
      .getByRole('button', {
        name: 'Virtus mask: collected, 71 obtains',
        exact: true,
      })
      .tap();
    const menu = page.getByRole('tooltip');
    await expect(menu).toBeVisible();
    await expect(menu.locator('.item-menu__regular p')).toHaveCount(70);
    const bounds = await menu.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
    expect(
      await menu.evaluate((node) => node.scrollHeight > node.clientHeight),
    ).toBe(true);
    await menu.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect(menu.locator('.item-menu__regular p').last()).toBeInViewport();
    await page.screenshot({
      path: test.info().outputPath('mobile-complete-regular-history.png'),
    });
    await page.locator('.clan-name').tap();
    await expect(menu).toHaveCount(0);
  });
});

test('manual entry and approved corrections explicitly choose type and force hardcore to Regular', async ({
  page,
}) => {
  const { admin } = await mockApi(page);
  const signal = new AbortController().signal;
  const settings = await admin.settings(signal);
  await admin.saveSettings(true, settings.revision, 'test-admin', signal);
  const item = (await admin.catalog(signal)).items.find(
    (i) => i.name === 'Virtus mask',
  )!;
  await page.goto('/admin/submissions');
  await page
    .getByRole('button', { name: 'Add manual submission', exact: true })
    .click();
  const form = page
    .locator('form')
    .filter({ has: page.locator('.manual-submission-columns') });
  await form.getByLabel('Collector name', { exact: true }).fill('Type editor');
  await form
    .getByLabel('Canonical item', { exact: true })
    .selectOption(String(item.id));
  await form.getByLabel('Collection date', { exact: true }).fill('2026-10-18');
  await form.getByLabel('Obtained during events', { exact: true }).check();
  await form
    .getByRole('button', { name: 'Create manual submission', exact: true })
    .click();
  await page
    .getByRole('button', {
      name: 'Review Type editor · Virtus mask',
      exact: true,
    })
    .click();
  const editor = page.locator('.submission-editor');
  await expect(
    editor.getByLabel('Obtained during events', { exact: true }),
  ).toBeChecked();
  await editor.getByLabel('Obtained during events', { exact: true }).uncheck();
  await editor.getByLabel(/^Review reason/).fill('Correct collection type');
  await editor
    .getByRole('button', { name: 'Save collection flags', exact: true })
    .click();
  await expect(
    editor.getByLabel('Obtained during events', { exact: true }),
  ).not.toBeChecked();
  await expect(editor.locator('.submission-facts')).toContainText(
    'Regular collection',
  );
  await editor
    .getByLabel('Collected on hardcore worlds', { exact: true })
    .check();
  await editor
    .getByLabel(/^Review reason/)
    .fill('Move to hardcore Regular collection');
  await expect(
    editor.getByLabel('Obtained during events', { exact: true }),
  ).toBeDisabled();
  await editor
    .getByRole('button', { name: 'Save collection flags', exact: true })
    .click();
  await expect(editor.locator('.submission-facts')).toContainText(
    'Regular collection',
  );
  await expect(editor.locator('.submission-facts')).toContainText(
    'Hardcore worlds',
  );
});
