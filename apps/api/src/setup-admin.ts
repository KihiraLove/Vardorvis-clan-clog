/** Local one-shot provisioning; credentials are displayed only by an explicit operator command. */
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { databaseUrl, readSecret } from '@clog/database/dist/secrets.js';
import { ensureDefaultAdministrator } from './store.js';
import { PasswordHasher } from './passwords.js';

export async function setupAdministrator(pool: pg.Pool, password: string) {
  const client = await pool.connect();
  const hasher = new PasswordHasher();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('clog:first-administrator'))",
    );
    if (
      (await client.query("SELECT 1 FROM staff_accounts WHERE role='admin'"))
        .rowCount
    )
      throw new Error(
        'An administrator already exists; this command never resets accounts',
      );
    await ensureDefaultAdministrator(client, await hasher.hash(password));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await hasher.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  let pool: pg.Pool | undefined;
  try {
    if (args.length !== 1 || !['--generate', '--from-env'].includes(args[0]!))
      throw new Error(
        'Usage: setup-admin --generate (or --from-env for automated provisioning)',
      );
    const password =
      args[0] === '--generate'
        ? randomBytes(32).toString('hex')
        : readSecret('ADMIN_BOOTSTRAP_PASSWORD');
    if (!password || !/^[a-f\d]{64,256}$/iu.test(password))
      throw new Error('Provide a 32–128 byte hex bootstrap credential');
    pool = new pg.Pool({
      connectionString: databaseUrl(process.env, 'runtime'),
      connectionTimeoutMillis: 5000,
    });
    await setupAdministrator(pool, password);
    console.log(
      'Administrator created. First login requires a different password.',
    );
    if (args[0] === '--generate')
      console.log('Username: admin\nTemporary password: ' + password);
  } catch (error) {
    console.error(
      error instanceof Error &&
        error.message.startsWith('An administrator already exists')
        ? error.message
        : 'Administrator setup failed; check the command, secret inputs and initialized database.',
    );
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
