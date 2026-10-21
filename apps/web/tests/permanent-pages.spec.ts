import { expect, test } from './test.ts';
import { mockApi } from './mock-api.ts';
for (const width of [1440, 320])
  test(
    'scheduling has one tracking heading and no permanent-page controls at ' +
      width,
    async ({ page }) => {
      await mockApi(page);
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/admin/schedules');
      await expect(
        page.getByRole('heading', {
          name: 'Track Event collections during scheduled windows',
          exact: true,
        }),
      ).toHaveCount(1);
      await expect(
        page.getByRole('region', { name: 'Permanently open pages' }),
      ).toHaveCount(0);
      await expect(
        page.getByRole('link', {
          name: 'Scheduling and Competitions',
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole('switch', { name: 'Collection log scheduling' }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath('scheduling-' + width + '.png'),
        fullPage: true,
      });
    },
  );
