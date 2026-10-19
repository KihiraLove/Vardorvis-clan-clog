import { expect, test } from './test.ts';
import { mockApi } from './mock-api.ts';
import { zeroTotals } from '../src/xp-model.ts';

const competition = {
  id: 9911,
  kind: 'SKILL',
  title: 'Weighted skill week',
  sourceUrl: 'https://wiseoldman.net/competitions/9911',
  metrics: ['attack', 'fishing'],
  metricDefinitions: [
    { metric: 'attack', weight: '0.25' },
    { metric: 'fishing', weight: '2' },
  ],
  startsAt: '2026-09-01T00:00:00Z',
  endsAt: '2026-09-08T00:00:00Z',
};
const standings = [
  {
    playerId: 2,
    displayName: 'Weighted winner',
    gained: '40',
    rank: 1,
    deltas: [
      { metric: 'attack', gained: '0' },
      { metric: 'fishing', gained: '20' },
      { metric: 'total', gained: '40' },
    ],
  },
  {
    playerId: 1,
    displayName: 'Most XP',
    gained: '25',
    rank: 2,
    deltas: [
      { metric: 'attack', gained: '100' },
      { metric: 'fishing', gained: '0' },
      { metric: 'total', gained: '25' },
    ],
  },
];

test('weighted import preview shows WOM standings and individual raw metric gains', async ({
  page,
}) => {
  await mockApi(page);
  await page.route('**/api/v1/admin/competitions/preview', (r) =>
    r.fulfill({
      json: {
        previewToken: 'weighted',
        expectedRevision: 'xp-1',
        scheduleRevision: 'schedules-1',
        expiresAt: '2099-01-01T00:00:00Z',
        competition,
        lifecycle: 'finished',
        action: 'import-results',
        scheduleStartsAt: null,
        pageIds: [],
        pages: [],
        participants: [
          {
            playerId: 1,
            displayName: 'Most XP',
            gains: { attack: '100', fishing: '0' },
          },
          {
            playerId: 2,
            displayName: 'Weighted winner',
            gains: { attack: '0', fishing: '20' },
          },
        ],
        standings,
        changes: [
          { skill: 'attack', before: '0', after: '100', change: '100' },
          { skill: 'fishing', before: '0', after: '20', change: '20' },
        ],
        warnings: [],
      },
    }),
  );
  await page.goto('/admin/schedules');
  await page
    .getByLabel('Wise Old Man competition link')
    .fill(competition.sourceUrl);
  await page
    .getByRole('button', { name: 'Preview competition', exact: true })
    .click();
  const preview = page.locator('.xp-import-preview');
  await expect(preview.getByLabel('Competition metrics')).toContainText(
    'Attack × 0.25 · Fishing × 2',
  );
  await preview.getByText('Eligible participants (2)', { exact: true }).click();
  await expect(preview.locator('details > ol > li').first()).toHaveText(
    'Weighted winner: 40 Score',
  );
  await preview.getByText('Metric breakdown', { exact: true }).click();
  await expect(preview.locator('.competition-breakdown')).toContainText(
    'Fishing: 20',
  );
  await expect(preview.getByRole('table')).toContainText('100 XP');
  await expect(page.getByLabel('Find opening pages')).toHaveCount(0);
});

test('computed metadata imports do not ask for catalog pages or expose live standings', async ({
  page,
}) => {
  await mockApi(page);
  const c = {
    ...competition,
    id: 9912,
    sourceUrl: 'https://wiseoldman.net/competitions/9912',
    kind: 'ACTIVITY',
    title: 'Efficiency week',
    metrics: ['ehp', 'ehb'],
    metricDefinitions: [
      { metric: 'ehp', weight: '1' },
      { metric: 'ehb', weight: '1' },
    ],
    endsAt: '2099-01-01T00:00:00Z',
  };
  await page.route('**/api/v1/admin/competitions/preview', (r) =>
    r.fulfill({
      json: {
        previewToken: 'computed',
        expectedRevision: 'xp-1',
        scheduleRevision: 'schedules-1',
        expiresAt: '2099-01-01T00:00:00Z',
        competition: c,
        lifecycle: 'running',
        action: 'import-metadata',
        scheduleStartsAt: null,
        pageIds: [],
        pages: [],
        participants: [],
        changes: [],
        warnings: [],
      },
    }),
  );
  await page.goto('/admin/schedules');
  await page.getByLabel('Wise Old Man competition link').fill(c.sourceUrl);
  await page
    .getByRole('button', { name: 'Preview competition', exact: true })
    .click();
  await expect(page.locator('.xp-import-preview')).toContainText('EHP · EHB');
  await expect(page.getByLabel('Find opening pages')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Apply import' }),
  ).toBeEnabled();
  await expect(page.getByText(/Eligible participants/)).toHaveCount(0);
});

for (const width of [1440, 320])
  test(
    'weighted public podium ranks by score while total and skill XP stay raw: ' +
      width,
    async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await mockApi(page);
      const rawPodium = [
        { playerId: 1, displayName: 'Most XP', gained: '100' },
        { playerId: 2, displayName: 'Weighted winner', gained: '20' },
      ];
      await page.route('**/api/v1/xp/tracker', (r) =>
        r.fulfill({
          json: {
            revision: 'xp-weighted',
            totals: { ...zeroTotals(), attack: '100', fishing: '20' },
            podium: rawPodium,
            events: [
              {
                id: competition.id,
                title: competition.title,
                sourceUrl: competition.sourceUrl,
                skills: ['attack', 'fishing'],
                gains: { attack: '100', fishing: '20' },
                podium: rawPodium,
                competition: { ...competition, standings },
              },
            ],
          },
        }),
      );
      await page.goto('/');
      await page
        .getByRole('button', { name: competition.title, exact: true })
        .click();
      const podium = page.getByRole('complementary', {
        name: 'XP podium for ' + competition.title,
      });
      await expect(podium.locator('.xp-podium__name')).toHaveText([
        'Weighted winner',
        'Most XP',
      ]);
      await expect(podium.locator('.xp-podium__name').first()).toHaveAttribute(
        'title',
        '40 Score',
      );
      await expect(
        page
          .getByRole('group', { name: 'Event skill XP' })
          .getByLabel('Attack: 100 XP', { exact: true }),
      ).toBeVisible();
      await page.locator('#xp-tracker').screenshot({
        path: test.info().outputPath('weighted-' + width + '.png'),
      });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
      await page.getByRole('button', { name: 'Total', exact: true }).click();
      const total = page.getByRole('complementary', {
        name: 'XP podium for Total',
      });
      await expect(total.locator('.xp-podium__name').first()).toHaveText(
        'Most XP',
      );
      await expect(total.locator('.xp-podium__name').first()).toHaveAttribute(
        'title',
        '100 XP',
      );
    },
  );
