import { expect, test } from './test.ts';
import { mockApi } from './mock-api.ts';

for (const width of [1440, 390]) {
  test(`manual and scheduling controls sit below their text at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockApi(page);
    await page.goto('/admin/submissions');
    const heading = page.getByRole('heading', {
      name: 'Manual submission',
      exact: true,
    });
    const add = page.getByRole('button', {
      name: 'Add manual submission',
      exact: true,
    });
    const title = (await heading.boundingBox())!;
    const button = (await add.boundingBox())!;
    expect(button.y).toBeGreaterThanOrEqual(title.y + title.height);
    expect(button.x).toBeCloseTo(title.x, 1);
    await add.click();
    await expect(
      page.getByLabel('Collector name', { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`manual-${width}.png`),
      fullPage: true,
    });
    await page
      .getByRole('link', { name: 'Scheduling and Competitions', exact: true })
      .click();
    const label = page.getByRole('heading', {
      name: 'Track Event collections during scheduled windows',
      exact: true,
    });
    const toggle = page.getByRole('switch', {
      name: 'Collection log scheduling',
      exact: true,
    });
    const text = (await label.boundingBox())!;
    const control = (await toggle.boundingBox())!;
    expect(control.y).toBeGreaterThanOrEqual(text.y + text.height);
    expect(control.x).toBeCloseTo(text.x, 1);
    await expect(
      page.getByText(/These pages produce Regular collections even during/),
    ).toHaveCount(0);
    await expect(
      page.getByText(/Review the UTC times before saving/),
    ).toHaveCount(0);
    await expect(
      page.getByText(/Times use your local timezone:/),
    ).toBeVisible();
    await toggle.click();
    await expect(toggle).toBeChecked();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: test.info().outputPath(`scheduling-${width}.png`),
      fullPage: true,
    });
  });
}
