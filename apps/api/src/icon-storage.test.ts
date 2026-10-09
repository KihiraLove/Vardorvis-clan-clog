/** Raster safety and on-disk restart/integrity checks need no external services. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { decodeIcon, IconStorage, MAX_ICON_BYTES } from './icon-storage.js';

test('PNG and WebP decode to lossless PNG retaining native dimensions and transparency', async () => {
  const pixels = Buffer.from([
    255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 255, 255, 255, 255,
  ]);
  for (const format of ['png', 'webp'] as const) {
    const source = sharp(pixels, { raw: { width: 2, height: 2, channels: 4 } });
    const input = await (
      format === 'png' ? source.png() : source.webp({ lossless: true })
    ).toBuffer();
    const result = await decodeIcon(input, 'image/' + format);
    assert.equal(result.width, 2);
    assert.equal(result.height, 2);
    const decoded = await sharp(result.bytes).ensureAlpha().raw().toBuffer();
    assert.equal(decoded[3], 255);
    assert.equal(decoded[7], 128);
    assert.equal(decoded[11], 0);
    assert.deepEqual(decoded.subarray(0, 8), pixels.subarray(0, 8));
  }
});
test('raster validation rejects bad MIME, corrupt/truncated input, oversized dimensions and bytes', async () => {
  const good = await sharp({
    create: { width: 1, height: 1, channels: 4, background: '#00000000' },
  })
    .png()
    .toBuffer();
  for (const [bytes, mime] of [
    [good, 'image/jpeg'],
    [good, 'image/webp'],
    [Buffer.from('<svg/>'), 'image/png'],
    [good.subarray(0, 30), 'image/png'],
    [Buffer.alloc(MAX_ICON_BYTES + 1), 'image/png'],
  ] as const)
    await assert.rejects(decodeIcon(bytes, mime));
  const wide = await sharp({
    create: { width: 513, height: 1, channels: 4, background: '#00000000' },
  })
    .png()
    .toBuffer();
  await assert.rejects(decodeIcon(wide, 'image/png'));
});
test('generated durable icons survive new storage instances and fail closed on corruption or unavailable storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clog-icons-'));
  try {
    const bytes = await sharp({
      create: { width: 36, height: 32, channels: 4, background: '#ff000080' },
    })
      .png()
      .toBuffer();
    const storage = new IconStorage(directory);
    await storage.initialize();
    const record = await storage.save(bytes, 'image/png');
    const again = new IconStorage(directory);
    assert.deepEqual(await again.read(record), await storage.read(record));
    assert.deepEqual(
      await readFile(join(directory, record.id + '.png')),
      await storage.read(record),
    );
    await writeFile(join(directory, record.id + '.png'), 'corrupt');
    await assert.rejects(again.read(record), { status: 503 });
    await assert.rejects(
      new IconStorage(join(directory, 'missing')).save(bytes, 'image/png'),
      { status: 503 },
    );
    await assert.rejects(storage.read({ ...record, id: '../escape' }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
