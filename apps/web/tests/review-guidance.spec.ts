import { expect, test, type Locator } from './test.ts';
import { mockApi } from './mock-api.ts';

const correctionPrompt =
  'Save or discard corrections before deciding on this claim.';
const editabilityPrompt = 'Only pending or approved claims can be edited.';

async function validDescriptions(editor: Locator) {
  expect(
    await editor.locator('[aria-describedby]').evaluateAll((nodes) =>
      nodes.flatMap((node) =>
        node
          .getAttribute('aria-describedby')!
          .split(/\s+/)
          .filter((id) => !document.getElementById(id)?.textContent?.trim()),
      ),
    ),
  ).toEqual([]);
}

for (const status of ['rejected', 'revoked'] as const) {
  test(`${status} reviews hide repeated editability guidance and keep every mutation locked`, async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto('/admin/submissions');
    await page.getByRole('button', { name: 'Reviewed', exact: true }).click();
    await page
      .getByRole('button', {
        name: new RegExp('^Review Example ' + status + ' ·'),
      })
      .click();
    const editor = page.locator('.submission-editor');
    await expect(
      editor.getByText(editabilityPrompt, { exact: true }),
    ).toHaveCount(0);
    await expect(
      editor.getByText(correctionPrompt, { exact: true }),
    ).toHaveCount(0);
    await expect(
      editor.getByLabel('Collector name', { exact: true }),
    ).toBeDisabled();
    await expect(
      editor.getByLabel('Collected on hardcore worlds', { exact: true }),
    ).toBeDisabled();
    await expect(
      editor.getByLabel('Obtained during events', { exact: true }),
    ).toBeDisabled();
    for (const name of [
      'Save corrections',
      'Discard corrections',
      'Save review note',
      'Discard review note',
    ]) {
      const button = editor.getByRole('button', { name, exact: true });
      await expect(button).toBeDisabled();
      await expect(button).not.toHaveAttribute('aria-describedby', /.+/);
    }
    await expect(
      editor.getByRole('button', {
        name: /^(Approve submission|Reject submission|Revoke credit|Save collection flags)$/,
      }),
    ).toHaveCount(0);
    await validDescriptions(editor);
    await page.screenshot({
      path: test.info().outputPath(`${status}-without-repeated-guidance.png`),
    });
  });
}

for (const status of ['pending', 'approved'] as const) {
  test(`${status} corrections have one accessible prompt, while flags alone have none`, async ({
    page,
  }) => {
    if (status === 'pending')
      await page.setViewportSize({ width: 390, height: 844 });
    const { admin } = await mockApi(page);
    const signal = new AbortController().signal;
    const row = await admin.addManual(
      {
        itemId: (await admin.catalog(signal)).items[0]!.id,
        collectorName: 'Guidance collector',
        collectedOn: '2026-01-01',
        hardcore: false,
        approve: status === 'approved',
      },
      crypto.randomUUID(),
      'test-admin',
      signal,
    );
    await page.goto('/admin/submissions');
    if (status === 'approved')
      await page.getByRole('button', { name: 'Reviewed', exact: true }).click();
    await page
      .getByRole('button', { name: /^Review Guidance collector ·/ })
      .click();
    const editor = page.locator('.submission-editor');
    const collector = editor.getByLabel('Collector name', { exact: true });
    const prompt = editor.getByText(correctionPrompt, { exact: true });
    await collector.fill('Corrected collector');
    await expect(prompt).toHaveCount(1);
    const promptId = await prompt.getAttribute('id');
    expect(promptId).toBeTruthy();
    const actions =
      status === 'pending'
        ? ['Approve submission', 'Reject submission']
        : ['Revoke credit'];
    for (const name of actions) {
      const button = editor.getByRole('button', { name, exact: true });
      await expect(button).toBeDisabled();
      await expect(button).toHaveAttribute('aria-describedby', promptId!);
    }
    if (status === 'pending') {
      const check = editor.getByLabel(/^I verified this manual claim/);
      await expect(check).toBeDisabled();
      await expect(check).toHaveAttribute('aria-describedby', promptId!);
      expect(
        await prompt.evaluate((node) =>
          Boolean(
            node.compareDocumentPosition(
              document.querySelector(
                '.submission-editor input[aria-describedby="' + node.id + '"]',
              )!,
            ) & Node.DOCUMENT_POSITION_FOLLOWING,
          ),
        ),
      ).toBe(true);
    } else {
      await expect(
        editor.getByRole('button', { name: 'Save corrections', exact: true }),
      ).toBeDisabled();
      await expect(
        editor.getByText(
          'Enter an audit reason before changing an approved credit.',
          { exact: true },
        ),
      ).toBeVisible();
    }
    await validDescriptions(editor);
    await prompt.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: test.info().outputPath(`${status}-single-correction-prompt.png`),
    });
    await editor
      .getByRole('button', { name: 'Discard corrections', exact: true })
      .click();
    await expect(prompt).toHaveCount(0);
    await editor
      .getByLabel('Collected on hardcore worlds', { exact: true })
      .check();
    await expect(prompt).toHaveCount(0);
    for (const name of actions)
      await expect(
        editor.getByRole('button', { name, exact: true }),
      ).not.toHaveAttribute('aria-describedby', promptId!);
    if (status === 'pending') {
      const check = editor.getByLabel(/^I verified this manual claim/);
      await expect(check).toBeEnabled();
      await check.check();
      await expect(
        editor.getByRole('button', { name: 'Approve submission', exact: true }),
      ).toBeEnabled();
    } else {
      await editor.getByLabel(/^Review reason/).fill('Verify world correction');
      await expect(
        editor.getByRole('button', {
          name: 'Save collection flags',
          exact: true,
        }),
      ).toBeEnabled();
    }
    await validDescriptions(editor);
    expect((await admin.detail(row.id, signal)).submission.collectorName).toBe(
      'Guidance collector',
    );
  });
}
