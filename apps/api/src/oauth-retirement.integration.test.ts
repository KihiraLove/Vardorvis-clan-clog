/** A populated checksummed 020 database upgrades without disturbing password sessions. */
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import {
  migrate,
  validateMigrationHistory,
} from '@clog/database/dist/migrate.js';
import { PgStore } from './store.js';
import { createApp } from './app.js';
import { hashPassword } from './passwords.js';

test(
  'OAuth retirement upgrades populated schema 020 and preserves current authentication',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    const root = new pg.Pool({ connectionString: url.toString() });
    const schema = 'oauth_retirement_' + randomUUID().replaceAll('-', '');
    await root.query('CREATE SCHEMA ' + schema);
    url.searchParams.set('options', '-c search_path=' + schema);
    const pool = new pg.Pool({ connectionString: url.toString() });
    const store = new PgStore(pool),
      password = 'new-password-session-test',
      secret = 'a'.repeat(64),
      token = 'A'.repeat(43);
    const oldManifest: { name: string; checksum: string }[] = [];
    let businessTables: string[] | undefined;
    const cookie = '__Host-clog-session=' + token;
    async function snapshot() {
      const tables = (
        await pool.query<{ tablename: string }>(
          "SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename NOT IN ('schema_migrations','oauth_states') ORDER BY tablename",
        )
      ).rows;
      // Later migrations may add tables; retain the complete pre-upgrade set
      // when verifying that retirement preserves every existing business row.
      businessTables ??= tables.map(({ tablename }) => tablename);
      const values: Record<string, unknown[]> = {};
      for (const tablename of businessTables) {
        // Names come from this disposable schema's catalog, never HTTP input.
        const quoted = '"' + tablename.replaceAll('"', '""') + '"';
        values[tablename] = (
          await pool.query(
            `SELECT to_jsonb(r) AS value FROM ${quoted} r ORDER BY to_jsonb(r)::text`,
          )
        ).rows.map((r) => {
          // Forward upgrades may add nullable proof fields to preserved claims.
          if (tablename === 'submissions' && r.value.chat_message === null)
            delete r.value.chat_message;
          return r.value;
        });
      }
      return values;
    }
    try {
      const directory = new URL(
        '../../../packages/database/migrations/',
        import.meta.url,
      );
      await pool.query(
        'CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
      );
      for (const name of (await readdir(directory))
        .filter((name) => name.endsWith('.sql') && name < '021_')
        .sort()) {
        const sql = await readFile(new URL(name, directory), 'utf8');
        const checksum = createHash('sha256').update(sql).digest('hex');
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(sql);
          await client.query(
            'INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',
            [name, checksum],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
        oldManifest.push({ name, checksum });
      }
      assert.equal(oldManifest.length, 20);
      await store.ensureDefaultAdmin(await hashPassword(password));
      await pool.query(
        "UPDATE staff_accounts SET must_change_password=false WHERE role='admin'",
      );
      const owner = (await store.accountByUsername('admin'))!;
      await store.createSession(
        createHmac('sha256', secret)
          .update('session:' + token)
          .digest('hex'),
        {
          id: owner.id,
          displayName: owner.username,
          accountVersion: owner.credentialVersion,
        },
        new Date(Date.now() + 3600000),
      );
      await pool.query(
        "INSERT INTO oauth_states(state_hash,expires_at) VALUES($1,now()+interval '10 minutes')",
        ['f'.repeat(64)],
      );
      await pool.query(
        "INSERT INTO items(id,name) VALUES(900100,'Preserved item'); INSERT INTO pages(id,name,category,sort_order) VALUES('preserved','Preserved','other',0); INSERT INTO page_items(page_id,item_id,slot) VALUES('preserved',900100,0)",
      );
      const claim = randomUUID();
      await pool.query(
        "INSERT INTO submissions(id,source,raw_item_text,item_id,collector_name,collected_on,date_source,proof_url,status,reviewed_by,reviewed_at,review_note) VALUES($1,'manual','Preserved item',900100,'Collector','2026-01-01','admin','','approved',$2,now(),'Preserved note')",
        [claim, owner.id],
      );
      const before = await snapshot();

      await t.test(
        'unexpected dependencies reject retirement atomically without CASCADE',
        async () => {
          await pool.query(
            'CREATE VIEW legacy_dependency AS SELECT state_hash FROM oauth_states',
          );
          await assert.rejects(migrate(url.toString()), { code: '2BP01' });
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int AS n FROM schema_migrations',
              )
            ).rows[0].n,
            20,
          );
          assert.equal(
            (await pool.query('SELECT count(*)::int AS n FROM oauth_states'))
              .rows[0].n,
            1,
          );
          assert.deepEqual(await snapshot(), before);
          await pool.query('DROP VIEW legacy_dependency');
        },
      );
      await t.test(
        'forward migration and repeated startup preserve every business table and current session',
        async () => {
          await migrate(url.toString());
          await migrate(url.toString());
          assert.equal(
            (
              await pool.query(
                "SELECT to_regclass(current_schema() || '.oauth_states') IS NULL AS absent",
              )
            ).rows[0].absent,
            true,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int AS n FROM schema_migrations',
              )
            ).rows[0].n,
            23,
          );
          assert.deepEqual(await snapshot(), before);
          assert.deepEqual(
            (
              await pool.query(
                'SELECT version,filter_collected FROM submission_filter_settings',
              )
            ).rows,
            [{ version: 1, filter_collected: false }],
          );
          assert.equal(
            (
              await store.session(
                createHmac('sha256', secret)
                  .update('session:' + token)
                  .digest('hex'),
              )
            )?.id,
            owner.id,
          );
          assert.equal((await store.collections())[0]?.submissionId, claim);
        },
      );
      await t.test(
        'a pre-021 manifest rejects the new ledger without changing any state',
        async () => {
          const ledger = (
            await pool.query(
              'SELECT name,checksum,applied_at FROM schema_migrations ORDER BY name',
            )
          ).rows;
          assert.throws(
            () => validateMigrationHistory(oldManifest, ledger),
            /Unknown applied migration: 021_retire_oauth_states.sql/u,
          );
          assert.deepEqual(await snapshot(), before);
          assert.deepEqual(
            (
              await pool.query(
                'SELECT name,checksum,applied_at FROM schema_migrations ORDER BY name',
              )
            ).rows,
            ledger,
          );
        },
      );
      await t.test(
        'password login, existing session, CSRF and logout work; retired endpoints are ordinary 404s',
        async () => {
          const app = createApp(undefined, undefined, {
            store,
            auth: { origin: 'https://clog.test', secret, secure: true },
            logger: false,
          });
          try {
            const session = await app.inject({
              url: '/api/v1/auth/session',
              headers: { cookie },
            });
            assert.equal(session.json().authenticated, true);
            const paths = [
              '/api/v1/auth/discord',
              '/api/v1/auth/discord/callback?code=retired&state=unused',
            ];
            for (const path of paths) {
              const response = await app.inject(path);
              assert.equal(response.statusCode, 404);
              assert.equal(response.headers['cache-control'], 'no-store');
              assert.ok(!response.body.includes('retired'));
            }
            assert.equal(
              (
                await app.inject({
                  method: 'POST',
                  url: '/api/v1/auth/logout',
                  headers: { cookie },
                })
              ).statusCode,
              403,
            );
            const login = await app.inject({
              method: 'POST',
              url: '/api/v1/auth/login',
              headers: { origin: 'https://clog.test' },
              payload: { username: 'admin', password },
            });
            assert.equal(login.statusCode, 200, login.body);
            const loggedInCookie = String(login.headers['set-cookie']).split(
              ';',
            )[0]!;
            const loggedIn = await app.inject({
              url: '/api/v1/auth/session',
              headers: { cookie: loggedInCookie },
            });
            assert.equal(loggedIn.json().authenticated, true);
            const logout = await app.inject({
              method: 'POST',
              url: '/api/v1/auth/logout',
              headers: {
                cookie: loggedInCookie,
                origin: 'https://clog.test',
                'x-csrf-token': loggedIn.json().csrfToken,
              },
            });
            assert.equal(logout.statusCode, 204);
            assert.equal(
              (
                await app.inject({
                  url: '/api/v1/auth/session',
                  headers: { cookie: loggedInCookie },
                })
              ).json().authenticated,
              false,
            );
          } finally {
            await app.close();
          }
        },
      );
    } finally {
      await pool.end();
      await root.query('DROP SCHEMA ' + schema + ' CASCADE');
      await root.end();
    }
  },
);
