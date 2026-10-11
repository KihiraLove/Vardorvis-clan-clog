/** One-shot privilege reconciliation by the database owner, never by the API. */
import pg from 'pg';

// This is intentionally not a checksummed schema migration: roles/passwords
// are cluster-level state, and the operator can rotate this credential without
// editing an already-applied migration or storing credentials in SQL history.
export const runtimeRole = 'clog_runtime';
const ownerOnly = new Set(['schema_migrations', 'catalog_taxonomy_updates']);
const readOnly = new Set(['catalog_versions']);
const appendOnly = new Set([
  'staff_account_audit',
  'audit_events',
  'site_settings_audit',
  'catalog_audit',
  'xp_import_history',
  'manual_submission_requests',
]);

export function validateRuntimePassword(value: string | undefined): string {
  if (!value || !/^[a-f\d]{64,}$/iu.test(value))
    throw new Error('APP_DB_PASSWORD must be 32+ random bytes encoded as hex');
  return value;
}

const identifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';

export async function provisionRuntimeRole(
  databaseUrl: string,
  password: string,
): Promise<void> {
  validateRuntimePassword(password);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    // Serializes repeated bootstraps from different deployments.
    await client.query('SELECT pg_advisory_xact_lock(74261011)');
    const exists = await client.query(
      'SELECT 1 FROM pg_roles WHERE rolname = $1',
      [runtimeRole],
    );
    if (!exists.rowCount) await client.query('CREATE ROLE clog_runtime LOGIN');
    // Password is a validated hex-only string, not interpolated user SQL.
    await client.query(
      `ALTER ROLE clog_runtime WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOREPLICATION NOINHERIT PASSWORD '${password}'`,
    );
    // Never grant CREATE, schema ownership, schema_migrations or role admin.
    await client.query('REVOKE ALL ON SCHEMA public FROM clog_runtime');
    await client.query('GRANT USAGE ON SCHEMA public TO clog_runtime');
    await client.query(
      'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM clog_runtime',
    );
    await client.query(
      'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM clog_runtime',
    );
    // Views are read-only; grant runtime DML only on the application's tables.
    const tables = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    );
    for (const { tablename } of tables.rows) {
      if (ownerOnly.has(tablename)) continue;
      const operations = readOnly.has(tablename)
        ? 'SELECT'
        : appendOnly.has(tablename)
          ? 'SELECT, INSERT'
          : 'SELECT, INSERT, UPDATE, DELETE';
      await client.query(
        `GRANT ${operations} ON TABLE public.${identifier(tablename)} TO clog_runtime`,
      );
    }
    const views = await client.query<{ viewname: string }>(
      "SELECT viewname FROM pg_views WHERE schemaname='public' ORDER BY viewname",
    );
    for (const { viewname } of views.rows)
      await client.query(
        `GRANT SELECT ON TABLE public.${identifier(viewname)} TO clog_runtime`,
      );
    await client.query(
      'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO clog_runtime',
    );
    // Catalog creation advances this sequence with setval(), which needs UPDATE.
    // Other sequences (including audit IDs) never receive UPDATE privilege.
    await client.query(
      'GRANT UPDATE ON SEQUENCE public.canonical_item_id_seq TO clog_runtime',
    );
    // No default-privilege blanket grants: newly added tables remain
    // inaccessible until a reviewed bootstrap applies updated permissions.
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}
