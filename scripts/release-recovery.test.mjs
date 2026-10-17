import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildBundle, infrastructureFiles } from './release-bundle.mjs';

test('release bundle binds exact infrastructure and migration bytes without copying host secrets', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'clog-bundle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bundle = await buildBundle(
    process.cwd(),
    directory,
    'a'.repeat(40),
    'local-acceptance',
  );
  const saved = JSON.parse(
    await readFile(path.join(directory, 'manifest.json'), 'utf8'),
  );
  assert.equal(saved.revision, 'a'.repeat(40));
  assert.equal(saved.evidence, 'local-acceptance');
  assert.equal(saved.migrations.length, 24);
  assert.deepEqual(
    Object.keys(saved.files).filter((name) => !name.startsWith('packages/')),
    infrastructureFiles,
  );
  for (const entry of saved.migrations) {
    const bytes = await readFile(
      path.join(directory, 'packages/database/migrations', entry.name),
    );
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      entry.checksum,
    );
  }
  assert.equal(bundle.format, 1);
  await assert.rejects(access(path.join(directory, '.env')));
});

test('invalid release identity and evidence fail before reading or copying infrastructure', async () => {
  for (const revision of ['main', '../outside', 'A'.repeat(40), 'a'.repeat(39)])
    await assert.rejects(
      buildBundle('missing', 'unused', revision, 'local-acceptance'),
      /Invalid release revision/,
    );
  for (const evidence of [
    'https://example.com/run',
    'https://github.com/a/b/actions/runs/not-a-run',
    'private token',
  ])
    await assert.rejects(
      buildBundle('missing', 'unused', 'a'.repeat(40), evidence),
      /Invalid release evidence/,
    );
});
