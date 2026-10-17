/** Read-only image/schema preflight and non-secret release evidence. */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { validateMigrationHistory, type MigrationEntry } from './migrate.js';
export async function releaseState(
  databaseUrl: string,
  manifestPath: string,
  exact = false,
) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    migrations: MigrationEntry[];
  };
  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
  });
  await client.connect();
  try {
    const exists = (
      await client.query(
        "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present",
      )
    ).rows[0].present;
    const applied = exists
      ? (
          await client.query<MigrationEntry & { applied_at: Date }>(
            'SELECT name,checksum,applied_at FROM schema_migrations ORDER BY name',
          )
        ).rows
      : [];
    validateMigrationHistory(manifest.migrations, applied);
    if (exact && applied.length !== manifest.migrations.length)
      throw new Error('Exact schema manifest required');
    return {
      databaseVersion: (
        await client.query(
          "SELECT current_setting('server_version') AS version",
        )
      ).rows[0].version as string,
      migrations: applied,
    };
  } finally {
    await client.end();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (!process.env.DATABASE_URL)
      throw new Error('Database configuration required');
    console.log(
      JSON.stringify(
        await releaseState(
          process.env.DATABASE_URL,
          process.argv.slice(2).find((argument) => argument !== '--exact') ??
            '/opt/clog-release/manifest.json',
          process.argv.includes('--exact'),
        ),
      ),
    );
  } catch {
    console.error(
      'Release schema validation failed; inspect the migration ledger against the pinned manifest.',
    );
    process.exitCode = 1;
  }
}
