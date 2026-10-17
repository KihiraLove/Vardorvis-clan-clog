/** Read-only acceptance, piped into the unmodified production image before smoke injection. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
assert.equal(process.cwd(), '/app', 'Run inside the built application image');
const manifest = JSON.parse(await readFile('runtime-manifest.json', 'utf8'));
const release = JSON.parse(
  await readFile('/opt/clog-release/manifest.json', 'utf8'),
);
assert.equal(manifest.compilation, 'tsconfig.runtime.json');
let bytes = 0;
for (const [file, expected] of Object.entries(manifest.files)) {
  assert.ok(
    file === 'package.json' ||
      file === 'LICENSE' ||
      /^(?:apps\/(?:api|bot)|packages\/(?:database|domain))\/(?:package\.json|dist\/.+\.js)$/u.test(
        file,
      ),
  );
  const value = await readFile(file);
  assert.equal(value.length, expected.bytes);
  assert.equal(
    createHash('sha256').update(value).digest('hex'),
    expected.sha256,
  );
  bytes += value.length;
}
const badDirectory = (name) =>
  /^(?:__)?(?:tests?|fixtures?)(?:__)?$|^(?:coverage|test-results|\.nyc_output)$/iu.test(
    name,
  );
const badFile = (name) =>
  /(?:^|\.)(?:test|spec)(?:\.d)?\.[cm]?[jt]sx?(?:\.map)?$/iu.test(name);
async function inspect(directory, modules = false, container = false) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (modules && container && entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      await inspect(file, true, entry.name.startsWith('@'));
      continue;
    }
    assert.ok(
      !badDirectory(entry.name) && !badFile(entry.name),
      'Test artifact shipped: ' + file,
    );
    if (entry.isDirectory())
      await inspect(file, modules, modules && entry.name === 'node_modules');
    else if (!modules) {
      if (/^packages\/database\/migrations\/\d{3}_[a-z_]+\.sql$/u.test(file)) {
        assert.equal(
          createHash('sha256')
            .update(await readFile(file))
            .digest('hex'),
          release.files[file],
        );
        continue;
      }
      assert.ok(manifest.files[file], 'Unmanifested first-party file: ' + file);
      assert.ok(!file.endsWith('.map') && !file.endsWith('.d.ts'));
      if (file.endsWith('.js'))
        assert.ok(!/['"]node:test['"]/u.test(await readFile(file, 'utf8')));
    }
  }
}
await inspect('apps');
await inspect('packages');
await inspect('node_modules', true, true);
assert.equal(
  await lstat('scripts').then(
    () => true,
    () => false,
  ),
  false,
  'Smoke tools must not ship in the image',
);
for (const file of [
  'packages/database/dist/bootstrap.js',
  'packages/database/dist/release-state.js',
  'apps/api/dist/server.js',
  'apps/bot/dist/index.js',
  'apps/bot/dist/register.js',
  'catalog/snapshot.json',
  'catalog/snapshot.sha256',
  'catalog/clue-taxonomy.json',
  '/usr/share/nginx/html/index.html',
])
  await lstat(file);
const migrations = (await readdir('packages/database/migrations'))
  .filter((name) => name.endsWith('.sql'))
  .sort();
assert.deepEqual(migrations, ['001_baseline.sql']);
const cleanup = JSON.parse(
  await readFile('runtime-dependency-cleanup.json', 'utf8'),
);
console.log(
  JSON.stringify(
    {
      status: 'passed',
      firstPartyFiles: Object.keys(manifest.files).length,
      firstPartyBytes: bytes,
      removedDependencyArtifacts: cleanup.removed.length,
      migrations: migrations.length,
      checks: [
        'runtime entry points and exact manifest bytes',
        'no first-party tests/fixtures/declarations/maps',
        'no upstream packaged test/fixture trees',
        'catalog/static assets and all migrations retained',
        'smoke tools absent before injection',
      ],
    },
    null,
    2,
  ),
);
