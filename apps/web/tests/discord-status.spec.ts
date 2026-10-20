import { expect, test, type Route } from './test.ts';
import { mockApi } from './mock-api.ts';
import { adminFixtures } from './admin-fixtures.ts';
import type { DiscordConnectionState } from '@clog/domain';

const payload = (state: DiscordConnectionState) => ({
  state,
  enabled: state !== 'disabled',
  ready: state === 'connected',
});

for (const width of [1100, 390]) {
  test(`Discord status colors follow real phases, time out and recover at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 850 });
    await page.clock.install({ time: new Date('2026-10-20T12:00:00Z') });
    await mockApi(page);
    let mode: DiscordConnectionState | 'stall' | 'offline' = 'stall';
    let held: Route | undefined;
    await page.route('**/api/v1/discord/status', (route) => {
      if (mode === 'stall') {
        held = route;
        return;
      }
      if (mode === 'offline') return route.abort('failed');
      return route.fulfill({
        status: mode === 'connected' || mode === 'disabled' ? 200 : 503,
        json: payload(mode),
      });
    });
    await page.goto('/admin/discord');
    const status = page.locator('.discord-connection-status'),
      label = status.locator('span');
    await expect(status).toHaveText('Status: Checking…');
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status).toHaveAttribute('aria-live', 'polite');
    await expect.poll(() => Boolean(held)).toBe(true);
    await page.clock.runFor(4001);
    await expect(status).toHaveText('Status: Unavailable');
    await expect(label).toHaveCSS('color', 'rgb(241, 163, 140)');
    await held!.fulfill({ json: payload('connected') }).catch(() => {});
    await expect(status).toHaveText('Status: Unavailable');
    for (const [next, text, color] of [
      ['connecting', 'Connecting', 'rgb(243, 220, 131)'],
      ['connected', 'Connected', 'rgb(180, 212, 150)'],
      ['disconnected', 'Disconnected', 'rgb(241, 163, 140)'],
      ['connecting', 'Connecting', 'rgb(243, 220, 131)'],
      ['connected', 'Connected', 'rgb(180, 212, 150)'],
      ['offline', 'Unavailable', 'rgb(241, 163, 140)'],
      ['disabled', 'Disabled', undefined],
    ] as const) {
      mode = next;
      await page.clock.runFor(5001);
      await expect(status).toHaveText('Status: ' + text);
      if (color) await expect(label).toHaveCSS('color', color);
      else
        await expect(label).toHaveCSS(
          'color',
          await status.evaluate((node) => getComputedStyle(node).color),
        );
      if (next === 'connected' || next === 'disconnected')
        await page.screenshot({
          path: test.info().outputPath(`discord-${next}-${width}.png`),
        });
    }
  });
}

test('saving settings cancels the previous poll and ignores its late result without losing unsaved controls', async ({
  page,
}) => {
  const { admin } = await mockApi(page);
  let first: Route | undefined,
    reads = 0;
  await page.route('**/api/v1/discord/status', (route) => {
    if (++reads === 1) {
      first = route;
      return;
    }
    return route.fulfill({ json: payload('disabled') });
  });
  await page.goto('/admin/discord');
  await expect.poll(() => Boolean(first)).toBe(true);
  await page
    .getByLabel('Application ID', { exact: true })
    .fill('123456789012345678');
  await page.getByRole('button', { name: 'Save Discord settings' }).click();
  const status = page.locator('.discord-connection-status');
  await expect(status).toHaveText('Status: Disabled');
  await first!.fulfill({ json: payload('connected') }).catch(() => {});
  await expect(status).toHaveText('Status: Disabled');
  await page
    .getByLabel('Application ID', { exact: true })
    .fill('223456789012345678');
  await expect(status).toHaveText('Status: Disabled');
  await page
    .getByRole('button', { name: 'Discard changes', exact: true })
    .click();
  await expect(page.getByLabel('Application ID', { exact: true })).toHaveValue(
    '123456789012345678',
  );
  expect(
    (await admin.discordSettings(new AbortController().signal)).enabled,
  ).toBe(false);
});

test('moderators see the live status while Discord writes and registration remain administrator-only', async ({
  page,
}) => {
  await mockApi(page);
  const fixture = await adminFixtures();
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      json: {
        ...fixture.session,
        role: 'moderator',
        allowedPages: ['discord'],
      },
    }),
  );
  await page.route('**/api/v1/discord/status', (route) =>
    route.fulfill({ json: payload('connected') }),
  );
  await page.goto('/admin/discord');
  await expect(page.locator('.discord-connection-status')).toHaveText(
    'Status: Connected',
  );
  await expect(
    page.getByLabel('Application ID', { exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel('Bot token', { exact: true })).toBeDisabled();
  await expect(
    page.getByRole('switch', { name: 'Enable Discord bot' }),
  ).toBeDisabled();
  for (const name of [
    'Save Discord settings',
    'Discard changes',
    'Register for main server',
    'Register for test server',
  ])
    await expect(
      page.getByRole('button', { name, exact: true }),
    ).toBeDisabled();
});
