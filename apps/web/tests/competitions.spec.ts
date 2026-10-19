import { mockApi } from './mock-api.ts';
import { expect, test } from './test.ts';
import { zeroTotals } from '../src/xp-model.ts';
import { adminFixtures } from './admin-fixtures.ts';
const podium = [
  { playerId: 1, displayName: 'Gold Player', gained: '9007199254740994' },
  { playerId: 2, displayName: 'Silver Player', gained: '9007199254740993' },
  { playerId: 3, displayName: 'Bronze Player', gained: '100' },
];
for (const path of ['/admin/xp', '/admin/schedules']) {
  for (const lifecycle of ['future', 'running']) {
    test(`moderator imports ${lifecycle} SKILL metadata without opening pages: ${path}`, async ({
      page,
    }) => {
      const fixtures = await adminFixtures();
      await page.route('**/api/v1/xp/tracker', (r) =>
        r.fulfill({
          json: {
            revision: 'xp-1',
            totals: zeroTotals(),
            podium: [],
            events: [],
          },
        }),
      );
      await page.route('**/api/v1/auth/session', (r) =>
        r.fulfill({ json: { ...fixtures.session, role: 'moderator' } }),
      );
      await page.route('**/api/v1/admin/xp/imports', (r) =>
        r.fulfill({
          json: {
            imports: [],
            revision: 'history-1',
            pageCursor: 'first',
            nextCursor: null,
          },
        }),
      );
      let scheduleWrites = 0;
      await page.route('**/api/v1/admin/schedules', (r) => {
        if (r.request().method() !== 'GET') scheduleWrites++;
        return r.fulfill({
          json: { revision: 'schedules-1', enabled: false, schedules: [] },
        });
      });
      await page.route('**/api/v1/admin/catalog', (r) =>
        r.fulfill({ json: fixtures.catalog }),
      );
      await page.route('**/api/v1/admin/competitions/preview', (r) => {
        expect(r.request().postDataJSON()).toEqual({
          competitionUrl: 'https://wiseoldman.net/competitions/811',
        });
        return r.fulfill({
          json: {
            previewToken: 'skill-metadata',
            expectedRevision: 'xp-1',
            scheduleRevision: 'schedules-1',
            expiresAt: '2099-01-01T00:00:00Z',
            competition: {
              id: 811,
              kind: 'SKILL',
              title: 'Upcoming Attack week',
              sourceUrl: 'https://wiseoldman.net/competitions/811',
              metrics: ['attack'],
              startsAt:
                lifecycle === 'future'
                  ? '2098-01-01T00:00:00Z'
                  : '2026-01-01T00:00:00Z',
              endsAt: '2099-01-01T00:00:00Z',
            },
            lifecycle,
            action: 'import-metadata',
            scheduleStartsAt: null,
            pageIds: [],
            pages: [],
            participants: [],
            changes: [],
            warnings: [],
          },
        });
      });
      let applied = 0;
      await page.route('**/api/v1/admin/competitions/imports', (r) => {
        expect(r.request().headers()['x-csrf-token']).toBe('csrf-test');
        expect(r.request().postDataJSON()).toEqual({
          previewToken: 'skill-metadata',
          expectedRevision: 'xp-1',
          scheduleRevision: 'schedules-1',
          acknowledgeCorrections: false,
        });
        applied++;
        return r.fulfill({
          json: { outcome: 'applied', revision: 'xp-2', scheduleId: null },
        });
      });
      await page.goto(path);
      await page
        .getByLabel('Wise Old Man competition link')
        .fill('https://wiseoldman.net/competitions/811');
      await page
        .getByRole('button', { name: 'Preview competition', exact: true })
        .click();
      const preview = page.locator('.xp-import-preview');
      await expect(preview).toContainText(
        'Detected kind: SKILL · ' + lifecycle,
      );
      await expect(preview).toContainText(
        'Import competition metadata only. No pages will be opened and no XP will be added.',
      );
      await expect(page.getByLabel('Find opening pages')).toHaveCount(0);
      await expect(
        page.getByRole('group', { name: 'Opening pages' }),
      ).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Update preview' }),
      ).toHaveCount(0);
      await expect(preview.locator('table')).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Apply import' }),
      ).toBeEnabled();
      await page.getByRole('button', { name: 'Apply import' }).click();
      await expect(
        page.getByText(
          'Competition metadata imported. No pages were opened or XP added.',
          { exact: true },
        ),
      ).toBeVisible();
      expect(applied).toBe(1);
      expect(scheduleWrites).toBe(0);
    });
  }
  test(`preview SKILL metadata is publicly listed with unavailable gains: ${path}`, async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto(path);
    await page
      .getByLabel('Wise Old Man competition link')
      .fill('https://wiseoldman.net/competitions/1005');
    await page
      .getByRole('button', { name: 'Preview competition', exact: true })
      .click();
    await expect(page.locator('.xp-import-preview')).toContainText(
      'Detected kind: SKILL · future',
    );
    await page.getByRole('button', { name: 'Apply import' }).click();
    await expect(
      page.getByText(
        'Competition metadata imported. No pages were opened or XP added.',
        { exact: true },
      ),
    ).toBeVisible();
    await page.locator('.clan-brand').click();
    await expect(
      page.getByRole('complementary', { name: 'Activity competitions' }),
    ).not.toContainText('Sample skill competition');
    await page.getByRole('link', { name: 'Xp tracker', exact: true }).click();
    await page
      .getByRole('button', { name: 'Sample skill competition', exact: true })
      .click();
    await expect(
      page.getByRole('complementary', {
        name: 'XP podium for Sample skill competition',
      }),
    ).toContainText('No finished results yet.');
    await expect(
      page
        .getByRole('group', { name: 'Event skill XP' })
        .getByLabel('Attack: XP unavailable', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('complementary', { name: 'Activity competitions' }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Total', exact: true }).click();
    await expect(
      page
        .getByRole('group', { name: 'Event skill XP' })
        .getByLabel('Attack: 0 XP', { exact: true }),
    ).toBeVisible();
  });
  test(`both import screens detect fixture kind without a selector: ${path}`, async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto(path);
    const link = page.getByLabel('Wise Old Man competition link');
    await expect(link).toBeVisible();
    await expect(page.getByLabel('Competition kind')).toHaveCount(0);
    for (const [id, kind] of [
      [1001, 'SKILL'],
      [3002, 'ACTIVITY'],
      [1002, 'SKILL'],
    ] as const) {
      await link.fill('https://wiseoldman.net/competitions/' + id);
      await expect(page.locator('.xp-import-preview')).toHaveCount(0);
      await page
        .getByRole('button', { name: 'Preview competition', exact: true })
        .click();
      await expect(
        page.getByText('Detected kind: ' + kind, { exact: false }),
      ).toBeVisible();
      await expect(page.locator('.xp-import-preview a')).toHaveAttribute(
        'href',
        'https://wiseoldman.net/competitions/' + id,
      );
    }
  });
}
test('activity list orders by source end, shows local start/end status colors and safe links, and advances at time boundaries', async ({
  page,
}) => {
  const now = new Date('2026-10-12T12:00:00Z');
  await page.clock.install({ time: now });
  const row = (id: number, title: string, start: string, end: string) => ({
    id,
    kind: 'ACTIVITY',
    title,
    sourceUrl: 'https://wiseoldman.net/competitions/' + id,
    metrics: ['vardorvis'],
    startsAt: start,
    endsAt: end,
  });
  const competitions = [
    row(1, 'Past activity', '2026-10-10T12:00:00Z', '2026-10-11T12:00:00Z'),
    row(2, 'Running activity', '2026-10-11T12:00:00Z', '2026-10-12T12:00:10Z'),
    row(3, 'Future activity', '2026-10-12T12:00:10Z', '2026-10-14T12:00:00Z'),
  ];
  await page.route('**/api/v1/competitions/activities', (r) =>
    r.fulfill({ json: { serverNow: now.toISOString(), competitions } }),
  );
  await page.route('**/api/v1/xp/tracker', (r) =>
    r.fulfill({
      json: { revision: 'xp-1', totals: zeroTotals(), events: [], podium: [] },
    }),
  );
  await page.goto('/');
  const viewer = page.getByRole('complementary', {
    name: 'Activity competitions',
  });
  await expect(viewer.locator('li>a')).toHaveText([
    'Future activity ↗',
    'Running activity ↗',
    'Past activity ↗',
  ]);
  for (const [title, color] of [
    ['Past activity', 'rgb(255, 152, 152)'],
    ['Running activity', 'rgb(164, 229, 164)'],
    ['Future activity', 'rgb(243, 220, 131)'],
  ]) {
    const item = viewer.locator('li').filter({ hasText: title! });
    await expect(item.locator('.activity-status')).toHaveCount(0);
    await expect(item.locator('small')).toHaveCSS('color', color!);
    await expect(item.locator('time')).toHaveCount(2);
    for (const time of await item.locator('time').all())
      await expect(time).toHaveText(/^\d{2}\/\d{2}\/\d{2} \d{2}:\d{2} \S+$/);
    await expect(item.locator('a')).toHaveAttribute('target', '_blank');
    await expect(item.locator('a')).toHaveAttribute(
      'rel',
      'noopener noreferrer',
    );
  }
  await expect(
    viewer.getByRole('link', { name: 'Future activity ↗' }),
  ).toHaveAttribute('href', competitions[2]!.sourceUrl);
  await page.clock.fastForward(11000);
  await expect(
    viewer
      .locator('li')
      .filter({ hasText: 'Running activity' })
      .locator('small'),
  ).toHaveCSS('color', 'rgb(255, 152, 152)');
  await expect(
    viewer
      .locator('li')
      .filter({ hasText: 'Future activity' })
      .locator('small'),
  ).toHaveCSS('color', 'rgb(164, 229, 164)');
});
test('XP podium follows Total and selected SKILL events, preserves 2–1–3 geometry and supports empty/one/two players', async ({
  page,
}) => {
  await page.route('**/api/v1/competitions/activities', (r) =>
    r.fulfill({
      json: { serverNow: new Date().toISOString(), competitions: [] },
    }),
  );
  const events = [
    {
      id: 1,
      title: 'Attack event',
      sourceUrl: 'https://wiseoldman.net/competitions/1',
      skills: ['attack'],
      gains: { attack: '9007199254740994' },
      podium: podium.slice(0, 2),
    },
    {
      id: 2,
      title: 'Future skill event',
      sourceUrl: 'https://wiseoldman.net/competitions/2',
      skills: ['fishing'],
      gains: { fishing: null },
      podium: [],
    },
    {
      id: 3,
      title: 'Solo skill event',
      sourceUrl: 'https://wiseoldman.net/competitions/3',
      skills: ['mining'],
      gains: { mining: '100' },
      podium: [podium[2]],
    },
  ];
  await page.route('**/api/v1/xp/tracker', (r) =>
    r.fulfill({
      json: { revision: 'xp-1', totals: zeroTotals(), events, podium },
    }),
  );
  await page.goto('/xp');
  const total = page.getByRole('complementary', {
    name: 'XP podium for Total',
  });
  await expect(total.locator('li')).toHaveCount(3);
  for (const width of [1100, 320]) {
    await page.setViewportSize({ width, height: 850 });
    const first = total.locator('.xp-podium__place--1'),
      second = total.locator('.xp-podium__place--2'),
      third = total.locator('.xp-podium__place--3');
    expect((await second.boundingBox())!.x).toBeLessThan(
      (await first.boundingBox())!.x,
    );
    expect((await first.boundingBox())!.x).toBeLessThan(
      (await third.boundingBox())!.x,
    );
    const firstStep = first.locator('.xp-podium__step'),
      secondStep = second.locator('.xp-podium__step'),
      thirdStep = third.locator('.xp-podium__step');
    expect((await firstStep.boundingBox())!.height).toBeGreaterThan(
      (await secondStep.boundingBox())!.height,
    );
    expect((await secondStep.boundingBox())!.height).toBeGreaterThan(
      (await thirdStep.boundingBox())!.height,
    );
    await expect(firstStep).toHaveCSS('background-color', 'rgb(215, 189, 109)');
    await expect(secondStep).toHaveCSS(
      'background-color',
      'rgb(182, 183, 171)',
    );
    await expect(thirdStep).toHaveCSS('background-color', 'rgb(189, 148, 112)');
  }
  await page.getByRole('button', { name: 'Attack event', exact: true }).click();
  await expect(
    page
      .getByRole('complementary', { name: 'XP podium for Attack event' })
      .locator('li'),
  ).toHaveCount(2);
  await page
    .getByRole('button', { name: 'Future skill event', exact: true })
    .click();
  await expect(
    page.getByRole('complementary', {
      name: 'XP podium for Future skill event',
    }),
  ).toContainText('No finished results yet.');
  await page
    .getByRole('button', { name: 'Solo skill event', exact: true })
    .click();
  await expect(
    page
      .getByRole('complementary', { name: 'XP podium for Solo skill event' })
      .locator('li'),
  ).toHaveCount(1);
});
test('scheduling importer detects kind, lets staff correct pages with a fresh preview and preserves request identity on uncertain apply', async ({
  page,
}) => {
  await page.route('**/api/v1/auth/session', (r) =>
    r.fulfill({
      json: {
        authenticated: true,
        csrfToken: 'csrf',
        username: 'reviewer',
        displayName: 'Reviewer',
        role: 'moderator',
        mustChangePassword: false,
      },
    }),
  );
  await page.route('**/api/v1/admin/schedules', (r) =>
    r.fulfill({
      json: { revision: 'schedules-1', enabled: false, schedules: [] },
    }),
  );
  await page.route('**/api/v1/admin/catalog', (r) =>
    r.fulfill({
      json: {
        revision: 'catalog-1',
        sourceRevision: null,
        items: [],
        pages: [],
      },
    }),
  );
  let previews = 0;
  const keys: string[] = [];
  const bodies: unknown[] = [];
  await page.route('**/api/v1/admin/competitions/preview', (r) => {
    const b = r.request().postDataJSON();
    expect(b.kind).toBeUndefined();
    expect(b.competitionUrl).toBe('https://wiseoldman.net/competitions/123');
    expect(r.request().headers()['x-csrf-token']).toBe('csrf');
    previews++;
    return r.fulfill({
      json: {
        previewToken: 'token-' + previews,
        expectedRevision: 'xp-1',
        scheduleRevision: 'schedules-1',
        expiresAt: '2099-01-01T00:00:00Z',
        competition: {
          id: 123,
          kind: 'ACTIVITY',
          title: 'Boss week',
          sourceUrl: 'https://wiseoldman.net/competitions/123',
          metrics: ['vardorvis'],
          startsAt: '2026-10-01T12:00:00Z',
          endsAt: '2099-01-01T12:00:00Z',
        },
        lifecycle: 'running',
        action: 'create-schedule',
        scheduleStartsAt: '2026-10-12T12:00:00Z',
        pages: [
          { id: 'vardorvis', name: 'Vardorvis' },
          { id: 'other', name: 'Other page' },
        ],
        pageIds: b.pageIds ?? ['vardorvis'],
        participants: [],
        changes: [],
        warnings: [
          'Scheduling is disabled. This import will not enable enforcement.',
        ],
      },
    });
  });
  await page.route('**/api/v1/admin/competitions/imports', (r) => {
    keys.push(r.request().headers()['idempotency-key']!);
    bodies.push(r.request().postDataJSON());
    return keys.length === 1
      ? r.abort('failed')
      : r.fulfill({ json: { outcome: 'applied' } });
  });
  await page.goto('/admin/schedules');
  await page
    .getByLabel('Wise Old Man competition link')
    .fill('https://wiseoldman.net/competitions/123');
  await expect(
    page.getByRole('button', { name: 'Preview competition', exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel('Competition kind')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Preview competition', exact: true })
    .click();
  await expect(
    page.getByText(/starting immediately when Apply commits/),
  ).toBeVisible();
  await expect(page.getByText(/Detected kind: ACTIVITY/)).toBeVisible();
  await expect(
    page.locator('.xp-import-preview small').filter({ hasText: 'UTC' }).first(),
  ).toBeVisible();
  await expect(page.getByLabel('Enable collection log scheduling')).toHaveCount(
    0,
  );
  await page.getByLabel('Other page', { exact: true }).check();
  await expect(
    page.getByRole('button', { name: 'Apply import' }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Update preview' }).click();
  await expect(
    page.getByRole('button', { name: 'Apply import' }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Apply import' }).click();
  await expect(
    page.locator('.competition-import').getByRole('alert'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Apply import' }).click();
  await expect(
    page.getByText('Competition imported.', { exact: true }),
  ).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(bodies[0]).toEqual(bodies[1]);
});
test('public competition viewer and podium fit 320px and retain desktop log proportions', async ({
  page,
}) => {
  await mockApi(page, { xpSamples: true });
  await page.goto('/');
  const log = await page.locator('.game-window').boundingBox();
  expect(log!.width).toBe(1000);
  expect(log!.height).toBe(628);
  await page.getByRole('link', { name: 'Xp tracker', exact: true }).click();
  await expect(
    page
      .getByRole('complementary', { name: 'XP podium for Total' })
      .locator('li'),
  ).toHaveCount(3);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
    window.scrollTo(0, 0);
  });
  await page.screenshot({
    path: test.info().outputPath('wom-competitions-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 320, height: 850 });
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await expect(
    page.getByRole('complementary', { name: 'Activity competitions' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('complementary', { name: 'XP podium for Total' }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('wom-competitions-mobile.png'),
    fullPage: true,
  });
});
