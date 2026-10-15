import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  access,
} from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  packageRuntime,
  runtimeEntries,
  workspaces,
} from './package-runtime.mjs';
import { pruneRuntimeTests } from './prune-runtime-tests.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'clog-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (name, text) => {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
  };
  await put('package.json', '{}');
  for (const workspace of workspaces)
    await put(workspace + '/package.json', '{}');
  for (const entry of runtimeEntries)
    await put(entry, 'export const runtime = true;\n');
  return { root, put };
}
test('runtime package retains operator/server entries while omitting declarations, maps and source fixtures', async (t) => {
  const { root, put } = await fixture(t);
  await put('apps/api/dist/server.d.ts', 'declare const server: true;');
  await put('apps/api/dist/server.js.map', '{}');
  await put('apps/api/src/fixtures/private.json', '{"test":true}');
  const output = path.join(root, 'output'),
    manifest = await packageRuntime(root, output);
  assert.ok(manifest.files['apps/api/dist/server.js']);
  assert.ok(manifest.files['packages/database/dist/bootstrap.js']);
  assert.ok(
    !Object.keys(manifest.files).some((name) =>
      /\.map$|\.d\.ts$|fixtures|\/src\//u.test(name),
    ),
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(path.join(output, 'runtime-manifest.json'), 'utf8'),
    ),
    manifest,
  );
  await assert.rejects(packageRuntime(root, output), { code: 'EEXIST' });
});
test('miscompiled test code/fixture trees and missing runtime entries fail packaging', async (t) => {
  const { root, put } = await fixture(t);
  await put('apps/api/dist/claim.test.js', "import test from 'node:test';");
  await assert.rejects(
    packageRuntime(root, path.join(root, 'bad-test')),
    /Test artifact/u,
  );
  await rm(path.join(root, 'apps/api/dist/claim.test.js'));
  await put('apps/api/dist/fixtures/private.js', 'export {};');
  await assert.rejects(
    packageRuntime(root, path.join(root, 'bad-fixture')),
    /Test artifact/u,
  );
  await rm(path.join(root, 'apps/api/dist/fixtures'), { recursive: true });
  await rm(path.join(root, 'apps/api/dist/server.js'));
  await assert.rejects(
    packageRuntime(root, path.join(root, 'missing')),
    /Missing runtime entry/u,
  );
});
test('production dependency cleanup removes packaged tests and fixtures while preserving runtime data and scoped packages', async (t) => {
  const { root, put } = await fixture(t);
  for (const name of ['example', '@scope/example']) {
    await put(`node_modules/${name}/package.json`, '{"main":"index.js"}');
    await put(`node_modules/${name}/index.js`, 'export {};');
    await put(`node_modules/${name}/test/case.js`, 'test fixture');
    await put(`node_modules/${name}/lib/parser.test.js`, 'test fixture');
    await put(`node_modules/${name}/fixtures/proof.json`, 'fixture');
    await put(`node_modules/${name}/data/schema.json`, '{"runtime":true}');
  }
  await put('node_modules/.bin/retained', 'operator');
  const report = await pruneRuntimeTests(path.join(root, 'node_modules'));
  assert.equal(report.removed.length, 6);
  await access(path.join(root, 'node_modules/@scope/example/data/schema.json'));
  await access(path.join(root, 'node_modules/.bin/retained'));
  assert.equal(
    (await pruneRuntimeTests(path.join(root, 'node_modules'))).removed.length,
    0,
  );
  await assert.rejects(pruneRuntimeTests(root), /regular node_modules/u);
});
test('cleanup refuses a test-named declared runtime entry instead of breaking the dependency', async (t) => {
  const { root, put } = await fixture(t);
  await put('node_modules/example/package.json', '{"main":"test.js"}');
  await put('node_modules/example/test.js', 'export {};');
  await assert.rejects(
    pruneRuntimeTests(path.join(root, 'node_modules')),
    /declared runtime entry/u,
  );
  await access(path.join(root, 'node_modules/example/test.js'));
});
