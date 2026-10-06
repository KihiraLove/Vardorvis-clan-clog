import assert from 'node:assert/strict';
import { test } from 'node:test';
import { itemState, progress } from './model.ts';
import {
  moveItem,
  parseAdminCatalog,
  parseDetail,
  parseQueue,
  safeProof,
  validateCorrection,
  validateIconFile,
  validateIconSize,
  validateItem,
  validateOrder,
  type Correction,
} from './admin-model.ts';
import { PreviewAdminClient } from './preview/admin.ts';

const signal = () => new AbortController().signal;
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
    'https://u:p@imgur.com/proof',
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

test('item creation requires name/icon/pages while game IDs remain optional', async () => {
  const catalog = await new PreviewAdminClient().catalog(signal()),
    page = catalog.pages[0]!.id;
  const valid = { name: ' New drop ', iconAssetId: 'asset', pageIds: [page] };
  assert.equal(validateItem(valid, catalog).name, 'New drop');
  for (const fields of [
    { ...valid, name: ' ' },
    { ...valid, iconAssetId: '' },
    { ...valid, pageIds: [] },
    { ...valid, pageIds: [page, page] },
    { ...valid, pageIds: ['missing'] },
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
