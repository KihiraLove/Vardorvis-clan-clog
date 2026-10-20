import { expect, test, type Page } from './test.ts';
import { mockApi } from './mock-api.ts';

const open = async (
  page: Page,
  collector: string,
  reviewed = false,
  unmatched = false,
) => {
  await page.goto('/admin/submissions');
  if (reviewed)
    await page.getByRole('button', { name: 'Reviewed', exact: true }).click();
  if (unmatched)
    await page.getByRole('button', { name: 'Unmatched', exact: true }).click();
  await page
    .getByRole('button', { name: new RegExp('^Review ' + collector + ' ·') })
    .click();
  const editor = page.locator('.submission-editor');
  await expect(editor).toBeVisible();
  return editor;
};

test('separate collection flags and verification remain usable in a mobile review', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page);
  const editor = await open(page, 'Oakheart');
  const flags = editor.getByRole('group', {
    name: 'Collection flags',
    exact: true,
  });
  await flags
    .getByLabel('Collected on hardcore worlds', { exact: true })
    .check();
  const acknowledge = editor.getByLabel(/^I checked the screenshot/);
  await expect(acknowledge).toBeEnabled();
  await acknowledge.check();
  await expect(
    editor.getByRole('button', { name: 'Approve submission' }),
  ).toBeEnabled();
  await flags.scrollIntoViewIfNeeded();
  const bounds = (await flags.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: test.info().outputPath('mobile-review-flags.png'),
  });
});

test('manual entry always offers hardcore, defaults to Regular and excludes Event for hardcore', async ({
  page,
}) => {
  const { admin } = await mockApi(page);
  expect(admin.publicSettings().hardcoreEnabled).toBe(false);
  await page.goto('/admin/submissions');
  await page.getByRole('button', { name: 'Add manual submission' }).click();
  const form = page
    .locator('form')
    .filter({ has: page.locator('.manual-submission-columns') });
  const hc = form.getByLabel('Collected on hardcore worlds', { exact: true }),
    event = form.getByLabel('Obtained during events', { exact: true });
  await expect(hc).toBeVisible();
  await expect(event).not.toBeChecked();
  await expect(form.getByLabel('Approve immediately')).toBeChecked();
  await event.check();
  await hc.check();
  await expect(event).not.toBeChecked();
  await expect(event).toBeDisabled();
  await hc.uncheck();
  await expect(event).not.toBeChecked();
  await expect(event).toBeEnabled();
  await hc.check();
  await form
    .getByLabel('Collector name', { exact: true })
    .fill('Manual hardcore');
  await form
    .getByLabel('Canonical item', { exact: true })
    .selectOption({ index: 1 });
  await form.getByLabel('Collection date', { exact: true }).fill('2026-01-01');
  await form.getByRole('button', { name: 'Create manual submission' }).click();
  await page.getByRole('button', { name: /^Review Manual hardcore ·/ }).click();
  const editor = page.locator('.submission-editor');
  await expect(editor.locator('.submission-facts')).toContainText(
    'Hardcore worlds',
  );
  await expect(editor.locator('.submission-facts')).toContainText(
    'Regular collection',
  );
  await page.screenshot({
    path: test.info().outputPath('manual-hardcore-disabled-public.png'),
  });
});

for (const flag of ['hardcore', 'event'] as const) {
  test(`pending ${flag} changes save with approval, reset acknowledgement and stay outside corrections`, async ({
    page,
  }) => {
    const { admin } = await mockApi(page);
    const signal = new AbortController().signal;
    const itemId = (await admin.catalog(signal)).items[0]!.id;
    const row = await admin.addManual(
      {
        itemId,
        collectorName: 'Pending flags',
        collectedOn: '2026-01-01',
        hardcore: false,
        approve: false,
      },
      crypto.randomUUID(),
      'test-admin',
      signal,
    );
    const writes: { path: string; payload: Record<string, unknown> }[] = [];
    page.on('request', (req) => {
      if (
        req.method() !== 'GET' &&
        req.url().includes('/submissions/' + row.id)
      )
        writes.push({
          path: new URL(req.url()).pathname,
          payload: req.postDataJSON(),
        });
    });
    const editor = await open(page, 'Pending flags');
    const check = editor.getByLabel(/^I verified this manual claim/);
    const control = editor.getByLabel(
      flag === 'hardcore'
        ? 'Collected on hardcore worlds'
        : 'Obtained during events',
      { exact: true },
    );
    await expect(
      editor
        .getByRole('group', { name: 'Saved claim and corrections' })
        .getByLabel('Collected on hardcore worlds'),
    ).toHaveCount(0);
    await check.check();
    await control.check();
    await expect(check).not.toBeChecked();
    await expect(check).toBeEnabled();
    await expect(
      editor.getByRole('button', { name: 'Save corrections', exact: true }),
    ).toBeDisabled();
    await expect(
      editor.getByText(
        'Save or discard corrections before deciding on this claim.',
        { exact: true },
      ),
    ).toHaveCount(0);
    expect(writes).toHaveLength(0);
    await check.check();
    await editor.getByRole('button', { name: 'Approve submission' }).click();
    await expect(
      page.getByText('Saved submission state: approved.', { exact: true }),
    ).toBeVisible();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toMatch(/\/approve$/);
    expect(writes[0]!.payload).toEqual({
      expectedVersion: 1,
      flags: {
        hardcore: flag === 'hardcore',
        collectionType: flag === 'event' ? 'event' : 'regular',
      },
    });
    const saved = (await admin.detail(row.id, signal)).submission;
    expect(saved.version).toBe(2);
    expect(saved.hardcore).toBe(flag === 'hardcore');
    expect(saved.collectionType).toBe(flag === 'event' ? 'event' : 'regular');
    await page.screenshot({
      path: test.info().outputPath(`pending-${flag}-approved.png`),
    });
  });
}

test('unmatched claims can be rejected with flags while real corrections still block acknowledgement/decisions', async ({
  page,
}) => {
  const { admin } = await mockApi(page);
  const editor = await open(page, 'Iron Fern', false, true);
  await editor
    .getByLabel('Collected on hardcore worlds', { exact: true })
    .check();
  await editor
    .getByLabel(/^Review reason/)
    .fill('Cannot verify submitted item');
  await editor.getByRole('button', { name: 'Reject submission' }).click();
  const row = (
    await admin.detail('sample-unmatched', new AbortController().signal)
  ).submission;
  expect(row.status).toBe('rejected');
  expect(row.hardcore).toBe(true);
  await expect(
    editor.getByLabel('Collected on hardcore worlds'),
  ).toBeDisabled();
  await expect(editor.getByLabel('Obtained during events')).toBeDisabled();
  await editor.getByRole('button', { name: 'Close review' }).click();
  await page.getByRole('button', { name: 'Pending', exact: true }).click();
  await page.getByRole('button', { name: /^Review Oakheart ·/ }).click();
  await editor.getByLabel('Obtained during events').check();
  await editor
    .getByLabel('Collector name', { exact: true })
    .fill('Corrected name');
  const acknowledge = editor.getByLabel(/^I checked the screenshot/);
  await expect(acknowledge).toBeDisabled();
  await editor
    .getByRole('button', { name: 'Save corrections', exact: true })
    .click();
  await expect(editor.getByLabel('Obtained during events')).toBeChecked();
  await expect(acknowledge).toBeEnabled();
  await acknowledge.check();
  await editor.getByRole('button', { name: 'Approve submission' }).click();
  expect(
    (await admin.detail('sample-ordinary', new AbortController().signal))
      .submission.collectionType,
  ).toBe('event');
});

test('approved flag saves preserve separate correction/note drafts and use a dedicated reasoned action', async ({
  page,
}) => {
  const { admin } = await mockApi(page);
  const signal = new AbortController().signal;
  const row = await admin.addManual(
    {
      itemId: (await admin.catalog(signal)).items[0]!.id,
      collectorName: 'Approved flags',
      collectedOn: '2026-01-01',
      hardcore: false,
      approve: true,
    },
    crypto.randomUUID(),
    'test-admin',
    signal,
  );
  const editor = await open(page, 'Approved flags', true);
  await editor
    .getByLabel('Collector name', { exact: true })
    .fill('Correction draft');
  await editor
    .getByRole('textbox', { name: 'Review note (optional)', exact: true })
    .fill('Saved note');
  await editor.getByLabel('Obtained during events').check();
  await editor.getByRole('button', { name: 'Save review note' }).click();
  await expect(editor.getByLabel('Obtained during events')).toBeChecked();
  await expect(
    editor.getByLabel('Collector name', { exact: true }),
  ).toHaveValue('Correction draft');
  await editor
    .getByRole('textbox', { name: 'Review note (optional)', exact: true })
    .fill('Unsaved note draft');
  const save = editor.getByRole('button', { name: 'Save collection flags' });
  await expect(save).toBeDisabled();
  await editor.getByLabel(/^Review reason/).fill('Verified event proof');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(
    editor.getByText('Collection flags saved.', { exact: true }),
  ).toBeVisible();
  await expect(
    editor.getByLabel('Collector name', { exact: true }),
  ).toHaveValue('Correction draft');
  await expect(
    editor.getByRole('textbox', {
      name: 'Review note (optional)',
      exact: true,
    }),
  ).toHaveValue('Unsaved note draft');
  const saved = (await admin.detail(row.id, signal)).submission;
  expect(saved.collectionType).toBe('event');
  expect(saved.collectorName).toBe('Approved flags');
  expect(saved.reviewNote).toBe('Saved note');
  await page.screenshot({
    path: test.info().outputPath('approved-independent-flags.png'),
  });
  await editor
    .getByRole('button', { name: 'Save corrections', exact: true })
    .click();
  await expect(
    editor.getByRole('textbox', {
      name: 'Review note (optional)',
      exact: true,
    }),
  ).toHaveValue('Unsaved note draft');
  expect((await admin.detail(row.id, signal)).submission.collectionType).toBe(
    'event',
  );
});

test('restoring intake timing is an explicit flags decision and stale flag saves retain drafts', async ({
  page,
}) => {
  const { admin } = await mockApi(page);
  const editor = await open(page, 'Oakheart');
  const request = page.waitForRequest(
    (req) =>
      req.method() === 'POST' && req.url().endsWith('/sample-ordinary/approve'),
  );
  await editor.getByRole('button', { name: 'Use saved intake timing' }).click();
  await editor.getByLabel(/^I checked the screenshot/).check();
  await editor.getByRole('button', { name: 'Approve submission' }).click();
  expect((await request).postDataJSON().flags).toEqual({
    hardcore: false,
    useIntakeTiming: true,
  });
  await expect(
    page.getByText('Saved submission state: approved.', { exact: true }),
  ).toBeVisible();
  await editor.getByLabel('Obtained during events').check();
  await editor
    .getByLabel('Collector name', { exact: true })
    .fill('Retained draft');
  await editor
    .getByRole('textbox', { name: 'Review note (optional)', exact: true })
    .fill('Retained note');
  await editor.getByLabel(/^Review reason/).fill('Reason');
  const signal = new AbortController().signal;
  const latest = await admin.detail('sample-ordinary', signal);
  await admin.saveReviewNote(
    'sample-ordinary',
    latest.submission.version,
    'Concurrent staff note',
    'test-admin',
    signal,
  );
  await editor.getByRole('button', { name: 'Save collection flags' }).click();
  await expect(
    editor.getByText(/Your local drafts are retained/),
  ).toBeVisible();
  await expect(
    editor.getByLabel('Collector name', { exact: true }),
  ).toHaveValue('Retained draft');
  await expect(
    editor.getByRole('textbox', {
      name: 'Review note (optional)',
      exact: true,
    }),
  ).toHaveValue('Retained note');
  await expect(editor.getByLabel('Obtained during events')).toBeChecked();
});
