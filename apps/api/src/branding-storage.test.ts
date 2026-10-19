import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  BrandingStorage,
  decodeLogo,
  MAX_LOGO_BYTES,
} from './branding-storage.js';

export async function animatedLogo(format: 'gif' | 'webp') {
  const pixels = Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]);
  const image = sharp(pixels, {
    raw: { width: 1, height: 2, channels: 4, pageHeight: 1 },
  });
  return format === 'gif'
    ? image.gif({ delay: [120, 230], loop: 3 }).toBuffer()
    : image.webp({ lossless: true, delay: [120, 230], loop: 3 }).toBuffer();
}
test('logos accept content-detected still image formats, rasterise SVG, orient and bound their display size', async () => {
  const base = sharp({
    create: { width: 24, height: 12, channels: 4, background: '#12345678' },
  });
  for (const format of [
    'png',
    'jpeg',
    'webp',
    'gif',
    'avif',
    'tiff',
  ] as const) {
    const decoded = await decodeLogo(
      await base.clone().toFormat(format).toBuffer(),
    );
    const metadata = await sharp(decoded.bytes).metadata();
    assert.equal(metadata.format, 'webp');
    assert.equal(metadata.width, 24);
    assert.equal(metadata.height, 12);
    assert.equal(metadata.exif, undefined);
  }
  const vector = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="1024"><script>alert(1)</script><rect width="2048" height="1024" fill="red"/></svg>',
  );
  const decoded = await decodeLogo(vector);
  assert.equal(decoded.width, 1024);
  assert.equal(decoded.height, 512);
  assert.equal(decoded.bytes.includes(Buffer.from('<script>')), false);
  const oriented = await decodeLogo(
    await base.clone().jpeg().withMetadata({ orientation: 6 }).toBuffer(),
  );
  assert.equal(oriented.width, 12);
  assert.equal(oriented.height, 24);
});
test('GIF and WebP retain all frames, colours, delays and loop count; durable favicon uses the first frame', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clog-logo-'));
  try {
    const storage = new BrandingStorage(directory);
    await storage.initialize();
    for (const format of ['gif', 'webp'] as const) {
      const record = await storage.saveLogo(await animatedLogo(format));
      const restarted = new BrandingStorage(directory);
      const bytes = await restarted.read(record.logo),
        metadata = await sharp(bytes, { animated: true }).metadata();
      assert.equal(metadata.pages, 2);
      assert.deepEqual(metadata.delay, [120, 230]);
      assert.equal(metadata.loop, 3);
      const frames = await sharp(bytes, { animated: true })
        .ensureAlpha()
        .raw()
        .toBuffer();
      assert.deepEqual(Array.from(frames), [255, 0, 0, 255, 0, 0, 255, 255]);
      const favicon = await restarted.favicons.read(record.favicon);
      const icon = await sharp(favicon).metadata();
      assert.equal(icon.format, 'webp');
      assert.equal(icon.pages ?? 1, 1);
      const pixels = await sharp(favicon).ensureAlpha().raw().toBuffer();
      assert.deepEqual(
        Array.from(pixels.subarray((32 * 64 + 32) * 4, (32 * 64 + 32) * 4 + 4)),
        [255, 0, 0, 255],
      );
      await writeFile(
        join(directory, record.logo.id + '.webp'),
        Buffer.from('corrupt'),
      );
      await assert.rejects(restarted.read(record.logo), /unavailable/u);
      await storage.removeLogo(record);
    }
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('invalid, oversized and excessive-frame images are rejected before persistence', async () => {
  await assert.rejects(decodeLogo(Buffer.from('<html>not an image</html>')), {
    status: 400,
  });
  await assert.rejects(decodeLogo(Buffer.alloc(MAX_LOGO_BYTES + 1)), {
    status: 413,
  });
  await assert.rejects(
    decodeLogo(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="9000" height="1"/>',
      ),
    ),
    { status: 400 },
  );
  const frames = await sharp({
    create: {
      width: 1,
      height: 301,
      pageHeight: 1,
      channels: 4,
      background: 'red',
    },
  })
    .gif({ keepDuplicateFrames: true })
    .toBuffer();
  await assert.rejects(decodeLogo(frames), { status: 400 });
});
