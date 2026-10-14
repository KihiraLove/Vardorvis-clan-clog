/** One-shot privilege reconciliation by the database owner, never by the API. */
import pg from 'pg';

// This is intentionally not a checksummed schema migration: roles/passwords
// are cluster-level state, and the operator can rotate this credential without
// editing an already-applied migration or storing credentials in SQL history.
export const runtimeRole = 'clog_runtime';
type TablePrivilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
type SequencePrivilege = 'USAGE' | 'SELECT' | 'UPDATE';
const read = ['SELECT'] as const;
const append = ['SELECT', 'INSERT'] as const;
const edit = ['SELECT', 'INSERT', 'UPDATE'] as const;
const update = ['SELECT', 'UPDATE'] as const;
const replace = ['SELECT', 'INSERT', 'DELETE'] as const;
const mutable = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;

// New objects require a reviewed policy. There is no fallback grant category.
const tablePolicy: Readonly<Record<string, readonly TablePrivilege[]>> = {
  asset_retirements: read,
  admin_sessions: replace,
  audit_events: append,
  auth_rate_limits: mutable,
  catalog_assets: edit,
  catalog_audit: append,
  catalog_page_requests: append,
  catalog_requests: append,
  catalog_state: update,
  catalog_taxonomy_updates: [],
  catalog_versions: read,
  clan_api_key_audit: append,
  clan_api_keys: edit,
  clan_branding: update,
  clan_branding_audit: append,
  clan_logo_assets: append,
  collection_log_schedule_pages: replace,
  collection_log_schedules: mutable,
  collection_schedule_audit: append,
  collection_scheduling: update,
  competition_import_history: append,
  competition_previews: edit,
  game_item_ids: append,
  item_aliases: read,
  items: edit,
  manual_submission_requests: append,
  oauth_states: replace,
  page_items: replace,
  pages: edit,
  runelite_settings: update,
  runelite_settings_audit: append,
  review_state: update,
  runelite_submission_requests: append,
  schema_migrations: [],
  site_settings: update,
  site_settings_audit: append,
  staff_account_audit: append,
  staff_accounts: edit,
  submission_images: append,
  submissions: edit,
  wom_competitions: edit,
  xp_events: edit,
  xp_import_history: append,
  xp_previews: edit,
  xp_state: update,
};
const viewPolicy: Readonly<Record<string, readonly TablePrivilege[]>> = {
  collection_credits: read,
  item_collection_state: read,
};
const sequencePolicy: Readonly<Record<string, readonly SequencePrivilege[]>> = {
  audit_events_id_seq: ['USAGE', 'SELECT'],
  canonical_item_id_seq: ['USAGE', 'SELECT', 'UPDATE'],
  catalog_audit_id_seq: ['USAGE', 'SELECT'],
  clan_api_key_audit_id_seq: ['USAGE', 'SELECT'],
  clan_branding_audit_id_seq: ['USAGE', 'SELECT'],
  collection_schedule_audit_id_seq: ['USAGE', 'SELECT'],
  runelite_settings_audit_id_seq: ['USAGE', 'SELECT'],
  site_settings_audit_id_seq: ['USAGE', 'SELECT'],
  staff_account_audit_id_seq: ['USAGE', 'SELECT'],
};

export function validateRuntimePassword(value: string | undefined): string {
  if (!value || !/^[a-f\d]{64,}$/iu.test(value))
    throw new Error('APP_DB_PASSWORD must be 32+ random bytes encoded as hex');
  return value;
}

const identifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const privilegesFor = <T>(
  policy: Readonly<Record<string, readonly T[]>>,
  name: string,
): readonly T[] => (Object.hasOwn(policy, name) ? policy[name]! : []);

async function verifyEffectivePrivileges(client: pg.Client) {
  const relations = await client.query<{
    name: string;
    kind: string;
    privilege: string;
    allowed: boolean;
    delegable: boolean;
    columnAllowed: boolean;
  }>(
    `SELECT c.relname AS name, c.relkind AS kind, p.privilege,
      has_table_privilege($1,c.oid,p.privilege) AS allowed,
      has_table_privilege($1,c.oid,p.privilege || ' WITH GRANT OPTION') AS delegable,
      CASE WHEN p.privilege IN ('SELECT','INSERT','UPDATE','REFERENCES')
        THEN has_any_column_privilege($1,c.oid,p.privilege) ELSE false END AS "columnAllowed"
     FROM pg_class c CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p(privilege)
     WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m','f')`,
    [runtimeRole],
  );
  for (const row of relations.rows) {
    const privileges =
      row.kind === 'r'
        ? privilegesFor(tablePolicy, row.name)
        : row.kind === 'v'
          ? privilegesFor(viewPolicy, row.name)
          : undefined;
    const expected = (privileges ?? []).some(
      (privilege) => privilege === row.privilege,
    );
    if (
      row.allowed !== expected ||
      row.delegable ||
      (!expected && row.columnAllowed)
    )
      throw new Error(
        `Unexpected runtime privilege on public.${row.name}: ${row.privilege}`,
      );
  }
  const sequences = await client.query<{
    name: string;
    privilege: SequencePrivilege;
    allowed: boolean;
    delegable: boolean;
  }>(
    `SELECT c.relname AS name,p.privilege,
      has_sequence_privilege($1,c.oid,p.privilege) AS allowed,
      has_sequence_privilege($1,c.oid,p.privilege || ' WITH GRANT OPTION') AS delegable
     FROM pg_class c CROSS JOIN unnest(ARRAY['USAGE','SELECT','UPDATE']) p(privilege)
     WHERE c.relnamespace='public'::regnamespace AND c.relkind='S'`,
    [runtimeRole],
  );
  for (const row of sequences.rows)
    if (
      row.allowed !==
        privilegesFor(sequencePolicy, row.name).includes(row.privilege) ||
      row.delegable
    )
      throw new Error(
        `Unexpected runtime privilege on public.${row.name}: ${row.privilege}`,
      );
  const forbidden = await client.query(
    `SELECT 1 WHERE has_schema_privilege($1,'public','CREATE')
      OR has_database_privilege($1,current_database(),'CREATE')
      OR has_database_privilege($1,current_database(),'TEMPORARY')
      OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND has_function_privilege($1,oid,'EXECUTE'))
      OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=$1))`,
    [runtimeRole],
  );
  if (forbidden.rowCount)
    throw new Error(
      'Runtime role retains unexpected DDL, routine or membership privileges.',
    );
}

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
        NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD '${password}'`,
    );
    // NOINHERIT alone does not remove existing INHERIT/SET membership options.
    const memberships = await client.query<{ role: string }>(
      'SELECT r.rolname AS role FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles member ON member.oid=m.member WHERE member.rolname=$1',
      [runtimeRole],
    );
    for (const { role } of memberships.rows)
      await client.query(`REVOKE ${identifier(role)} FROM clog_runtime`);
    // Ownership cannot be constrained with REVOKE; require operator repair.
    const ownsObjects = await client.query(
      `SELECT 1 FROM pg_roles r WHERE r.rolname=$1 AND (
        EXISTS (SELECT 1 FROM pg_database WHERE datname=current_database() AND datdba=r.oid)
        OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='public' AND nspowner=r.oid)
        OR EXISTS (SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relowner=r.oid)
        OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proowner=r.oid))`,
      [runtimeRole],
    );
    if (ownsObjects.rowCount)
      throw new Error(
        'Runtime role must not own the application database or public schema objects.',
      );
    const database = (
      await client.query<{ name: string }>('SELECT current_database() AS name')
    ).rows[0]!.name;
    await client.query(
      `REVOKE ALL ON DATABASE ${identifier(database)} FROM clog_runtime`,
    );
    await client.query(
      `REVOKE CREATE, TEMPORARY ON DATABASE ${identifier(database)} FROM PUBLIC`,
    );
    await client.query(
      `GRANT CONNECT ON DATABASE ${identifier(database)} TO clog_runtime`,
    );
    // This application owns its database. PUBLIC access must not bypass policy.
    await client.query('REVOKE ALL ON SCHEMA public FROM PUBLIC, clog_runtime');
    await client.query('GRANT USAGE ON SCHEMA public TO clog_runtime');
    await client.query(
      'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC, clog_runtime',
    );
    await client.query(
      'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, clog_runtime',
    );
    await client.query(
      'REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public FROM PUBLIC, clog_runtime',
    );
    // Clear both global and per-schema defaults, including legacy grantors.
    const defaults = await client.query<{
      role: string;
      schema: string | null;
    }>(
      `WITH grantors AS (
        SELECT current_user AS role UNION
        SELECT r.rolname FROM pg_default_acl d JOIN pg_roles r ON r.oid=d.defaclrole
        LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace WHERE d.defaclnamespace=0 OR n.nspname='public'
       ) SELECT role,scope.schema FROM grantors CROSS JOIN (VALUES (NULL::text),('public')) scope(schema)`,
    );
    for (const row of defaults.rows)
      for (const objects of ['TABLES', 'SEQUENCES', 'ROUTINES'])
        await client.query(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${identifier(row.role)}${row.schema ? ` IN SCHEMA ${identifier(row.schema)}` : ''} REVOKE ALL ON ${objects} FROM PUBLIC, clog_runtime`,
        );
    for (const [policy, kind, object] of [
      [tablePolicy, 'r', 'TABLE'],
      [viewPolicy, 'v', 'TABLE'],
      [sequencePolicy, 'S', 'SEQUENCE'],
    ] as const) {
      for (const [name, privileges] of Object.entries(policy)) {
        const found = await client.query(
          "SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=$1 AND relkind=$2",
          [name, kind],
        );
        if (!found.rowCount)
          throw new Error(
            `Missing or incompatible runtime policy object: public.${name}`,
          );
        if (privileges.length)
          await client.query(
            `GRANT ${privileges.join(', ')} ON ${object} public.${identifier(name)} TO clog_runtime`,
          );
      }
    }
    await verifyEffectivePrivileges(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}
