import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import sharp from 'sharp';

const root = new URL('../', import.meta.url);
async function files(directory) {
  const entries = await readdir(new URL(directory, root), {
    withFileTypes: true,
  });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? files(directory + entry.name + '/')
          : [directory + entry.name],
      ),
    )
  ).flat();
}
test('bundled production and fixture image files are readable WebP only', async () => {
  const paths = [
    ...(await files('apps/web/public/')),
    ...(await files('apps/web/tests/support/items/')),
  ];
  let images = 0;
  for (const path of paths) {
    assert.doesNotMatch(path, /\.(png|svg|ico|jpe?g|gif|avif|tiff?)$/iu, path);
    if (!path.endsWith('.webp')) continue;
    const metadata = await sharp(
      await readFile(new URL(path, root)),
    ).metadata();
    assert.equal(metadata.format, 'webp', path);
    assert.ok(metadata.width && metadata.height, path);
    images++;
  }
  assert.ok(images > 2000);
});
test('skill provenance separates pinned input hashes from lossless WebP output', async () => {
  const provenance = JSON.parse(
    await readFile(
      new URL('apps/web/public/skills/provenance.json', root),
      'utf8',
    ),
  );
  for (const asset of provenance.assets) {
    assert.match(asset.file, /\.webp$/u);
    assert.match(asset.sourcePath, /\.png$/u);
    assert.match(asset.sourceSha256, /^[a-f0-9]{64}$/u);
    const bytes = await readFile(
      new URL('apps/web/public/skills/' + asset.file, root),
    );
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      asset.sha256,
    );
    assert.equal(bytes.toString('ascii', 8, 16), 'WEBPVP8L');
  }
});
