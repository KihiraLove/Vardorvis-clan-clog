/** Root package.json owns the release version; npm workspace metadata is derived. */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function syncVersion(root, check = false) {
  const read = async (file) => {
    const source = await readFile(path.join(root, file), 'utf8');
    return { file, source, value: JSON.parse(source) };
  };
  const manifest = await read('package.json');
  const version = manifest.value.version;
  if (!/^\d+\.\d+\.\d+(?:-[a-z0-9][a-z0-9.-]*)?$/u.test(version))
    throw new Error('Root package.json must contain a valid release version.');
  const lock = await read('package-lock.json');
  const files = [lock];
  const workspaces = [];
  for (const directory of ['apps', 'packages']) {
    for (const name of await readdir(path.join(root, directory))) {
      const location = `${directory}/${name}`;
      const workspace = await read(`${location}/package.json`);
      workspaces.push([location, workspace]);
      files.push(workspace);
    }
  }
  const names = new Set(workspaces.map(([, w]) => w.value.name));
  const derive = (value) => {
    value.version = version;
    for (const section of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ])
      for (const name of Object.keys(value[section] ?? {}))
        if (names.has(name)) value[section][name] = '*';
  };
  lock.value.version = version;
  derive(lock.value.packages['']);
  for (const [location, workspace] of workspaces) {
    if (!lock.value.packages[location])
      throw new Error(`Workspace missing from lockfile: ${location}`);
    derive(workspace.value);
    derive(lock.value.packages[location]);
  }
  const changed = files.filter(
    ({ source, value }) =>
      JSON.stringify(JSON.parse(source)) !== JSON.stringify(value),
  );
  if (check && changed.length)
    throw new Error(
      `Version metadata is stale. Run npm run version:sync: ${changed.map((f) => f.file).join(', ')}`,
    );
  for (const { file, source, value } of check ? [] : changed) {
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    await writeFile(
      path.join(root, file),
      (JSON.stringify(value, null, 2) + '\n').replaceAll('\n', newline),
    );
  }
  return changed.map((f) => f.file);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  if (process.argv.slice(2).some((arg) => arg !== '--check'))
    throw new Error('Use --check or no arguments.');
  const changed = await syncVersion(
    fileURLToPath(new URL('../', import.meta.url)),
    process.argv.includes('--check'),
  );
  console.log(
    changed.length
      ? `Synchronized ${changed.length} version metadata files.`
      : 'Version metadata is current.',
  );
}
