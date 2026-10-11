import { expect, test } from '@playwright/test';

test('admin can view, generate and supply a key while API-key enforcement is off', async ({
  page,
}) => {
  await page.goto('/admin?preview=1');
  const requireKey = page.getByLabel('Require clan API key', { exact: true });
  const current = page.getByLabel('Current shared API key', { exact: true });
  await expect(requireKey).toBeChecked();
  const initial = await current.inputValue();
  expect(initial).toMatch(/^[a-f0-9]{64}$/);
  await requireKey.uncheck();
  await page.getByRole('button', { name: 'Save API key requirement' }).click();
  await expect(page.getByText('API key requirement saved.')).toBeVisible();
  await expect(current).toHaveValue(initial);
  const generate = page.getByRole('button', {
    name: 'Generate new key',
    exact: true,
  });
  await expect(generate).toBeEnabled();
  await generate.click();
  await expect(page.getByText('Clan API key rotated.')).toBeVisible();
  await expect(current).not.toHaveValue(initial);
  await expect(requireKey).not.toBeChecked();
  await page
    .getByLabel('New shared API key', { exact: true })
    .fill('custom supplied clan key');
  await page.getByRole('button', { name: 'Set API key', exact: true }).click();
  await expect(current).toHaveValue('custom supplied clan key');
  await expect(requireKey).not.toBeChecked();
  await requireKey.check();
  await page.getByRole('button', { name: 'Save API key requirement' }).click();
  await expect(requireKey).toBeChecked();
  await expect(current).toHaveValue('custom supplied clan key');
  await page.setViewportSize({ width: 320, height: 850 });
  await expect(generate).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
