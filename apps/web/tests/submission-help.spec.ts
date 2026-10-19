import { defaultSubmissionHelp } from '@clog/domain';
import { expect, test, type Page } from './test.ts';
import { mockApi } from './mock-api.ts';
import { adminFixtures } from './admin-fixtures.ts';

const guide =
  '## Clan instructions\n\n1. Collect an **item**.\n2. Keep *proof*.\n\n[Ask staff](https://example.com/help)\n\n```text\nKeep the original screenshot\n```';
const signal = () => new AbortController().signal;
async function helpSettings(page: Page, text = guide) {
  const { admin } = await mockApi(page, {
    scenario: 'hardcore',
    xpSamples: true,
  });
  const current = await admin.settings(signal());
  await admin.saveSettings(
    true,
    current.revision,
    'test-admin',
    signal(),
    undefined,
    undefined,
    undefined,
    text,
  );
  return admin;
}

for (const width of [1440, 740, 320]) {
  test(
    'help stays right aligned and preserves public view layout at ' + width,
    async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await helpSettings(page);
      await page.goto('/?page=duke-sucellus');
      await expect(page.locator('.page-heading h3')).toHaveText(
        'Duke Sucellus',
      );
      await page.evaluate(() => document.fonts.ready);
      const help = page.getByRole('button', {
        name: 'How to submit',
        exact: true,
      });
      const normal = await help.boundingBox();
      const shell = await page.locator('.site-shell').evaluate((node) => {
        const r = node.getBoundingClientRect();
        return r.right - parseFloat(getComputedStyle(node).paddingRight);
      });
      expect(normal!.x + normal!.width).toBeCloseTo(shell, 1);
      const a = (await page
        .getByRole('link', { name: 'Collection log', exact: true })
        .boundingBox())!;
      const b = (await page
        .getByRole('link', { name: 'Xp tracker', exact: true })
        .boundingBox())!;
      const nav = (await page.locator('.public-navigation-bar').boundingBox())!;
      expect((a.x + a.width + b.x) / 2).toBeCloseTo(nav.x + nav.width / 2, 1);
      if (width > 600) expect(normal!.x).toBeGreaterThan(b.x + b.width);
      else expect(normal!.y).toBeGreaterThanOrEqual(b.y + b.height);
      const caption = await page.locator('.log-help').boundingBox();
      const log = await page.locator('.game-window').boundingBox();
      await page
        .getByRole('button', { name: 'Hardcore worlds', exact: true })
        .click();
      await expect(page.locator('.public-navigation')).toHaveAttribute(
        'inert',
        '',
      );
      expect(await help.boundingBox()).toEqual(normal);
      expect(await page.locator('.log-help').boundingBox()).toEqual(caption);
      expect(await page.locator('.game-window').boundingBox()).toEqual(log);
      await help.click();
      const dialog = page.getByRole('dialog', {
        name: 'How to submit',
        exact: true,
      });
      await expect(
        dialog.getByRole('heading', { name: 'Clan instructions' }),
      ).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(help).toBeFocused();
      await page
        .getByRole('button', { name: 'Hardcore worlds', exact: true })
        .click();
      await page.getByRole('link', { name: 'Xp tracker', exact: true }).click();
      await expect(page.locator('#xp-tracker')).toBeVisible();
      expect(await help.boundingBox()).toEqual(normal);
      await help.click();
      await expect(dialog.locator('strong')).toHaveText('item');
      await page.screenshot({
        path: test.info().outputPath('submission-help-' + width + '.png'),
      });
      await dialog
        .getByRole('button', { name: 'Close submission help', exact: true })
        .click();
      await expect(help).toBeFocused();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    },
  );
}

test('help opens over scrolled content, confines focus and scroll, and restores the route and selection', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await helpSettings(
    page,
    guide + '\n\n' + 'More proof instructions.\n\n'.repeat(400),
  );
  await page.goto('/?page=duke-sucellus');
  await expect(page.locator('.page-heading h3')).toHaveText('Duke Sucellus');
  const before = await page.evaluate(() => {
    document
      .querySelector<HTMLButtonElement>('.submission-help-button')!
      .focus({ preventScroll: true });
    window.scrollTo(0, 250);
    return { href: location.href, scroll: scrollY };
  });
  expect(before.scroll).toBeGreaterThan(0);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', {
    name: 'How to submit',
    exact: true,
  });
  await expect(
    dialog.getByRole('heading', { name: 'Clan instructions' }),
  ).toBeVisible();
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(700);
  await expect(page.locator('html')).toHaveCSS('overflow', 'hidden');
  for (let i = 0; i < 7; i++) {
    await page.keyboard.press('Tab');
    expect(
      await dialog.evaluate((node) => node.contains(document.activeElement)),
    ).toBe(true);
  }
  for (let i = 0; i < 7; i++) {
    await page.keyboard.press('Shift+Tab');
    expect(
      await dialog.evaluate((node) => node.contains(document.activeElement)),
    ).toBe(true);
  }
  await dialog.locator('.submission-help-body').evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  expect(
    await dialog
      .locator('.submission-help-body')
      .evaluate((node) => node.scrollTop),
  ).toBeGreaterThan(0);
  expect(await page.evaluate(() => scrollY)).toBe(before.scroll);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'How to submit', exact: true }),
  ).toBeFocused();
  expect(
    await page.evaluate(() => ({ href: location.href, scroll: scrollY })),
  ).toEqual(before);
  await expect(page.locator('.page-heading h3')).toHaveText('Duke Sucellus');
});

test('admin previews and saves safe Markdown, discards drafts and preserves saved help across reloads', async ({
  page,
}) => {
  const admin = await helpSettings(page);
  let externalRequests = 0;
  page.on('request', (request) => {
    if (request.url().includes('untrusted.example')) externalRequests++;
  });
  await page.goto('/admin/settings');
  const input = page.getByLabel('How to submit (Markdown)', { exact: true });
  await expect(input).toHaveValue(guide);
  const text =
    guide +
    '\n\n<script>window.helpXss=1</script>\n\n[Unsafe](javascript:alert(1))\n\n![Proof image](https://untrusted.example/track.png)\n\n<iframe src="https://untrusted.example/frame"></iframe>';
  await input.fill(text);
  await page
    .getByRole('button', { name: 'Preview instructions', exact: true })
    .click();
  const preview = page.getByRole('region', {
    name: 'Submission help preview',
    exact: true,
  });
  await expect(
    preview.getByRole('heading', { name: 'Clan instructions' }),
  ).toBeVisible();
  await expect(preview.locator('ol > li')).toHaveCount(2);
  await expect(preview.locator('em')).toHaveText('proof');
  await expect(preview.locator('pre code')).toHaveText(
    'Keep the original screenshot\n',
  );
  await expect(preview.locator('script, iframe, img')).toHaveCount(0);
  await expect(
    preview.getByRole('link', { name: 'Unsafe', exact: true }),
  ).toHaveCount(0);
  await expect(
    preview.getByRole('link', { name: 'Ask staff' }),
  ).toHaveAttribute('rel', 'noopener noreferrer');
  const rendered = await preview.locator('.help-markdown').innerHTML();
  const typography = (node: Element) =>
    Array.from(node.querySelectorAll('h2, p, a, pre')).map((element) => {
      const css = getComputedStyle(element);
      return {
        tag: element.tagName,
        font: css.font,
        color: css.color,
        margin: css.margin,
      };
    });
  const previewTypography = await preview
    .locator('.help-markdown')
    .evaluate(typography);
  await page.screenshot({
    path: test.info().outputPath('submission-help-settings.png'),
    fullPage: true,
  });
  await page
    .getByRole('button', { name: 'Save site settings', exact: true })
    .click();
  await expect(
    page.getByText('Site settings saved.', { exact: true }),
  ).toBeVisible();
  expect((await admin.settings(signal())).howToSubmitMarkdown).toBe(text);
  await input.fill('Unsaved guide');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('link', { name: 'Main site', exact: true }).click();
  await expect(input).toHaveValue('Unsaved guide');
  await page
    .getByRole('button', { name: 'Discard changes', exact: true })
    .click();
  await expect(input).toHaveValue(text);
  await input.fill('😀'.repeat(8193));
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(
    page.getByRole('button', { name: 'Save site settings', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Discard changes', exact: true })
    .click();
  await page.reload();
  await expect(input).toHaveValue(text);
  await page.getByRole('link', { name: 'Main site', exact: true }).click();
  await page
    .getByRole('button', { name: 'How to submit', exact: true })
    .click();
  const content = page.getByRole('dialog').locator('.help-markdown');
  await expect(content).toBeVisible();
  expect(await content.innerHTML()).toBe(rendered);
  expect(await content.evaluate(typography)).toEqual(previewTypography);
  expect(await page.evaluate(() => 'helpXss' in window)).toBe(false);
  expect(externalRequests).toBe(0);
});

test('stale help saves reload the latest text without replaying the write', async ({
  page,
}) => {
  const admin = await helpSettings(page);
  await page.goto('/admin/settings');
  const input = page.getByLabel('How to submit (Markdown)', { exact: true });
  await input.fill('Local unsaved instructions');
  const current = await admin.settings(signal());
  await admin.saveSettings(
    true,
    current.revision,
    'test-admin',
    signal(),
    undefined,
    undefined,
    undefined,
    'Saved by another administrator',
  );
  let writes = 0;
  page.on('request', (request) => {
    if (
      request.url().endsWith('/api/v1/admin/settings') &&
      request.method() === 'PUT'
    )
      writes++;
  });
  await page
    .getByRole('button', { name: 'Save site settings', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'The latest data is loaded',
  );
  await expect(input).toHaveValue('Saved by another administrator');
  expect(writes).toBe(1);
});

test('permitted moderators can preview the guide while all edits remain administrator-only', async ({
  page,
}) => {
  await helpSettings(page);
  const fixture = await adminFixtures();
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      json: {
        ...fixture.session,
        role: 'moderator',
        allowedPages: ['settings'],
      },
    }),
  );
  await page.goto('/admin/settings');
  await expect(
    page.getByLabel('How to submit (Markdown)', { exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Save site settings', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Discard changes', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Preview instructions', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Submission help preview' }),
  ).toContainText('Clan instructions');
});

for (const unavailable of [false, true])
  test(
    'help falls back to useful default instructions when ' +
      (unavailable ? 'settings are unavailable' : 'saved text is empty'),
    async ({ page }) => {
      await helpSettings(page, ' \n');
      if (unavailable)
        await page.route('**/api/v1/settings', (route) =>
          route.fulfill({ status: 503, json: { error: 'Unavailable' } }),
        );
      await page.goto('/');
      await page
        .getByRole('button', { name: 'How to submit', exact: true })
        .click();
      const dialog = page.getByRole('dialog', {
        name: 'How to submit',
        exact: true,
      });
      await expect(
        dialog.getByRole('heading', { name: 'Submit a collection' }),
      ).toBeVisible();
      expect(defaultSubmissionHelp).toContain('Ask your clan staff');
      await expect(dialog).toContainText('Ask your clan staff');
    },
  );
