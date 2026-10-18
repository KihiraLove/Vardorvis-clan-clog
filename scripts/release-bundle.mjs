/** Package infrastructure and the migration contract with the application image. */
import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export const infrastructureFiles = [
  'compose.yaml',
  'compose.traefik.yaml',
  'compose.release.yaml',
  'compose.isolated.yaml',
  'infra/deploy.sh',
  'infra/deploy-release.sh',
  'infra/release-compose.sh',
  'infra/backup.sh',
  'infra/backup-current.sh',
  'infra/restore.sh',
  'infra/rotate-secrets.sh',
  'infra/start-app.sh',
  'infra/start-installation.sh',
  'infra/clog',
  'infra/nginx/nginx.conf',
  'infra/nginx/default.conf',
  'docs/release-recovery.md',
];
export async function buildBundle(root, output, revision, evidence) {
  if (!/^(?:[a-f0-9]{40}|working-tree)$/.test(revision))
    throw new Error('Invalid release revision');
  if (
    !/^(?:local-acceptance|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+)$/.test(
      evidence,
    )
  )
    throw new Error('Invalid release evidence');
  const migrations = (
    await readdir(path.join(root, 'packages/database/migrations'))
  )
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const files = [
      ...infrastructureFiles,
      ...migrations.map((name) => 'packages/database/migrations/' + name),
    ],
    hashes = {};
  for (const file of files) {
    const bytes = await readFile(path.join(root, file));
    hashes[file] = createHash('sha256').update(bytes).digest('hex');
    await mkdir(path.dirname(path.join(output, file)), { recursive: true });
    await copyFile(path.join(root, file), path.join(output, file));
  }
  const manifest = {
    format: 1,
    revision,
    evidence,
    compatibility: 'checksummed-prefix-forward;exact-manifest-image-rollback',
    files: hashes,
    migrations: migrations.map((name) => ({
      name,
      checksum: hashes['packages/database/migrations/' + name],
    })),
  };
  const json = JSON.stringify(manifest, null, 2) + '\n';
  await writeFile(path.join(output, 'manifest.json'), json);
  hashes['manifest.json'] = createHash('sha256').update(json).digest('hex');
  await writeFile(
    path.join(output, 'SHA256SUMS'),
    Object.entries(hashes)
      .map(([file, hash]) => `${hash}  ${file}`)
      .join('\n') + '\n',
  );
  return manifest;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await buildBundle(
    process.cwd(),
    process.argv[2],
    process.env.RELEASE_REVISION ?? 'working-tree',
    process.env.RELEASE_EVIDENCE ?? 'local-acceptance',
  );
