import { expect, test } from './test.ts';
import { mockApi } from './mock-api.ts';

test('manual submissions restore today after each success and keep the chosen date after failure', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-10-20T12:00:00Z') });
  const { admin } = await mockApi(page);
  let fail = true;
  const submitted: { collectedOn: string; approve: boolean }[] = [];
  await page.route('**/api/v1/admin/submissions', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    if (fail) {
      fail = false;
      return route.fulfill({
        status: 422,
        json: { message: 'Choose another item.' },
      });
    }
    submitted.push(route.request().postDataJSON());
    return route.fallback();
  });
  await page.goto('/admin/submissions');
  await page
    .getByRole('button', { name: 'Add manual submission', exact: true })
    .click();
  const form = page
    .locator('form')
    .filter({ has: page.locator('.manual-submission-columns') });
  const date = form.getByLabel('Collection date', { exact: true });
  const collector = form.getByLabel('Collector name', { exact: true });
  const item = form.getByLabel('Canonical item', { exact: true });
  const submit = form.getByRole('button', {
    name: 'Create manual submission',
    exact: true,
  });
  await expect(date).toHaveValue('2026-10-20');
  await collector.fill('First date reset');
  await item.selectOption({ index: 1 });
  await date.fill('2026-01-01');
  await submit.click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(date).toHaveValue('2026-01-01');
  await expect(collector).toHaveValue('First date reset');
  await submit.click();
  await expect(collector).toHaveValue('');
  await expect(item).toHaveValue('');
  await expect(date).toHaveValue('2026-10-20');
  await collector.fill('Second date reset');
  await item.selectOption({ index: 1 });
  await form.getByLabel('Approve immediately', { exact: true }).uncheck();
  await page.clock.setFixedTime(new Date('2026-10-21T12:00:00Z'));
  await submit.click();
  await expect(collector).toHaveValue('');
  await expect(date).toHaveValue('2026-10-21');
  expect(
    submitted.map(({ collectedOn, approve }) => ({ collectedOn, approve })),
  ).toEqual([
    { collectedOn: '2026-01-01', approve: true },
    { collectedOn: '2026-10-20', approve: false },
  ]);
  const rows = (
    await admin.queue('pending', undefined, new AbortController().signal)
  ).submissions;
  expect(
    rows.find((row) => row.collectorName === 'Second date reset')?.collectedOn,
  ).toBe('2026-10-20');
});

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
    await expect(page.getByText(/Times use your local timezone:/)).toHaveCount(
      0,
    );
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
