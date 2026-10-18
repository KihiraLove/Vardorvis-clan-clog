import { expect, test } from './test.ts';
import { mockApi } from './mock-api.ts';

for (const width of [1100, 390])
  test(`Discord settings save private credentials and register explicitly at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 850 });
    await mockApi(page);
    await page.goto('/admin/discord');
    await expect(
      page.getByRole('heading', { name: 'Discord bot', exact: true }),
    ).toBeVisible();
    await page
      .getByLabel('Application ID', { exact: true })
      .fill('123456789012345678');
    await page
      .getByLabel('Server ID', { exact: true })
      .fill('223456789012345678');
    await page
      .getByLabel('Test server ID (optional)')
      .fill('323456789012345678');
    const token = 'test_discord_token_private_123456789';
    await page.getByLabel('Bot token', { exact: true }).fill(token);
    await page.getByRole('switch', { name: 'Enable Discord bot' }).click();
    await expect(
      page.getByRole('button', { name: 'Register for main server' }),
    ).toBeDisabled();
    await page.getByRole('button', { name: 'Save Discord settings' }).click();
    await expect(
      page.getByText(
        'Discord settings saved. The bot will reload automatically.',
      ),
    ).toBeVisible();
    await expect(page.getByLabel('Bot token', { exact: true })).toHaveValue('');
    await expect(
      page.getByText('A bot token is stored. Its value is never displayed.'),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Register for test server' })
      .click();
    await expect(
      page.getByText('Commands registered for the test server.'),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole('switch', { name: 'Enable Discord bot' }),
    ).toBeChecked();
    await expect(page.getByLabel('Bot token', { exact: true })).toHaveValue('');
    await page.getByLabel('Remove stored token when saving').check();
    await expect(
      page.getByRole('switch', { name: 'Enable Discord bot' }),
    ).not.toBeChecked();
    await page.getByRole('button', { name: 'Save Discord settings' }).click();
    await expect(page.getByText('No bot token is stored.')).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
