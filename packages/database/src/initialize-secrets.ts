/** Explicit installation initialization; managed secret files are persistent, not image data. */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  chmodSync,
  chownSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readSecret } from './secrets.js';
import {
  managedSecrets,
  writeManagedFile,
  type SecretKind,
} from './managed-secrets.js';

export function initializeSecrets(
  root: string,
  database: string,
  env: NodeJS.ProcessEnv = process.env,
  adopt = false,
  allowPendingRotation = false,
) {
  const manifest = join(root, 'postgres', 'installation.json');
  const existing = existsSync(manifest);
  if (
    !allowPendingRotation &&
    existsSync(join(root, 'postgres', 'rotation.json'))
  )
    throw new Error(
      'A secret rotation is incomplete; resume the rotation before startup',
    );
  const populated = existsSync(join(database, 'PG_VERSION'));
  if (!existing && populated && !adopt)
    throw new Error(
      'Existing database needs explicit init --adopt-environment with all three existing secrets',
    );
  const values: Partial<Record<SecretKind, string>> = {};
  for (const [kind, name] of Object.entries(managedSecrets) as [
    SecretKind,
    string,
  ][]) {
    const directory = join(root, kind);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink())
      throw new Error('Secret directories must be regular directories');
    if (process.platform !== 'win32') {
      chmodSync(directory, 0o700);
      if (process.getuid?.() === 0) chownSync(directory, 1000, 1000);
    }
    const file = join(directory, 'value');
    const supplied = readSecret(name, env);
    if (existsSync(file)) {
      values[kind] = readSecret(name, { [name + '_FILE']: file })!;
      if (supplied && supplied !== values[kind])
        throw new Error(
          `${name} differs from the installed secret; use explicit rotation`,
        );
    } else {
      if (existing || (populated && !adopt))
        throw new Error(
          `Installed ${name} is missing; restore it before startup`,
        );
      if (adopt && !supplied)
        throw new Error(`Adoption requires the existing ${name}`);
      values[kind] = supplied ?? randomBytes(32).toString('hex');
    }
    if (!/^[a-f\d]{64,256}$/iu.test(values[kind]!))
      throw new Error(`${name} must contain 32–128 random bytes as hex`);
  }
  if (
    values.postgres === values.app ||
    values.session === values.postgres ||
    values.session === values.app
  )
    throw new Error('All three installation secrets must differ');
  for (const kind of Object.keys(managedSecrets) as SecretKind[]) {
    const file = join(root, kind, 'value');
    if (!existsSync(file)) writeManagedFile(file, values[kind]! + '\n');
  }
  if (!existing)
    writeManagedFile(
      manifest,
      JSON.stringify({ format: 1, id: randomUUID() }) + '\n',
    );
  else {
    const state = JSON.parse(readFileSync(manifest, 'utf8')) as {
      format?: number;
      id?: string;
    };
    if (state.format !== 1 || !state.id)
      throw new Error('Invalid installation secret manifest');
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const args = process.argv.slice(2);
    const root = process.env.CLOG_SECRETS_ROOT || '/run/clog-secrets';
    if (args.length === 1 && args[0] === '--identity') {
      const state = JSON.parse(
        readFileSync(join(root, 'postgres', 'installation.json'), 'utf8'),
      ) as { id: string; generation?: string };
      if (
        !/^[a-f0-9-]{36}$/u.test(state.id) ||
        (state.generation && !/^[a-f0-9-]{36}$/u.test(state.generation))
      )
        throw new Error('Invalid installation secret manifest');
      console.log(
        JSON.stringify({
          id: state.id,
          generation: state.generation ?? state.id,
        }),
      );
      process.exit(0);
    }
    const rotation = args.find((arg) => arg.startsWith('--rotate='));
    if (rotation) {
      if (args.some((arg) => arg !== rotation && arg !== '--resume'))
        throw new Error('Usage: init --rotate=postgres|app|session [--resume]');
      const { rotateSecret } = await import('./rotate-secret.js');
      await rotateSecret(
        root,
        rotation.slice(9) as SecretKind,
        args.includes('--resume'),
      );
      console.log(
        'Secret rotated; recreate affected services before resuming writes.',
      );
    } else {
      if (args.some((arg) => arg !== '--adopt-environment'))
        throw new Error('Usage: init [--adopt-environment]');
      initializeSecrets(
        root,
        process.env.CLOG_DATABASE_DATA || '/database-data',
        process.env,
        args.includes('--adopt-environment'),
      );
      console.log(
        'Installation secrets ready; existing credentials preserved.',
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    console.error(
      /^(Existing database needs|Installed (POSTGRES_PASSWORD|APP_DB_PASSWORD|SESSION_SECRET) is missing|A secret rotation is incomplete|Rotation is pending|No rotation is pending|Choose postgres|Invalid pending rotation|Cannot authenticate database owner|All three installation secrets must differ|Usage: init|(?:POSTGRES_PASSWORD|APP_DB_PASSWORD|SESSION_SECRET) (?:differs|must contain)|Adoption requires)/u.test(
        message,
      )
        ? message
        : 'Secret operation failed; check protected storage and configuration. Resume an interrupted rotation before starting services.',
    );
    process.exitCode = 1;
  }
}
