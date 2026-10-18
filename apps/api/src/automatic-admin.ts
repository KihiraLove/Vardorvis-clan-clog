/** A pending first-login credential survives interrupted bootstrap, never resets an account. */
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  mkdirSync,
  chownSync,
  unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type pg from 'pg';
import { writeManagedFile } from '@clog/database/dist/managed-secrets.js';
import { readSecret } from '@clog/database/dist/secrets.js';
import { PasswordHasher, verifyPassword } from './passwords.js';
import { ensureDefaultAdministrator } from './store.js';

export function prepareAdministrator(
  file: string,
  fresh: boolean,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!existsSync(file)) {
    if (!fresh) return undefined;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    if (process.getuid?.() === 0) chownSync(dirname(file), 1000, 1000);
    const password =
      readSecret('ADMIN_BOOTSTRAP_PASSWORD', env) ??
      randomBytes(32).toString('hex');
    if (!/^[a-f0-9]{64,256}$/iu.test(password))
      throw new Error('Invalid initial administrator credential');
    writeManagedFile(file, JSON.stringify({ password }) + '\n');
  }
  const value = JSON.parse(readFileSync(file, 'utf8')) as { password: string };
  if (!/^[a-f0-9]{64,256}$/iu.test(value.password))
    throw new Error('Invalid pending administrator credential');
  return value.password;
}
export function printAdministrator(
  password: string,
  log: (line: string) => void = (line) => {
    process.stdout.write(line + '\n');
  },
) {
  log(
    '\n=== CLAN COLLECTION LOG — FIRST LOGIN ===\nUsername: admin\nTemporary password: ' +
      password +
      '\nChange this password on your first login.\n=========================================\n',
  );
}
export async function provisionAdministrator(pool: pg.Pool, file: string) {
  const client = await pool.connect(),
    hasher = new PasswordHasher();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('clog:first-administrator'))",
    );
    const old = (
      await client.query<{
        password_hash: string;
        must_change_password: boolean;
      }>(
        "SELECT password_hash,must_change_password FROM staff_accounts WHERE role='admin'",
      )
    ).rows[0];
    const pending =
      old && !old.must_change_password
        ? undefined
        : prepareAdministrator(file, false, {});
    if (old) {
      if (!old.must_change_password) {
        if (existsSync(file)) unlinkSync(file);
      } else if (pending && !(await verifyPassword(pending, old.password_hash)))
        throw new Error(
          'Pending credential does not match the existing administrator',
        );
    } else {
      if (!pending)
        throw new Error('Initial administrator credential is missing');
      await ensureDefaultAdministrator(client, await hasher.hash(pending));
    }
    await client.query('COMMIT');
    return old && !old.must_change_password ? undefined : pending;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await hasher.close();
  }
}
