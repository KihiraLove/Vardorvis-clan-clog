import { expect, test } from '@playwright/test';

test('RuneLite policies, independent clan matching and whitelist save on desktop and mobile', async ({
  page,
}) => {
  await page.goto('/admin/runelite?preview=1');
  await expect(page.getByLabel('Clan matching', { exact: true })).toBeEnabled();
  await expect(
    page.getByLabel('Clan matching', { exact: true }).locator('option'),
  ).toHaveText(['Clan name', 'API key', 'Both']);
  await expect(page.getByLabel('In-game clan name for matching')).toHaveValue(
    'Clan name',
  );
  for (const label of ['F2P worlds', 'PVP worlds']) {
    const select = page.getByLabel(label, { exact: true });
    await expect(select.locator('option')).toHaveText([
      'Reject',
      'Send to review',
      'Auto allow',
    ]);
    await select.selectOption(label === 'F2P worlds' ? 'reject' : 'allow');
  }
  for (const label of ['MEMBERS worlds', 'HC_WORLDS_PLACEHOLDER worlds']) {
    const select = page.getByLabel(label, { exact: true });
    await expect(select.locator('option')).toHaveText([
      'Send to review',
      'Auto allow',
    ]);
    await select.selectOption('allow');
  }
  await page.getByLabel('In-game clan name for matching').fill('Game Clan');
  await page.getByLabel('Clan matching', { exact: true }).selectOption('name');
  await page
    .getByLabel('Player whitelist', { exact: true })
    .fill('Trusted_Player\ntrusted player\nSecond Player');
  await page.getByRole('button', { name: 'Save review settings' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'RuneLite review settings saved.',
  );
  await expect(
    page.getByLabel('Player whitelist', { exact: true }),
  ).toHaveValue('trusted player\nSecond Player');
  await page.getByLabel('Clan matching', { exact: true }).selectOption('key');
  await expect(
    page.getByLabel('In-game clan name for matching'),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Save review settings' }).click();
  await expect(
    page.getByRole('button', { name: 'Save review settings' }),
  ).toBeDisabled();
  await page.getByRole('link', { name: 'Site settings', exact: true }).click();
  await expect(
    page.getByLabel('Clan display name', { exact: true }),
  ).toHaveValue('Clan name');
  await page
    .getByRole('link', { name: 'RuneLite submissions', exact: true })
    .click();
  await expect(page.getByLabel('Clan matching', { exact: true })).toHaveValue(
    'key',
  );
  await expect(page.getByLabel('In-game clan name for matching')).toHaveValue(
    'Game Clan',
  );
  await expect(page.getByLabel('F2P worlds', { exact: true })).toHaveValue(
    'reject',
  );
  await page.setViewportSize({ width: 320, height: 850 });
  await page
    .getByLabel('Player whitelist', { exact: true })
    .scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: test.info().outputPath('runelite-review-mobile.png'),
    fullPage: true,
  });
});
