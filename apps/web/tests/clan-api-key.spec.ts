import { expect, test } from '@playwright/test';

test('a single editable key and save apply the key and requirement together, including while disabled', async ({
  page,
}) => {
  await page.goto('/admin/runelite?preview=1');
  const required = page.getByLabel('Require clan API key', { exact: true });
  const current = page.getByLabel('Current shared API key', { exact: true });
  const save = page.getByRole('button', {
    name: 'Save API key settings',
    exact: true,
  });
  await expect(current).toHaveValue(/^[a-f0-9]{32}$/u);
  const initial = await current.inputValue();
  expect(initial).toMatch(/^[a-f0-9]{32}$/u);
  await expect(required).toBeChecked();
  await required.uncheck();
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
  await page.getByRole('link', { name: 'Submissions', exact: true }).click();
  await page
    .getByRole('link', { name: 'RuneLite submissions', exact: true })
    .click();
  await expect(required).toBeChecked();
  await expect(current).toHaveValue(initial);
  await required.uncheck();
  const custom = '  key! 😀\n123  ';
  await current.fill(custom);
  await save.click();
  await expect(page.getByText('Clan API key settings saved.')).toBeVisible();
  await page.getByRole('link', { name: 'Submissions', exact: true }).click();
  await page
    .getByRole('link', { name: 'RuneLite submissions', exact: true })
    .click();
  await expect(required).not.toBeChecked();
  await expect(current).toHaveValue(custom);
  await page
    .getByRole('button', { name: 'Generate new key', exact: true })
    .click();
  await save.click();
  await expect(current).not.toHaveValue(custom);
  expect(await current.inputValue()).toMatch(/^[a-f0-9]{32}$/u);
  await expect(required).not.toBeChecked();
  await required.check();
  await save.click();
  await expect(required).toBeChecked();
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
