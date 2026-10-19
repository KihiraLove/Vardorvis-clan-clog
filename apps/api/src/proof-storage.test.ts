import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import {
  decodeScreenshot,
  MAX_SCREENSHOT_BYTES,
  ProofStorage,
} from './proof-storage.js';
test('screenshots allow game-sized PNGs, strip metadata and reject invalid formats, dimensions and oversized input', async () => {
  const png = await sharp({
    create: { width: 1920, height: 1080, channels: 3, background: '#223344' },
  })
    .withMetadata()
    .png()
    .toBuffer();
  const decoded = await decodeScreenshot(png, 'image/png');
  assert.equal(decoded.width, 1920);
  assert.equal(decoded.height, 1080);
  assert.equal((await sharp(decoded.bytes).metadata()).exif, undefined);
  assert.equal((await sharp(decoded.bytes).metadata()).format, 'webp');
  assert.deepEqual(
    await sharp(decoded.bytes).raw().toBuffer(),
    await sharp(png).raw().toBuffer(),
  );
  await assert.rejects(decodeScreenshot(png, 'image/jpeg'), { status: 400 });
  await assert.rejects(
    decodeScreenshot(Buffer.from('not a PNG'), 'image/png'),
    { status: 400 },
  );
  await assert.rejects(
    decodeScreenshot(png.subarray(0, png.length / 2), 'image/png'),
    { status: 400 },
  );
  await assert.rejects(
    decodeScreenshot(Buffer.alloc(MAX_SCREENSHOT_BYTES + 1), 'image/png'),
    { status: 413 },
  );
  const wide = await sharp({
    create: { width: 8193, height: 1, channels: 3, background: '#223344' },
  })
    .png()
    .toBuffer();
  await assert.rejects(decodeScreenshot(wide, 'image/png'), { status: 400 });
});

test('proof storage persists only lossless WebP, survives restart and leaves nothing after invalid conversion or removal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clog-webp-proof-'));
  try {
    const storage = new ProofStorage(directory);
    await storage.initialize();
    const png = await sharp({
      create: { width: 640, height: 480, channels: 4, background: '#12345680' },
    })
      .png()
      .toBuffer();
    const record = await storage.save(png, 'image/png');
    assert.deepEqual(await readdir(directory), [record.id + '.webp']);
    const bytes = await new ProofStorage(directory).read(record);
    assert.equal((await sharp(bytes).metadata()).format, 'webp');
    assert.deepEqual(
      await sharp(bytes).ensureAlpha().raw().toBuffer(),
      await sharp(png).ensureAlpha().raw().toBuffer(),
    );
    await assert.rejects(
      storage.save(Buffer.from('invalid PNG'), 'image/png'),
      { status: 400 },
    );
    assert.deepEqual(await readdir(directory), [record.id + '.webp']);
    await assert.rejects(
      new ProofStorage(join(directory, 'missing')).save(png, 'image/png'),
      { status: 503 },
    );
    assert.deepEqual(await readdir(directory), [record.id + '.webp']);
    await storage.remove(record.id);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
