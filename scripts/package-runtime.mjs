/** Copy separately compiled first-party runtime JS; retain test output only in checks. */
import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export const workspaces = [
  'apps/api',
  'apps/bot',
  'packages/database',
  'packages/domain',
];
export const runtimeEntries = [
  'apps/api/dist/server.js',
  'apps/bot/dist/index.js',
  'apps/bot/dist/register.js',
  'packages/domain/dist/index.js',
  'packages/database/dist/bootstrap.js',
  'packages/database/dist/migrate.js',
  'packages/database/dist/release-state.js',
  'packages/database/dist/preview-maintenance.js',
  'packages/database/dist/asset-maintenance.js',
  'packages/database/dist/lifecycle.js',
  'packages/database/dist/catalog-import.js',
  'packages/database/dist/clue-taxonomy.js',
];
export const testDirectory = (name) =>
  /^(?:__)?(?:tests?|fixtures?)(?:__)?$|^(?:coverage|test-results|\.nyc_output)$/iu.test(
    name,
  );
export const testFile = (name) =>
  /(?:^|\.)(?:test|spec)(?:\.d)?\.[cm]?[jt]sx?(?:\.map)?$/iu.test(name);

export async function packageRuntime(root, output) {
  await mkdir(output); // Refuse to mix this package with a previous/stale output.
  const files = {};
  async function copy(relative) {
    const bytes = await readFile(path.join(root, relative));
    await mkdir(path.dirname(path.join(output, relative)), { recursive: true });
    await copyFile(path.join(root, relative), path.join(output, relative));
    files[relative.replaceAll('\\', '/')] = {
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }
  async function walk(relative) {
    const entries = await readdir(path.join(root, relative), {
      withFileTypes: true,
    });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink())
        throw Error('Runtime output cannot contain symlinks');
      if (testDirectory(entry.name) || testFile(entry.name))
        throw Error('Test artifact in runtime compilation: ' + entry.name);
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.name.endsWith('.js')) {
        if (
          /\b(?:from\s*|import\s*\()?['"]node:test['"]/u.test(
            await readFile(path.join(root, file), 'utf8'),
          )
        )
          throw Error('Test runner import in runtime output: ' + file);
        await copy(file);
      }
    }
  }
  await copy('package.json');
  for (const workspace of workspaces) {
    const directory = path.join(root, workspace, 'dist');
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw Error('Expected regular runtime output');
    await copy(path.join(workspace, 'package.json'));
    await walk(path.join(workspace, 'dist'));
  }
  for (const entry of runtimeEntries)
    if (!files[entry]) throw Error('Missing runtime entry: ' + entry);
  const manifest = { format: 1, compilation: 'tsconfig.runtime.json', files };
  await writeFile(
    path.join(output, 'runtime-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  return manifest;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  if (process.argv.length !== 3)
    throw Error(
      'Usage: node scripts/package-runtime.mjs <new-output-directory>',
    );
  const manifest = await packageRuntime(
    process.cwd(),
    path.resolve(process.argv[2]),
  );
  console.log(
    `Packaged ${Object.keys(manifest.files).length} first-party runtime files`,
  );
}
