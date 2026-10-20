import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { defaultEventHighlight, defaultHardcoreHighlight } from '@clog/domain';
import { migrate } from './migrate.js';

test(
  'highlight upgrade preserves populated 009 settings, accounts, credits and audit history',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    const schema = 'highlight_upgrade_' + randomUUID().replaceAll('-', '');
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
      .filter((name) => name.endsWith('.sql') && name < '010_')
      .sort()) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',
        [name, createHash('sha256').update(sql).digest('hex')],
      );
    }
    await client.query(`UPDATE site_settings SET version=12,clan_name='Live clan',hardcore_enabled=true,how_to_submit_markdown='Saved help';
    INSERT INTO site_settings_audit(actor_discord_id,old_enabled,new_enabled,version,old_clan_name,new_clan_name) VALUES('owner',false,true,12,'Before','Live clan');
    INSERT INTO staff_accounts(id,username,role,password_hash,must_change_password) VALUES('00000000-0000-4000-8000-000000000001','owner','admin','kept-hash',false);
    INSERT INTO admin_sessions(token_hash,discord_user_id,display_name,expires_at,account_id,credential_version) VALUES(repeat('a',64),'owner','Owner',now()+interval '1 day','00000000-0000-4000-8000-000000000001',1);
    INSERT INTO items(id,name) VALUES(1,'Existing drop');
    INSERT INTO submissions(id,source,raw_item_text,item_id,collector_name,collected_on,date_source,proof_url,status,reviewed_by,reviewed_at) VALUES('00000000-0000-4000-8000-000000000002','manual','Existing drop',1,'Collector','2026-10-18','admin','','approved','owner',now());`);
    const snapshot = async () => {
      const rows = [];
      for (const table of [
        'site_settings',
        'site_settings_audit',
        'staff_accounts',
        'admin_sessions',
        'submissions',
        'collection_credits',
        'schema_migrations',
      ])
        rows.push(
          (
            await client.query(
              "SELECT to_jsonb(t)-'event_highlight'-'hardcore_highlight'-'old_event_highlight'-'new_event_highlight'-'old_hardcore_highlight'-'new_hardcore_highlight'" +
                (table === 'site_settings' ? "-'version'" : '') +
                ' row FROM ' +
                table +
                ' t ORDER BY to_jsonb(t)::text',
            )
          ).rows,
        );
      return rows;
    };
    const before = await snapshot();
    await migrate(url.href);
    await migrate(url.href);
    const after = await snapshot();
    const ledger = after.pop()!;
    assert.deepEqual(ledger.slice(0, 9), before.pop());
    assert.equal(ledger.length, 10);
    assert.deepEqual(after, before);
    const settings = (await client.query('SELECT * FROM site_settings'))
      .rows[0];
    assert.equal(settings.version, 13);
    assert.deepEqual(settings.event_highlight, defaultEventHighlight);
    assert.deepEqual(settings.hardcore_highlight, defaultHardcoreHighlight);
    for (const column of ['event_highlight', 'hardcore_highlight']) {
      for (const bad of [
        { red: -1, green: 0, blue: 0, alpha: 1 },
        { red: 1.2, green: 0, blue: 0, alpha: 1 },
        { red: 0, green: 0, blue: 0, alpha: 1.1 },
        {},
        { red: 1, green: 2, blue: '3', alpha: 1 },
        { red: 1, green: 2, blue: 3 },
        { red: 1, green: 2, blue: 3, alpha: 1, extra: 1 },
        null,
        [],
      ])
        await assert.rejects(
          client.query('UPDATE site_settings SET ' + column + '=$1', [
            JSON.stringify(bad),
          ]),
          { code: '23514' },
        );
      for (const alpha of [0, 0.375, 1]) {
        const colour = { red: 0, green: 255, blue: 128, alpha };
        await client.query('UPDATE site_settings SET ' + column + '=$1', [
          JSON.stringify(colour),
        ]);
        await migrate(url.href);
        assert.deepEqual(
          (await client.query('SELECT ' + column + ' FROM site_settings'))
            .rows[0][column],
          colour,
        );
      }
    }
  },
);
