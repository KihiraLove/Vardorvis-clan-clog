/** Remove upstream packaged tests/fixtures only from the production dependency stage. */
import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { testDirectory, testFile } from './package-runtime.mjs';
export async function pruneRuntimeTests(directory) {
  const root = path.resolve(directory),
    removed = [];
  const info = await lstat(root);
  if (
    path.basename(root) !== 'node_modules' ||
    !info.isDirectory() ||
    info.isSymbolicLink()
  )
    throw Error('Expected a regular node_modules directory');
  async function scan(
    directory,
    container,
    packageRoot,
    protectedEntries = [],
  ) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.resolve(directory, entry.name);
      if (!target.startsWith(root + path.sep))
        throw Error('Dependency path escaped its root');
      if (container && entry.name.startsWith('.')) continue;
      // Never follow workspace links or upstream symlinks into another tree.
      if (
        entry.isSymbolicLink() &&
        (container || !(testDirectory(entry.name) || testFile(entry.name)))
      )
        continue;
      if (container && entry.isDirectory()) {
        if (entry.name.startsWith('@')) {
          await scan(target, true, target);
          continue;
        }
        const metadata = JSON.parse(
          await readFile(path.join(target, 'package.json'), 'utf8'),
        );
        const paths = [];
        const collect = (value) => {
          if (typeof value === 'string' && !value.includes('*'))
            paths.push(path.resolve(target, value));
          else if (value && typeof value === 'object')
            Object.values(value).forEach(collect);
        };
        for (const field of ['main', 'bin', 'exports', 'imports'])
          collect(metadata[field]);
        await scan(target, false, target, paths);
        continue;
      }
      if (!container && (testDirectory(entry.name) || testFile(entry.name))) {
        if (
          protectedEntries.some(
            (file) => file === target || file.startsWith(target + path.sep),
          )
        )
          throw Error(
            'Test-named path is a declared runtime entry: ' +
              path.relative(packageRoot, target),
          );
        await rm(target, { recursive: entry.isDirectory(), force: false });
        removed.push(path.relative(root, target).replaceAll('\\', '/'));
      } else if (entry.isDirectory()) {
        await scan(
          target,
          entry.name === 'node_modules',
          packageRoot,
          protectedEntries,
        );
      }
    }
  }
  await scan(root, true, root);
  return { format: 1, removed: removed.sort() };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  if (process.argv.length !== 3)
    throw Error('Usage: node scripts/prune-runtime-tests.mjs <node_modules>');
  const report = await pruneRuntimeTests(process.argv[2]);
  console.log(JSON.stringify(report));
}
