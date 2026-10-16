import { mockApi } from './mock-api.ts';
import { expect, test } from './test.ts';

test('key rotation preserves the selected clan matching mode, including name-only intake', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto('/admin/runelite');
  const matching = page.getByLabel('Clan matching', { exact: true });
  const saveReview = page.getByRole('button', {
    name: 'Save review settings',
    exact: true,
  });
  const current = page.getByLabel('Current shared API key', { exact: true });
  const save = page.getByRole('button', {
    name: 'Save API key settings',
    exact: true,
  });
  await expect(current).toHaveValue(/^[a-f0-9]{32}$/u);
  const initial = await current.inputValue();
  expect(initial).toMatch(/^[a-f0-9]{32}$/u);
  await expect(matching).toHaveValue('both');
  await matching.selectOption('name');
  await current.fill('not hex');
  await expect(save).toBeDisabled();
  await page
    .getByRole('button', { name: 'Generate new key', exact: true })
    .click();
  await expect(current).not.toHaveValue(initial);
  await expect(
    page.getByText('New key generated. Save to apply it.'),
  ).toBeVisible();
  // Navigating away before saving leaves both persisted values untouched.
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('link', { name: 'Submissions', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Submissions', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('link', { name: 'RuneLite submissions', exact: true })
    .click();
  await expect(matching).toHaveValue('both');
  await expect(current).toHaveValue(initial);
  await matching.selectOption('name');
  await saveReview.click();
  const custom = '  key! 😀\n123  ';
  await current.fill(custom);
  await save.click();
  await expect(page.getByText('Clan API key settings saved.')).toBeVisible();
  await page.getByRole('link', { name: 'Submissions', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Submissions', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('link', { name: 'RuneLite submissions', exact: true })
    .click();
  await expect(matching).toHaveValue('name');
  await expect(current).toHaveValue(custom);
  await page
    .getByRole('button', { name: 'Generate new key', exact: true })
    .click();
  await save.click();
  await expect(current).not.toHaveValue(custom);
  expect(await current.inputValue()).toMatch(/^[a-f0-9]{32}$/u);
  await expect(matching).toHaveValue('name');
  await matching.selectOption('both');
  await saveReview.click();
  await expect(matching).toHaveValue('both');
  await expect(
    page.getByLabel('New shared API key', { exact: true }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 850 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
