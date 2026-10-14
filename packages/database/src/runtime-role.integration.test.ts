/** Effective privileges and real writes on a disposable database, with real role logins. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { migrate } from './migrate.js';
import { provisionRuntimeRole } from './runtime-role.js';

// Independent contract: never calculate the expected privileges from the implementation.
const operations = new Map<string, string[]>();
for (const [privileges, names] of [
  ['', 'schema_migrations catalog_taxonomy_updates'],
  [
    'SELECT',
    'asset_retirements lifecycle_archive_audit catalog_versions item_aliases collection_credits item_collection_state',
  ],
  [
    'SELECT INSERT',
    'audit_events catalog_audit catalog_page_requests catalog_requests clan_api_key_audit clan_branding_audit clan_logo_assets collection_schedule_audit competition_import_history game_item_ids manual_submission_requests runelite_settings_audit runelite_submission_requests site_settings_audit staff_account_audit submission_images xp_import_history',
  ],
  [
    'SELECT UPDATE',
    'catalog_state clan_branding collection_scheduling lifecycle_state projection_state review_state runelite_settings site_settings xp_state',
  ],
  [
    'SELECT INSERT UPDATE',
    'catalog_assets clan_api_keys competition_previews items pages staff_accounts submissions wom_competitions xp_events xp_previews',
  ],
  [
    'SELECT INSERT DELETE',
    'admin_sessions collection_log_schedule_pages oauth_states page_items',
  ],
  ['SELECT INSERT UPDATE DELETE', 'auth_rate_limits collection_log_schedules'],
])
  for (const name of names!.split(' '))
    operations.set(name, privileges ? privileges.split(' ') : []);
const sequences = [
  'audit_events_id_seq',
  'catalog_audit_id_seq',
  'clan_api_key_audit_id_seq',
  'clan_branding_audit_id_seq',
  'collection_schedule_audit_id_seq',
  'runelite_settings_audit_id_seq',
  'site_settings_audit_id_seq',
  'staff_account_audit_id_seq',
];
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';

async function matrix(client: pg.Client) {
  assert.equal(
    (await client.query('SELECT current_user AS role')).rows[0].role,
    'clog_runtime',
  );
  const relations = (
    await client.query<{
      name: string;
      kind: string;
      privilege: string;
      allowed: boolean;
      delegable: boolean;
      columns: boolean;
    }>(`SELECT c.relname AS name,c.relkind AS kind,p.privilege,
    has_table_privilege(current_user,c.oid,p.privilege) AS allowed,
    has_table_privilege(current_user,c.oid,p.privilege || ' WITH GRANT OPTION') AS delegable,
    CASE WHEN p.privilege IN ('SELECT','INSERT','UPDATE','REFERENCES') THEN has_any_column_privilege(current_user,c.oid,p.privilege) ELSE false END AS columns
    FROM pg_class c CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p(privilege)
    WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','v','m') ORDER BY c.relname,p.privilege`)
  ).rows;
  for (const row of relations) {
    const expected = (operations.get(row.name) ?? []).includes(row.privilege);
    assert.equal(row.allowed, expected, `${row.name}: ${row.privilege}`);
    assert.equal(row.delegable, false, `${row.name}: grant option`);
    if (!expected)
      assert.equal(row.columns, false, `${row.name}: column ${row.privilege}`);
  }
  for (const name of operations.keys())
    assert.ok(
      relations.some((row) => row.name === name),
      name,
    );
  const sequenceRows = (
    await client.query<{
      name: string;
      privilege: string;
      allowed: boolean;
      delegable: boolean;
    }>(
      `SELECT c.relname AS name,p.privilege,
    has_sequence_privilege(current_user,c.oid,p.privilege) AS allowed,
    has_sequence_privilege(current_user,c.oid,p.privilege || ' WITH GRANT OPTION') AS delegable
    FROM pg_class c CROSS JOIN unnest(ARRAY['USAGE','SELECT','UPDATE']) p(privilege)
    WHERE c.relnamespace='public'::regnamespace AND c.relkind='S' ORDER BY c.relname,p.privilege`,
    )
  ).rows;
  for (const row of sequenceRows) {
    const known =
      sequences.includes(row.name) || row.name === 'canonical_item_id_seq';
    assert.equal(
      row.allowed,
      known &&
        (row.privilege !== 'UPDATE' || row.name === 'canonical_item_id_seq'),
      `${row.name}: ${row.privilege}`,
    );
    assert.equal(row.delegable, false);
  }
  const rights = (
    await client.query(`SELECT
    has_schema_privilege(current_user,'public','USAGE') AS usage,
    has_schema_privilege(current_user,'public','CREATE') AS create,
    has_database_privilege(current_user,current_database(),'CONNECT') AS connect,
    has_database_privilege(current_user,current_database(),'CREATE') AS database_create,
    has_database_privilege(current_user,current_database(),'TEMPORARY') AS temporary`)
  ).rows[0];
  assert.deepEqual(rights, {
    usage: true,
    create: false,
    connect: true,
    database_create: false,
    temporary: false,
  });
  assert.equal(
    (
      await client.query(
        `SELECT count(*)::int AS count FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)`,
      )
    ).rows[0].count,
    0,
  );
  const attributes = (
    await client.query(
      'SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolinherit,rolbypassrls FROM pg_roles WHERE rolname=current_user',
    )
  ).rows[0];
  assert.ok(Object.values(attributes).every((value) => value === false));
  assert.equal(
    (
      await client.query(
        `SELECT count(*)::int AS count FROM pg_proc WHERE pronamespace='public'::regnamespace AND has_function_privilege(current_user,oid,'EXECUTE')`,
      )
    ).rows[0].count,
    0,
  );
  return { relations, sequenceRows, rights, attributes };
}

test(
  'runtime role reconciles the complete permission matrix and rotates credentials without broadening access',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const root = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL!,
    });
    await root.connect();
    const suffix = randomUUID().replaceAll('-', '');
    const database = 'runtime_role_test_' + suffix;
    const parent = 'runtime_parent_' + suffix;
    const ownerUrl = new URL(process.env.TEST_DATABASE_URL!);
    ownerUrl.pathname = '/' + database;
    ownerUrl.search = '';
    const owner = new pg.Client({ connectionString: ownerUrl.toString() });
    const clients: pg.Client[] = [];
    const firstPassword = 'c'.repeat(64),
      rotatedPassword = 'd'.repeat(64);
    const login = async (password: string) => {
      const url = new URL(ownerUrl);
      url.username = 'clog_runtime';
      url.password = password;
      const client = new pg.Client({ connectionString: url.toString() });
      clients.push(client);
      await client.connect();
      return client;
    };
    try {
      await root.query(`CREATE DATABASE ${quote(database)}`);
      await owner.connect();
      await migrate(ownerUrl.toString());
      await provisionRuntimeRole(ownerUrl.toString(), firstPassword);
      await root.query(`CREATE ROLE ${quote(parent)} NOLOGIN`);
      await owner.query(`CREATE TABLE unclassified_fixture(id integer GENERATED BY DEFAULT AS IDENTITY, secret text);
        CREATE TABLE column_fixture(secret text);
        CREATE TABLE "constructor"(secret text);
        CREATE VIEW unclassified_view AS SELECT * FROM unclassified_fixture;
        CREATE MATERIALIZED VIEW unclassified_materialized AS SELECT * FROM unclassified_fixture;
        CREATE SEQUENCE unclassified_sequence;
        CREATE FUNCTION unclassified_function() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 7';
        CREATE PROCEDURE unclassified_procedure() LANGUAGE sql SECURITY DEFINER AS 'SELECT 7';
        GRANT EXECUTE ON FUNCTION unclassified_function() TO PUBLIC;
        GRANT EXECUTE ON PROCEDURE unclassified_procedure() TO PUBLIC;
        GRANT ALL ON unclassified_fixture TO PUBLIC,clog_runtime;
        GRANT SELECT(secret) ON column_fixture TO PUBLIC,clog_runtime;
        GRANT SELECT ON unclassified_view,unclassified_materialized TO PUBLIC;
        GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO PUBLIC;
        GRANT ALL ON SCHEMA public TO PUBLIC;
        GRANT CREATE,TEMPORARY ON DATABASE ${quote(database)} TO PUBLIC;
        GRANT SELECT ON schema_migrations TO ${quote(parent)};
        GRANT ${quote(parent)} TO clog_runtime WITH INHERIT TRUE, SET TRUE, ADMIN TRUE;
        ALTER ROLE clog_runtime INHERIT BYPASSRLS;
        ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO clog_runtime;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC;
        ALTER DEFAULT PRIVILEGES GRANT ALL ON SEQUENCES TO PUBLIC,clog_runtime;
        ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON ROUTINES TO clog_runtime;
        ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(parent)} IN SCHEMA public GRANT ALL ON TABLES TO PUBLIC,clog_runtime;
        ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(parent)} IN SCHEMA public GRANT ALL ON SEQUENCES TO PUBLIC,clog_runtime;
        ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(parent)} IN SCHEMA public GRANT EXECUTE ON ROUTINES TO clog_runtime;`);
      let runtime: pg.Client;
      await t.test(
        'PUBLIC, column and inherited grants are removed before effective-access verification',
        async () => {
          const before = await login(firstPassword);
          assert.ok(
            (await before.query('SELECT count(*) FROM schema_migrations'))
              .rowCount,
          );
          assert.equal(
            (await before.query('SELECT unclassified_function() AS value'))
              .rows[0].value,
            7,
          );
          await provisionRuntimeRole(ownerUrl.toString(), firstPassword);
          runtime = await login(firstPassword);
          await matrix(runtime);
          await assert.rejects(runtime.query(`SET ROLE ${quote(parent)}`), {
            code: '42501',
          });
        },
      );
      await t.test(
        'unknown tables, columns, views, sequences and routines reject real access',
        async () => {
          for (const sql of [
            'SELECT * FROM unclassified_fixture',
            'SELECT secret FROM column_fixture',
            'SELECT * FROM "constructor"',
            'SELECT * FROM unclassified_view',
            'SELECT * FROM unclassified_materialized',
            "SELECT nextval('unclassified_sequence')",
            'SELECT unclassified_function()',
            'CALL unclassified_procedure()',
            'CREATE TABLE forbidden_fixture(id integer)',
            'CREATE TEMP TABLE forbidden_temporary(id integer)',
            'CREATE SCHEMA forbidden_schema',
            'CREATE ROLE forbidden_role',
          ])
            await assert.rejects(runtime.query(sql), { code: '42501' }, sql);
        },
      );
      await t.test(
        'catalog receipt inserts and operational trigger writes work, while audit and receipt rewrites fail',
        async () => {
          await runtime.query(
            "INSERT INTO catalog_requests(actor_discord_id,request_key,payload_hash,result) VALUES('fixture','request','hash','{\"itemId\":1000001}')",
          );
          assert.equal(
            (
              await runtime.query(
                "SELECT result->>'itemId' AS id FROM catalog_requests WHERE request_key='request'",
              )
            ).rows[0].id,
            '1000001',
          );
          await runtime.query(
            "INSERT INTO items(id,name) VALUES(1000001,'Runtime fixture')",
          );
          await runtime.query(
            "INSERT INTO pages(id,category,name,sort_order) VALUES('runtime-page','Test','Runtime page',0)",
          );
          await runtime.query(
            "INSERT INTO page_items(page_id,item_id,slot) VALUES('runtime-page',1000001,0)",
          );
          await runtime.query(
            "INSERT INTO catalog_audit(actor_discord_id,action,item_id,after_value) VALUES('fixture','create',1000001,'{}')",
          );
          assert.equal(
            (
              await runtime.query(
                'SELECT collected FROM item_collection_state WHERE item_id=1000001',
              )
            ).rows[0].collected,
            false,
          );
          assert.ok(
            (await runtime.query('SELECT version FROM catalog_state')).rows[0]
              .version > 1,
          );
          const revisionBefore = BigInt(
            (await runtime.query('SELECT version FROM review_state')).rows[0]
              .version,
          );
          await runtime.query(
            "INSERT INTO submissions(id,source,raw_item_text,collector_name,collected_on,date_source,proof_url) VALUES('00000000-0000-4000-8000-000000009981','manual','Runtime fixture','Collector','2026-10-01','admin','')",
          );
          await runtime.query(
            "INSERT INTO audit_events(submission_id,actor_discord_id,actor_name,action,old_values,new_values) VALUES('00000000-0000-4000-8000-000000009981','staff','Runtime fixture','create','{}','{}')",
          );
          assert.equal(
            BigInt(
              (await runtime.query('SELECT version FROM review_state')).rows[0]
                .version,
            ),
            revisionBefore + 2n,
          );
          const tables = (
            await owner.query<{ name: string; column: string }>(
              `SELECT c.relname AS name,(SELECT attname FROM pg_attribute WHERE attrelid=c.oid AND attnum>0 AND NOT attisdropped AND attidentity='' AND attgenerated='' ORDER BY attnum LIMIT 1) AS column FROM pg_class c WHERE relnamespace='public'::regnamespace AND relkind='r'`,
            )
          ).rows;
          for (const table of tables) {
            const allowed = operations.get(table.name) ?? [];
            if (!allowed.includes('INSERT'))
              await assert.rejects(
                runtime.query(
                  `INSERT INTO ${quote(table.name)} DEFAULT VALUES`,
                ),
                { code: '42501' },
              );
            if (!allowed.includes('UPDATE'))
              await assert.rejects(
                runtime.query(
                  `UPDATE ${quote(table.name)} SET ${quote(table.column)}=${quote(table.column)} WHERE false`,
                ),
                { code: '42501' },
              );
            if (!allowed.includes('DELETE'))
              await assert.rejects(
                runtime.query(`DELETE FROM ${quote(table.name)} WHERE false`),
                { code: '42501' },
              );
            await assert.rejects(
              runtime.query(`TRUNCATE ${quote(table.name)}`),
              { code: '42501' },
            );
          }
          for (const name of sequences)
            await assert.rejects(
              runtime.query(`SELECT setval('${name}',999)`),
              { code: '42501' },
            );
          await runtime.query(
            "SELECT setval('canonical_item_id_seq',1000002,false)",
          );
        },
      );
      await t.test(
        'new objects from current and legacy owners stay denied before another bootstrap',
        async () => {
          await owner.query(`CREATE TABLE after_bootstrap_fixture(id integer);
          CREATE VIEW after_bootstrap_view AS SELECT * FROM after_bootstrap_fixture;
          CREATE SEQUENCE after_bootstrap_sequence;
          CREATE FUNCTION after_bootstrap_function() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';
          GRANT CREATE,USAGE ON SCHEMA public TO ${quote(parent)};
          SET ROLE ${quote(parent)};
          CREATE TABLE legacy_owner_fixture(id integer);
          CREATE SEQUENCE legacy_owner_sequence;
          CREATE FUNCTION legacy_owner_function() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';
          RESET ROLE;`);
          for (const sql of [
            'SELECT * FROM after_bootstrap_fixture',
            'SELECT * FROM after_bootstrap_view',
            "SELECT nextval('after_bootstrap_sequence')",
            'SELECT after_bootstrap_function()',
            'SELECT * FROM legacy_owner_fixture',
            "SELECT nextval('legacy_owner_sequence')",
            'SELECT legacy_owner_function()',
          ])
            await assert.rejects(runtime.query(sql), { code: '42501' });
          await matrix(runtime);
        },
      );
      await t.test(
        'repeated provisioning and password rotation keep the same permission matrix',
        async () => {
          const before = await matrix(runtime);
          await Promise.all([
            provisionRuntimeRole(ownerUrl.toString(), firstPassword),
            provisionRuntimeRole(ownerUrl.toString(), firstPassword),
          ]);
          assert.deepEqual(await matrix(runtime), before);
          await provisionRuntimeRole(ownerUrl.toString(), rotatedPassword);
          assert.deepEqual(await matrix(await login(rotatedPassword)), before);
          await assert.rejects(login(firstPassword), { code: '28P01' });
        },
      );
      await t.test(
        'runtime ownership fails provisioning without committing a password rotation',
        async () => {
          await owner.query(
            'ALTER TABLE unclassified_fixture OWNER TO clog_runtime',
          );
          await assert.rejects(
            provisionRuntimeRole(ownerUrl.toString(), 'e'.repeat(64)),
            /must not own/u,
          );
          await login(rotatedPassword);
          await assert.rejects(login('e'.repeat(64)), { code: '28P01' });
          await owner.query(
            `ALTER TABLE unclassified_fixture OWNER TO ${quote(ownerUrl.username)}`,
          );
          await provisionRuntimeRole(ownerUrl.toString(), rotatedPassword);
          await matrix(await login(rotatedPassword));
        },
      );
      await t.test(
        'missing required view rejects provisioning and rolls back all privilege changes',
        async () => {
          const current = await login(rotatedPassword);
          const before = await matrix(current);
          await owner.query(
            'ALTER VIEW collection_credits RENAME TO missing_credit_view',
          );
          await assert.rejects(
            provisionRuntimeRole(ownerUrl.toString(), 'e'.repeat(64)),
            /Missing or incompatible runtime policy object/u,
          );
          await owner.query(
            'ALTER VIEW missing_credit_view RENAME TO collection_credits',
          );
          assert.deepEqual(await matrix(current), before);
          await login(rotatedPassword);
        },
      );
    } finally {
      await Promise.all(clients.map((client) => client.end()));
      await owner.end();
      await root.query(`DROP DATABASE IF EXISTS ${quote(database)}`);
      await root.query(`DROP ROLE IF EXISTS ${quote(parent)}`);
      await root.end();
    }
  },
);
