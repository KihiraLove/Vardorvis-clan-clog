/** Release metadata and offline rendering assets must remain self-consistent. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { skills } from '../packages/domain/src/skills.ts';

const json = async (path) => JSON.parse(await readFile(path, 'utf8'));

test('workspace versions, internal dependencies and lockfile describe the same release', async () => {
  const root = await json('package.json');
  const lock = await json('package-lock.json');
  assert.equal(root.name, 'clan-collection-log');
  assert.equal(lock.name, root.name);
  assert.equal(lock.version, root.version);
  for (const directory of ['apps', 'packages']) {
    for (const name of await readdir(directory)) {
      const location = directory + '/' + name;
      const manifest = await json(location + '/package.json');
      assert.equal(manifest.version, root.version, location);
      assert.equal(manifest.license, 'MIT', location);
      assert.equal(lock.packages[location].version, manifest.version, location);
      assert.deepEqual(
        lock.packages[location].dependencies,
        manifest.dependencies,
      );
      for (const [dependency, range] of Object.entries(
        manifest.dependencies ?? {},
      ))
        if (dependency.startsWith('@clog/'))
          assert.equal(range, root.version, location + ': ' + dependency);
    }
  }
});

test('default branding and every canonical skill icon can render from local assets with recorded provenance', async () => {
  const publicRoot = 'apps/web/public/';
  const provenance = await json(publicRoot + 'skills/provenance.json');
  for (const [, , filename] of skills) {
    const record = provenance.assets.find((entry) => entry.file === filename);
    assert.ok(record, filename + ' needs provenance');
    const bytes = await readFile(publicRoot + 'skills/' + filename);
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      record.sha256,
    );
  }
  const files = [
    'apps/web/index.html',
    'apps/web/src/branding.ts',
    'apps/web/src/SiteApp.tsx',
    'apps/web/src/style.css',
    'apps/api/src/branding-store.ts',
  ];
  const referenced = new Set();
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(
      /\/(?:brand\/[\w.-]+|ui\/[\w.-]+|favicon\.(?:png|ico))/gu,
    ))
      referenced.add(match[0]);
    assert.doesNotMatch(text, /(?:src=|url\()["']?https?:\/\//u, file);
  }
  assert.ok(referenced.size >= 5);
  for (const asset of referenced) await access(publicRoot + asset.slice(1));
});
