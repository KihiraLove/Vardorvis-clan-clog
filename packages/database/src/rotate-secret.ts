/** Resumable explicit rotation; pending credentials stay only in the protected owner volume. */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { databaseUrl, readSecret } from './secrets.js';
import {
  managedSecrets,
  writeManagedFile,
  type SecretKind,
} from './managed-secrets.js';

export async function rotateSecret(
  root: string,
  kind: SecretKind,
  resume: boolean,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!Object.hasOwn(managedSecrets, kind))
    throw new Error('Choose postgres, app or session');
  const pendingFile = join(root, 'postgres', 'rotation.json');
  let pending: { kind: SecretKind; previous: string; next: string };
  if (existsSync(pendingFile)) {
    if (!resume)
      throw new Error('Rotation is pending; repeat the command with --resume');
    try {
      pending = JSON.parse(readFileSync(pendingFile, 'utf8')) as typeof pending;
      if (
        pending.kind !== kind ||
        !/^[a-f0-9]{64,256}$/iu.test(pending.next) ||
        !/^[a-f0-9]{64,256}$/iu.test(pending.previous)
      )
        throw new Error();
    } catch {
      throw new Error(
        'Invalid pending rotation; restore the protected secret backup',
      );
    }
  } else {
    if (resume) throw new Error('No rotation is pending');
    pending = {
      kind,
      previous: readSecret(managedSecrets[kind], {
        [managedSecrets[kind] + '_FILE']: join(root, kind, 'value'),
      })!,
      next: randomBytes(32).toString('hex'),
    };
    writeManagedFile(pendingFile, JSON.stringify(pending) + '\n');
  }
  if (kind !== 'session') {
    const owner = readSecret('POSTGRES_PASSWORD', {
      POSTGRES_PASSWORD_FILE: join(root, 'postgres', 'value'),
    })!;
    let connection: pg.Client | undefined;
    for (const candidate of new Set(
      kind === 'postgres' ? [owner, pending.next, pending.previous] : [owner],
    )) {
      const client = new pg.Client({
        connectionString: databaseUrl({
          DB_HOST: env.DB_HOST || 'db',
          DB_PORT: env.DB_PORT,
          POSTGRES_PASSWORD: candidate,
        }),
        connectionTimeoutMillis: 5000,
      });
      try {
        await client.connect();
        connection = client;
        break;
      } catch {
        await client.end().catch(() => undefined);
      }
    }
    if (!connection)
      throw new Error(
        'Cannot authenticate database owner; retain pending rotation and restore access',
      );
    try {
      const role = kind === 'postgres' ? 'clog' : 'clog_runtime';
      await connection.query(
        `ALTER ROLE "${role}" PASSWORD ${connection.escapeLiteral(pending.next)}`,
      );
      const check = new pg.Client({
        connectionString: databaseUrl({
          DB_HOST: env.DB_HOST || 'db',
          DB_PORT: env.DB_PORT,
          DB_USER: role,
          POSTGRES_PASSWORD: pending.next,
        }),
        connectionTimeoutMillis: 5000,
      });
      try {
        await check.connect();
      } finally {
        await check.end();
      }
    } finally {
      await connection.end();
    }
  }
  writeManagedFile(join(root, kind, 'value'), pending.next + '\n');
  const manifestFile = join(root, 'postgres', 'installation.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<
    string,
    unknown
  >;
  writeManagedFile(
    manifestFile,
    JSON.stringify({ ...manifest, generation: randomUUID() }) + '\n',
  );
  unlinkSync(pendingFile);
}
