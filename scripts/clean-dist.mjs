/** Remove stale emitted files only from a known workspace's generated directory. */
import { lstat, realpath, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const allowed = await Promise.all(
  ['apps/api', 'apps/bot', 'packages/database', 'packages/domain'].map((path) =>
    realpath(resolve(root, path)),
  ),
);
const workspace = await realpath(process.cwd());
if (!allowed.includes(workspace))
  throw new Error('Build cleanup requires a known compiled workspace.');
const output = resolve(workspace, 'dist');
const existing = await lstat(output).catch((error) => {
  if (error.code === 'ENOENT') return undefined;
  throw error;
});
if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
  throw new Error('Build output must be a regular directory.');
await rm(output, { recursive: true, force: true });
