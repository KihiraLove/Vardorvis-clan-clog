import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { decodeScreenshot, MAX_SCREENSHOT_BYTES } from './proof-storage.js';
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
