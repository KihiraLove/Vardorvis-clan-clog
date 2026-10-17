import { databaseUrl as readDatabaseUrl } from './secrets.js';
/** Apply forward-only SQL migrations; reject unknown or non-prefix database history. */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

export interface MigrationEntry {
  name: string;
  checksum: string;
}

/**
 * An installed schema is compatible only if its applied ledger is an exact
 * checksummed prefix of this image's immutable ordered migration manifest.
 * An older image cannot safely serve a newer database. Roll back the image
 * alone only when both images carry the same applied prefix; otherwise restore
 * the matching coordinated database + image-volume backup.
 */
export function validateMigrationHistory(
  bundled: readonly MigrationEntry[],
  applied: readonly (MigrationEntry & { applied_at?: Date })[],
): void {
  const expected = new Set<string>();
  for (const [index, entry] of bundled.entries()) {
    const number = Number(entry.name.slice(0, 3));
    if (
      !/^\d{3}_[a-z0-9_]+\.sql$/u.test(entry.name) ||
      number !== index + 1 ||
      expected.has(entry.name) ||
      !/^[a-f0-9]{64}$/u.test(entry.checksum)
    )
      throw new Error('Invalid ordered bundled migration manifest');
    expected.add(entry.name);
  }
  let previousTime = -Infinity;
  for (const [index, entry] of applied.entries()) {
    const match = bundled[index];
    if (!match || !expected.has(entry.name))
      throw new Error(`Unknown applied migration: ${entry.name}`);
    if (match.name !== entry.name)
      throw new Error(`Non-prefix migration history at: ${entry.name}`);
    if (match.checksum !== entry.checksum)
      throw new Error(`Applied migration changed: ${entry.name}`);
    if (entry.applied_at !== undefined) {
      const time = new Date(entry.applied_at).getTime();
      if (!Number.isFinite(time) || time < previousTime)
        throw new Error(`Reordered migration history at: ${entry.name}`);
      previousTime = time;
    }
  }
}

async function bundledMigrations(): Promise<
  Array<MigrationEntry & { sql: string }>
> {
  const directory = new URL('../migrations/', import.meta.url);
  const names = (await readdir(directory))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  const manifest = await Promise.all(
    names.map(async (name) => {
      const sql = await readFile(new URL(name, directory), 'utf8');
      return {
        name,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    }),
  );
  validateMigrationHistory(manifest, []);
  return manifest;
}

export async function migrate(
  databaseUrl: string,
  lockTimeoutMs = 10000,
): Promise<void> {
  if (
    !Number.isInteger(lockTimeoutMs) ||
    lockTimeoutMs < 1 ||
    lockTimeoutMs > 10000
  )
    throw new Error('Migration lock timeout must be 1–10000 ms');
  // Read all exact SQL bytes before opening the transaction; no partially
  // available image may mutate a database.
  const manifest = await bundledMigrations();
  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5000,
    query_timeout: 125000,
    statement_timeout: 120000,
  });
  let connected = false;
  let started = false;
  try {
    await client.connect();
    connected = true;
    // A single transaction keeps the entire pending batch atomic. Explicit
    // deadlines also apply to the advisory lock, not only DDL statements.
    await client.query('BEGIN');
    started = true;
    await client.query('SELECT set_config($1,$2,true)', [
      'lock_timeout',
      lockTimeoutMs + 'ms',
    ]);
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query(
      "SET LOCAL idle_in_transaction_session_timeout = '125s'",
    );
    await client.query('SELECT pg_advisory_xact_lock(74261005)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const applied = await client.query<MigrationEntry & { applied_at: Date }>(
      'SELECT name, checksum, applied_at FROM schema_migrations ORDER BY name',
    );
    // Validate the entire applied ledger under the lock *before* running SQL.
    validateMigrationHistory(manifest, applied.rows);
    for (const entry of manifest.slice(applied.rows.length)) {
      await client.query(entry.sql);
      await client.query(
        'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
        [entry.name, entry.checksum],
      );
    }
    await client.query('COMMIT');
    started = false;
  } catch (error) {
    if (started) {
      // Preserve the original fault, including timeout and incompatible history,
      // if the connection was already broken when ROLLBACK was attempted.
      try {
        await client.query('ROLLBACK');
      } catch {
        // Connection is unusable; PostgreSQL rolls back abandoned transactions.
      }
    }
    throw error;
  } finally {
    if (connected) await client.end();
  }
}

// Importing migrate() in tests must not also execute the command-line entry point.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const url = readDatabaseUrl();
  if (!url) throw new Error('DATABASE_URL is required');
  await migrate(url);
  console.log('Database migrations applied');
}
