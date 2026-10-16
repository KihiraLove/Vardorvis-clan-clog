/** Validate private data and preview transitions, including shared credits and catalog edits. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { itemState, progress } from './model.ts';
import {
  dateSourceLabel,
  moveItem,
  parseAdminCatalog,
  parseDetail,
  parseQueue,
  parseSubmission,
  safeProof,
  safeScreenshotPath,
  validateCorrection,
  validateIconFile,
  validateIconSize,
  validateItem,
  validateOrder,
  type Correction,
} from './admin-model.ts';
import { PreviewAdminClient } from './preview/admin.ts';

const signal = () => new AbortController().signal;

test('RuneLite chat proof preserves full text and rejects malformed private evidence', async () => {
  const seed = (
    await new PreviewAdminClient().queue('pending', undefined, signal())
  ).submissions[0]!;
  const chatMessage =
    '  Collector received <item>: Rare item & coins.\n符号 😀  ';
  const row = {
    ...seed,
    source: 'runelite',
    proofUrl: '',
    screenshotPath: null,
    chatMessage,
  };
  assert.equal(parseSubmission(row).chatMessage, chatMessage);
  for (const invalid of [null, {}, '', 'a'.repeat(8193)])
    assert.throws(() => parseSubmission({ ...row, chatMessage: invalid }));
  assert.throws(() => parseSubmission({ ...row, source: 'discord' }));
});

test('preview audit pagination retains every event, binds scope/revision and validates bounded wire pages', async () => {
  const client = new PreviewAdminClient();
  const queue = await client.queue('pending', undefined, signal());
  let row = queue.submissions[0]!;
  for (let n = 1; n <= 25; n++)
    row = await client.saveReviewNote(
      row.id,
      row.version,
      'Staff note ' + n,
      'csrf',
      signal(),
    );
  const first = parseDetail(await client.detail(row.id, signal()));
  const second = parseDetail(
    await client.detail(row.id, signal(), first.nextAuditCursor!),
  );
  assert.equal(first.audit.length, 20);
  assert.equal(second.audit.length, 5);
  assert.equal(second.nextAuditCursor, null);
  assert.equal(
    new Set([...first.audit, ...second.audit].map((a) => a.id)).size,
    25,
  );
  assert.equal(second.audit.at(-1)!.after.reviewNote, 'Staff note 1');
  assert.deepEqual(
    await client.detail(row.id, signal(), first.auditCursor),
    first,
  );
  await assert.rejects(
    client.detail(queue.submissions[1]!.id, signal(), first.nextAuditCursor!),
    { status: 409 },
  );
  const freshQueue = await client.queue('pending', undefined, signal());
  await assert.rejects(
    client.queue('reviewed', freshQueue.pageCursor, signal()),
    { status: 409 },
  );
  await client.saveReviewNote(
    row.id,
    row.version,
    'Newer event',
    'csrf',
    signal(),
  );
  await assert.rejects(client.detail(row.id, signal(), first.auditCursor), {
    status: 409,
  });
  await assert.rejects(
    client.queue('pending', freshQueue.pageCursor, signal()),
    { status: 409 },
  );
  assert.throws(
    () => parseDetail({ ...first, audit: [...first.audit, ...second.audit] }),
    /size/,
  );
  assert.throws(
    () => parseDetail({ ...first, nextAuditCursor: undefined }),
    /text/,
  );
  assert.throws(
    () => parseQueue({ ...freshQueue, pageCursor: undefined }, 'pending'),
    /text/,
  );
});

test('stored evidence accepts only generated private PNG paths and survives RuneLite parsing', async () => {
  const client = new PreviewAdminClient();
  const fixture = (await client.queue('pending', undefined, signal()))
    .submissions[0]!;
  const path =
    '/api/v1/admin/submission-images/00000000-0000-4000-8000-000000000001.png';
  assert.equal(safeScreenshotPath(path), true);
  for (const value of [
    'https://evil.test/proof.png',
    '//evil.test/proof.png',
    '/api/v1/admin/submission-images/../../proof.png',
    path + '?token=secret',
    'data:image/png;base64,AAAA',
  ]) {
    assert.equal(safeScreenshotPath(value), false);
    assert.throws(
      () =>
        parseSubmission({
          ...fixture,
          source: 'runelite',
          proofUrl: '',
          screenshotPath: value,
        }),
      /screenshot/u,
    );
  }
  assert.equal(
    parseSubmission({
      ...fixture,
      source: 'runelite',
      proofUrl: '',
      screenshotPath: path,
    }).source,
    'runelite',
  );
});
const iconFile = () =>
  new File(
    [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])],
    'icon.png',
    { type: 'image/png' },
  );
const correction = (itemId: number): Correction => ({
  itemId,
  collectorName: ' KihiraVD ',
  collectedOn: '2026-10-05',
  hardcore: false,
  reason: '',
});

test('admin payloads validate identities, view boundaries, dates and source metadata', async () => {
  const client = new PreviewAdminClient(),
    catalog = await client.catalog(signal());
  parseAdminCatalog(catalog);
  const queue = await client.queue('pending', undefined, signal());
  parseQueue(queue, 'pending');
  parseDetail(await client.detail(queue.submissions[0]!.id, signal()));
  assert.throws(
    () =>
      parseQueue(
        { ...queue, submissions: [queue.submissions[0], queue.submissions[0]] },
        'pending',
      ),
    /Duplicate/,
  );
  assert.throws(() => parseQueue(queue, 'reviewed'), /Unexpected/);
  assert.throws(() => parseQueue(queue, 'unmatched'), /Unexpected/);
  assert.throws(
    () =>
      parseAdminCatalog({
        ...catalog,
        items: [{ ...catalog.items[0], origin: 'unknown' }],
        pages: [],
      }),
    /Invalid admin/,
  );
  assert.throws(
    () =>
      parseDetail({
        submission: { ...queue.submissions[0], collectedOn: '2026-02-30' },
        audit: [],
      }),
    /calendar/,
  );
});

test('proof links block spoofed/unsafe origins without requiring an external fetch', () => {
  assert.equal(
    safeProof('https://imgur.com/a/proof'),
    'https://imgur.com/a/proof',
  );
  assert.equal(
    safeProof('https://i.gyazo.com/proof.png'),
    'https://i.gyazo.com/proof.png',
  );
  for (const input of [
    'javascript:alert(1)',
    'https://imgur.com.evil.test/proof',
    'http://imgur.com/proof',
    '***imgur.com/proof',
    'https://imgur.com:444/proof',
  ])
    assert.equal(safeProof(input), undefined);
});

test('corrections require a canonical item and valid collector/calendar date', async () => {
  const catalog = await new PreviewAdminClient().catalog(signal());
  const id = catalog.items[0]!.id;
  assert.equal(
    validateCorrection(correction(id), catalog).collectorName,
    'KihiraVD',
  );
  assert.throws(() => validateCorrection(correction(0), catalog), /specific/);
  assert.throws(
    () =>
      validateCorrection({ ...correction(id), collectorName: ' ' }, catalog),
    /collector/,
  );
  assert.throws(
    () =>
      validateCorrection(
        { ...correction(id), collectedOn: '2026-02-29' },
        catalog,
      ),
    /calendar/,
  );
});

test('item creation requires name/icon/pages and in-game IDs', async () => {
  const catalog = await new PreviewAdminClient().catalog(signal()),
    page = catalog.pages[0]!.id;
  const valid = {
    name: ' New drop ',
    gameItemIds: [900001],
    iconAssetId: 'asset',
    pageIds: [page],
  };
  assert.equal(validateItem(valid, catalog).name, 'New drop');
  for (const fields of [
    { ...valid, name: ' ' },
    { ...valid, gameItemIds: [900001], iconAssetId: '' },
    { ...valid, pageIds: [] },
    { ...valid, pageIds: [page, page] },
    { ...valid, pageIds: ['missing'] },
    { ...valid, gameItemIds: [] },
    { ...valid, gameItemIds: [1, 1] },
    { ...valid, gameItemIds: [2147483648] },
  ])
    assert.throws(() => validateItem(fields, catalog));
});

test('icon input rejects empty/oversized/non-raster/spoofed content and invalid dimensions', async () => {
  await validateIconFile(iconFile());
  for (const file of [
    new File([], 'empty.png', { type: 'image/png' }),
    new File(['<svg/>'], 'icon.svg', { type: 'image/svg+xml' }),
    new File(['not png'], 'icon.png', { type: 'image/png' }),
    new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'large.png', {
      type: 'image/png',
    }),
  ])
    await assert.rejects(validateIconFile(file));
  validateIconSize(32, 32);
  for (const [w, h] of [
    [0, 32],
    [513, 32],
    [32, 513],
    [1.5, 32],
  ])
    assert.throws(() => validateIconSize(w!, h!));
});

test('order operations retain exact membership and support deterministic keyboard/drag moves', () => {
  assert.deepEqual(moveItem([1, 2, 3], 0, 2), [2, 3, 1]);
  assert.deepEqual(moveItem([1, 2, 3], 2, 0), [3, 1, 2]);
  validateOrder([1, 2, 3], [3, 1, 2]);
  for (const ids of [
    [1, 2],
    [1, 2, 2],
    [1, 2, 4],
  ])
    assert.throws(() => validateOrder([1, 2, 3], ids));
  assert.throws(() => moveItem([1, 2], 0, 2));
});

test('preview approvals propagate across shared pages and revoking hardcore preserves ordinary credit', async () => {
  const client = new PreviewAdminClient();
  assert.equal(client.publicLog().collections.credits.length, 0);
  const hc = (await client.detail('sample-hardcore', signal())).submission;
  const approved = await client.decide(
    hc.id,
    hc.version,
    'approve',
    '',
    'preview-admin',
    signal(),
  );
  assert.equal(
    itemState(hc.itemId!, client.publicLog().collections.credits)
      .hardcoreCollected,
    true,
  );
  const log = client.publicLog(),
    shared = log.catalog.pages.filter((page) =>
      page.itemIds.includes(hc.itemId!),
    );
  assert.ok(shared.length >= 4);
  for (const page of shared)
    assert.equal(progress(page.itemIds, log.collections.credits).collected, 1);
  const normal = (await client.detail('sample-ordinary', signal())).submission;
  const ordinary = await client.decide(
    normal.id,
    normal.version,
    'approve',
    '',
    'preview-admin',
    signal(),
  );
  await client.decide(
    hc.id,
    approved.version,
    'revoke',
    'Proof belongs to another world',
    'preview-admin',
    signal(),
  );
  assert.equal(
    itemState(hc.itemId!, client.publicLog().collections.credits).collected,
    true,
  );
  assert.equal(
    itemState(hc.itemId!, client.publicLog().collections.credits)
      .hardcoreCollected,
    false,
  );
  await client.decide(
    normal.id,
    ordinary.version,
    'revoke',
    'Duplicate evidence',
    'preview-admin',
    signal(),
  );
  assert.equal(client.publicLog().collections.credits.length, 0);
  const audit = await client.detail(hc.id, signal());
  assert.deepEqual(
    audit.audit.map((a) => a.action),
    ['revoke', 'approve'],
  );
  assert.equal(audit.audit[0]!.before.status, 'approved');
  assert.equal(audit.audit[0]!.after.status, 'revoked');
});

test('unmatched approval is denied, stale/double decisions fail and approved corrections need a reason', async () => {
  const client = new PreviewAdminClient();
  const row = (await client.detail('sample-unmatched', signal())).submission;
  await assert.rejects(
    client.decide(row.id, row.version, 'approve', '', 'csrf', signal()),
    { status: 422 },
  );
  const catalog = await client.catalog(signal());
  const matched = await client.edit(
    row.id,
    row.version,
    correction(catalog.items[0]!.id),
    'csrf',
    signal(),
  );
  assert.equal(matched.itemId, catalog.items[0]!.id);
  await assert.rejects(
    client.edit(
      row.id,
      row.version,
      correction(catalog.items[0]!.id),
      'csrf',
      signal(),
    ),
    { status: 409 },
  );
  const approved = await client.decide(
    row.id,
    matched.version,
    'approve',
    '',
    'csrf',
    signal(),
  );
  await assert.rejects(
    client.decide(row.id, matched.version, 'approve', '', 'csrf', signal()),
    { status: 409 },
  );
  await assert.rejects(
    client.edit(
      row.id,
      approved.version,
      correction(catalog.items[0]!.id),
      'csrf',
      signal(),
    ),
    { status: 422 },
  );
  const corrected = await client.edit(
    row.id,
    approved.version,
    {
      ...correction(catalog.items[0]!.id),
      hardcore: true,
      reason: 'Reviewed hardcore proof',
    },
    'csrf',
    signal(),
  );
  assert.equal(
    itemState(corrected.itemId!, client.publicLog().collections.credits)
      .hardcoreCollected,
    true,
  );
});

test('shared manual items append once, are available for matching, and order edits preserve credits/other pages', async () => {
  const client = new PreviewAdminClient();
  try {
    const before = await client.catalog(signal()),
      pages = ['vardorvis', 'duke-sucellus'];
    assert.ok(pages.every((id) => before.pages.some((page) => page.id === id)));
    const asset = await client.upload(iconFile(), 'csrf', signal()),
      fields = {
        name: 'Future clan drop',
        gameItemIds: [900001],
        iconAssetId: asset.assetId,
        pageIds: pages,
      };
    const created = await client.create(
      fields,
      'same-request',
      'csrf',
      signal(),
    );
    assert.deepEqual(
      await client.create(fields, 'same-request', 'csrf', signal()),
      created,
    );
    await assert.rejects(
      client.create(
        { ...fields, name: 'Different' },
        'same-request',
        'csrf',
        signal(),
      ),
      { status: 409 },
    );
    const added = await client.catalog(signal());
    assert.equal(added.items.length, before.items.length + 1);
    assert.equal(
      itemState(created.item.id, client.publicLog().collections.credits)
        .collected,
      false,
    );
    for (const id of pages)
      assert.equal(
        added.pages.find((page) => page.id === id)!.itemIds.at(-1),
        created.item.id,
      );
    const unmatched = (await client.detail('sample-unmatched', signal()))
      .submission;
    const edit = await client.edit(
      unmatched.id,
      unmatched.version,
      correction(created.item.id),
      'csrf',
      signal(),
    );
    await client.decide(edit.id, edit.version, 'approve', '', 'csrf', signal());
    const credits = client.publicLog().collections.credits,
      page = added.pages.find((page) => page.id === pages[0])!;
    const reordered = await client.order(
      page.id,
      moveItem(page.itemIds, page.itemIds.length - 1, 0),
      page.version,
      'csrf',
      signal(),
    );
    assert.equal(reordered.itemIds[0], created.item.id);
    assert.equal(reordered.orderOrigin, 'manual');
    assert.deepEqual(client.publicLog().collections.credits, credits);
    assert.deepEqual(
      (await client.catalog(signal())).pages.find((p) => p.id === pages[1])!
        .itemIds,
      added.pages.find((p) => p.id === pages[1])!.itemIds,
    );
    await assert.rejects(
      client.order(page.id, page.itemIds, page.version, 'csrf', signal()),
      { status: 409 },
    );
  } finally {
    client.dispose();
  }
});

test('logout and aborted reads prevent private preview access; pagination cannot reuse stale cursors', async () => {
  const client = new PreviewAdminClient();
  const first = await client.queue('pending', undefined, signal()),
    second = await client.queue('pending', first.nextCursor!, signal());
  assert.equal(first.submissions.length, 2);
  assert.equal(second.submissions.length, 2);
  assert.ok(
    !second.submissions.some((row) =>
      first.submissions.some((first) => first.id === row.id),
    ),
  );
  const row = first.submissions[0]!;
  await client.decide(
    row.id,
    row.version,
    'reject',
    'Wrong item',
    'csrf',
    signal(),
  );
  await assert.rejects(client.queue('pending', first.nextCursor!, signal()), {
    status: 409,
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.catalog(controller.signal), {
    name: 'AbortError',
  });
  await client.logout('csrf', signal());
  assert.equal(await client.session(signal()), null);
  await assert.rejects(client.catalog(signal()), { status: 401 });
  await assert.rejects(client.detail(row.id, signal()), { status: 401 });
});

test('proofless manual claims and audit snapshots parse without requiring XP text', async () => {
  const client = new PreviewAdminClient();
  const catalog = await client.catalog(signal());
  const item = catalog.items[0]!;
  const created = await client.addManual(
    {
      itemId: item.id,
      collectorName: 'Manual reviewer',
      collectedOn: '2026-10-06',
      hardcore: false,
      approve: true,
    },
    '00000000-0000-4000-8000-000000000001',
    'preview-admin',
    signal(),
  );
  assert.equal(created.proofUrl, '');
  assert.deepEqual(parseSubmission(created), created);
  const detail = await client.detail(created.id, signal());
  assert.equal(parseDetail(detail).submission.proofUrl, '');
  assert.throws(
    () => parseSubmission({ ...created, proofUrl: null }),
    /Invalid submission data/,
  );
});

test('review date source labels differentiate collector claims, server defaults and admin corrections', () => {
  assert.equal(dateSourceLabel('submission'), 'Submission date');
  assert.equal(dateSourceLabel('claim'), 'Collector supplied');
  assert.equal(dateSourceLabel('admin'), 'Admin correction');
});

test('preview staff notes are independent, versioned, auditable, and never change collection credits', async () => {
  const client = new PreviewAdminClient();
  const pending = await client.detail('sample-unmatched', signal());
  assert.equal(pending.submission.itemId, null);
  assert.equal(pending.submission.reviewNote, '');
  const beforeCredits = client.publicLog().collections.credits;
  const saved = await client.saveReviewNote(
    pending.submission.id,
    pending.submission.version,
    '  Staff note without item match  ',
    'preview',
    signal(),
  );
  assert.equal(saved.reviewNote, 'Staff note without item match');
  assert.equal(saved.status, 'pending');
  assert.equal(saved.itemId, null);
  assert.equal(saved.version, pending.submission.version + 1);
  const detail = await client.detail(saved.id, signal());
  assert.equal(detail.audit[0]?.reason, null);
  assert.equal(detail.audit[0]?.before.reviewNote, '');
  assert.equal(detail.audit[0]?.after.reviewNote, saved.reviewNote);
  assert.deepEqual(client.publicLog().collections.credits, beforeCredits);
  await assert.rejects(
    client.saveReviewNote(
      saved.id,
      saved.version,
      saved.reviewNote,
      'preview',
      signal(),
    ),
    { status: 422 },
  );
  await assert.rejects(
    client.saveReviewNote(
      saved.id,
      pending.submission.version,
      'Stale',
      'preview',
      signal(),
    ),
    { status: 409 },
  );
  await assert.rejects(
    client.saveReviewNote(
      saved.id,
      saved.version,
      'x'.repeat(1001),
      'preview',
      signal(),
    ),
    { status: 422 },
  );
  const cleared = await client.saveReviewNote(
    saved.id,
    saved.version,
    '',
    'preview',
    signal(),
  );
  assert.equal(cleared.reviewNote, '');
  assert.equal((await client.detail(saved.id, signal())).audit.length, 2);
  assert.deepEqual(client.publicLog().collections.credits, beforeCredits);

  const ready = await client.detail('sample-hardcore', signal());
  const approved = await client.decide(
    ready.submission.id,
    ready.submission.version,
    'approve',
    '',
    'preview',
    signal(),
  );
  assert.equal(approved.status, 'approved');
  const approvedCredits = client.publicLog().collections.credits;
  const note = await client.saveReviewNote(
    approved.id,
    approved.version,
    'Hardcore proof checked',
    'preview',
    signal(),
  );
  assert.equal(note.reviewNote, 'Hardcore proof checked');
  assert.equal(note.status, 'approved');
  assert.equal(note.hardcore, true);
  assert.deepEqual(client.publicLog().collections.credits, approvedCredits);
  const rejectedPending = await client.detail('sample-ordinary', signal());
  const rejected = await client.decide(
    rejectedPending.submission.id,
    rejectedPending.submission.version,
    'reject',
    'Invalid proof',
    'preview',
    signal(),
  );
  assert.equal(rejected.reviewReason, 'Invalid proof');
  await assert.rejects(
    client.saveReviewNote(
      rejected.id,
      rejected.version,
      'Cannot edit after reject',
      'preview',
      signal(),
    ),
    { status: 422 },
  );
});
