import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { syncVersion } from './sync-version.mjs';

test('a root-only version bump derives workspace metadata without changing registry dependencies', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clog-version-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const put = async (file, value) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), JSON.stringify(value));
  };
  await mkdir(path.join(root, 'packages'));
  await put('package.json', { version: '2.1.0' });
  const old = {
    name: '@clog/api',
    version: '1.0.0',
    dependencies: { '@clog/api': '1.0.0', thirdParty: '^4.2.0' },
  };
  const registry = {
    version: '4.2.1',
    resolved: 'https://registry.example/third-party',
    integrity: 'keep-this',
  };
  await put('apps/api/package.json', old);
  await put('package-lock.json', {
    version: '1.0.0',
    packages: {
      '': { version: '1.0.0' },
      'apps/api': old,
      'node_modules/thirdParty': registry,
    },
  });
  await assert.rejects(syncVersion(root, true), /stale/);
  await syncVersion(root);
  assert.deepEqual(await syncVersion(root), []);
  await syncVersion(root, true);
  const manifest = JSON.parse(
    await readFile(path.join(root, 'apps/api/package.json'), 'utf8'),
  );
  assert.equal(manifest.version, '2.1.0');
  assert.deepEqual(manifest.dependencies, {
    '@clog/api': '*',
    thirdParty: '^4.2.0',
  });
  const lock = JSON.parse(
    await readFile(path.join(root, 'package-lock.json'), 'utf8'),
  );
  assert.equal(lock.version, '2.1.0');
  assert.deepEqual(lock.packages['apps/api'], manifest);
  assert.deepEqual(lock.packages['node_modules/thirdParty'], registry);
});
