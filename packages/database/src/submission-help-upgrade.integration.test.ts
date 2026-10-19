import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { defaultSubmissionHelp } from '@clog/domain';
import { migrate } from './migrate.js';

test(
  'submission help upgrades populated 006 without replacing copy, history or credentials',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    const schema = 'help_upgrade_' + randomUUID().replaceAll('-', '');
    const root = new pg.Client({ connectionString: url.href });
    await root.connect();
    await root.query('CREATE SCHEMA ' + schema);
    url.searchParams.set('options', '-c search_path=' + schema);
    const client = new pg.Client({ connectionString: url.href });
    await client.connect();
    t.after(async () => {
      await client.end();
      await root.query('DROP SCHEMA ' + schema + ' CASCADE');
      await root.end();
    });
    await client.query(
      'CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const directory = new URL('../migrations/', import.meta.url);
    for (const name of (await readdir(directory))
      .filter((name) => name.endsWith('.sql') && name < '007_')
      .sort()) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',
        [name, createHash('sha256').update(sql).digest('hex')],
      );
    }
    await client.query(`UPDATE site_settings SET version=12,clan_name='Live clan',hardcore_name='Live hardcore',public_copy=jsonb_set(public_copy,'{collectionCaption}','"Custom normal caption"'),hardcore_copy=jsonb_set(hardcore_copy,'{collectionCaption}','"Custom hardcore caption"');
      INSERT INTO site_settings_audit(actor_discord_id,old_enabled,new_enabled,version,old_clan_name,new_clan_name) VALUES('owner',false,true,12,'Before','Live clan');
      INSERT INTO staff_accounts(id,username,role,password_hash,must_change_password) VALUES('00000000-0000-4000-8000-000000000001','owner','admin','preserved-hash',false);
      INSERT INTO admin_sessions(token_hash,discord_user_id,display_name,expires_at,account_id,credential_version) VALUES(repeat('a',64),'owner','Owner',now()+interval '1 day','00000000-0000-4000-8000-000000000001',1);
      INSERT INTO items(id,name) VALUES(1,'Existing drop');
      INSERT INTO submissions(id,source,raw_item_text,item_id,collector_name,collected_on,date_source,proof_url,status,reviewed_by,reviewed_at) VALUES('00000000-0000-4000-8000-000000000002','manual','Existing drop',1,'Collector','2026-10-18','admin','','approved','owner',now());`);
    const tables = [
      'site_settings',
      'site_settings_audit',
      'staff_accounts',
      'admin_sessions',
      'submissions',
      'collection_credits',
    ];
    const snapshot = async () => {
      const result: unknown[] = [];
      for (const table of tables)
        result.push(
          (
            await client.query(
              "SELECT to_jsonb(t)-'how_to_submit_markdown'-'old_how_to_submit_markdown'-'new_how_to_submit_markdown'" +
                (table === 'site_settings' ? "-'version'" : '') +
                ' row FROM ' +
                table +
                ' t ORDER BY to_jsonb(t)::text',
            )
          ).rows,
        );
      return result;
    };
    const before = await snapshot();
    await migrate(url.href);
    await migrate(url.href);
    assert.deepEqual(await snapshot(), before);
    const settings = (await client.query('SELECT * FROM site_settings'))
      .rows[0];
    assert.equal(settings.version, 13);
    assert.equal(settings.how_to_submit_markdown, defaultSubmissionHelp);
    const audit = (await client.query('SELECT * FROM site_settings_audit'))
      .rows[0];
    assert.equal(audit.old_how_to_submit_markdown, null);
    assert.equal(audit.new_how_to_submit_markdown, null);
    await client.query('UPDATE site_settings SET how_to_submit_markdown=$1', [
      '😀'.repeat(8192),
    ]);
    await assert.rejects(
      client.query('UPDATE site_settings SET how_to_submit_markdown=$1', [
        '😀'.repeat(8193),
      ]),
      { code: '23514' },
    );
    await migrate(url.href);
    assert.equal(
      (await client.query('SELECT how_to_submit_markdown FROM site_settings'))
        .rows[0].how_to_submit_markdown,
      '😀'.repeat(8192),
    );
  },
);
