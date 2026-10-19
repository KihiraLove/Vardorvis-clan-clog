import { expect, test } from './test.ts';
import { mockApi } from './mock-api.ts';

for (const width of [1440, 320]) {
  test(
    'permanent pages require saving, persist across navigation and can be removed at ' +
      width,
    async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const { admin } = await mockApi(page);
      const signal = new AbortController().signal;
      const catalog = await admin.catalog(signal);
      const selected = catalog.pages[0]!;
      let writes = 0;
      page.on('request', (request) => {
        if (
          new URL(request.url()).pathname ===
            '/api/v1/admin/schedules/permanent-pages' &&
          request.method() === 'PUT'
        )
          writes++;
      });
      await page.goto('/admin/schedules');
      const panel = page.getByRole('region', {
        name: 'Permanently open pages',
        exact: true,
      });
      const search = panel.getByRole('searchbox', {
        name: 'Find permanently open pages',
      });
      const save = panel.getByRole('button', {
        name: 'Save changes',
        exact: true,
      });
      const discard = panel.getByRole('button', {
        name: 'Discard changes',
        exact: true,
      });
      const chosen = panel.getByRole('checkbox', {
        name: selected.name + ' (' + selected.category + ')',
        exact: true,
      });
      await expect(save).toBeDisabled();
      await chosen.check();
      await expect(save).toBeEnabled();
      expect(writes).toBe(0);
      expect((await admin.scheduling(signal)).permanentlyOpenPageIds).toEqual(
        [],
      );
      await search.fill('no matching page');
      await expect(
        panel.getByText('No matching pages.', { exact: true }),
      ).toBeVisible();
      await expect(
        panel.getByRole('button', {
          name: 'Remove ' + selected.name,
          exact: true,
        }),
      ).toBeVisible();
      await save.click();
      await expect(page.getByRole('status')).toHaveText(
        'Permanently open pages saved.',
      );
      expect(writes).toBe(1);
      await expect(save).toBeDisabled();
      expect((await admin.scheduling(signal)).permanentlyOpenPageIds).toEqual([
        selected.id,
      ]);
      await page
        .getByRole('link', { name: 'Submissions', exact: true })
        .click();
      await page
        .getByRole('link', { name: 'Scheduling and Competitions', exact: true })
        .click();
      await expect(chosen).toBeChecked();
      await panel.screenshot({
        path: test
          .info()
          .outputPath('permanent-pages-selected-' + width + '.png'),
      });
      await panel
        .getByRole('button', { name: 'Remove ' + selected.name, exact: true })
        .click();
      await expect(chosen).not.toBeChecked();
      await discard.click();
      await expect(chosen).toBeChecked();
      await expect(save).toBeDisabled();
      await chosen.uncheck();
      page.once('dialog', async (dialog) => {
        expect(dialog.message()).toContain('Discard unsaved changes');
        await dialog.dismiss();
      });
      await page
        .getByRole('link', { name: 'Submissions', exact: true })
        .click();
      await expect(page).toHaveURL(/\/admin\/schedules$/);
      await save.click();
      await expect(save).toBeDisabled();
      expect(writes).toBe(2);
      expect((await admin.scheduling(signal)).permanentlyOpenPageIds).toEqual(
        [],
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await panel.screenshot({
        path: test.info().outputPath('permanent-pages-' + width + '.png'),
      });
    },
  );
}

test('permanent-page conflicts load the latest choices without replaying the write', async ({
  page,
}) => {
  const { admin } = await mockApi(page);
  const signal = new AbortController().signal;
  const catalog = await admin.catalog(signal);
  const first = catalog.pages[0]!,
    second = catalog.pages[1]!;
  await page.goto('/admin/schedules');
  const panel = page.getByRole('region', {
    name: 'Permanently open pages',
    exact: true,
  });
  const checkbox = (name: string, category: string) =>
    panel.getByRole('checkbox', {
      name: name + ' (' + category + ')',
      exact: true,
    });
  await checkbox(first.name, first.category).check();
  const state = await admin.scheduling(signal);
  await admin.setPermanentPages(
    [second.id],
    state.revision,
    'csrf-test',
    signal,
  );
  let writes = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'PUT' &&
      request.url().endsWith('/schedules/permanent-pages')
    )
      writes++;
  });
  await panel
    .getByRole('button', { name: 'Save changes', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('latest data is loaded');
  await expect(checkbox(first.name, first.category)).not.toBeChecked();
  await expect(checkbox(second.name, second.category)).toBeChecked();
  await expect(
    panel.getByRole('button', { name: 'Save changes', exact: true }),
  ).toBeDisabled();
  expect(writes).toBe(1);
  expect((await admin.scheduling(signal)).permanentlyOpenPageIds).toEqual([
    second.id,
  ]);
});
