/** Upgrade a populated 003 installation through the real checksummed runner. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { migrate } from './migrate.js';

test(
  'permanent-page migration preserves existing scheduling and collection history and defaults to no permanent openings',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    const schema = 'permanent_upgrade_' + randomUUID().replaceAll('-', '');
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
      'CREATE TABLE schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const name of [
      '001_baseline.sql',
      '002_staff_page_access.sql',
      '003_wom_multi_metric.sql',
    ]) {
      const sql = await readFile(
        new URL('../migrations/' + name, import.meta.url),
        'utf8',
      );
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',
        [name, createHash('sha256').update(sql).digest('hex')],
      );
    }
    await client.query(`INSERT INTO items(id,name) VALUES(1,'Existing item');
      INSERT INTO pages(id,name,category,sort_order) VALUES('existing-page','Existing page','bosses',0);
      INSERT INTO page_items(page_id,item_id,slot) VALUES('existing-page',1,0);
      INSERT INTO collection_log_schedules(id,title,starts_at,ends_at) VALUES('00000000-0000-4000-8000-000000000001','Existing window',now()-interval '1 hour',now()+interval '1 hour');
      INSERT INTO collection_log_schedule_pages(schedule_id,page_id) VALUES('00000000-0000-4000-8000-000000000001','existing-page');
      UPDATE collection_scheduling SET enabled=true,version=7;
      INSERT INTO collection_schedule_audit(actor_id,actor_name,action,version,old_values,new_values) VALUES('owner','Owner','create',7,'{}','{"preserved":true}');
      INSERT INTO submissions(id,discord_interaction_id,discord_user_id,discord_guild_id,raw_item_text,item_id,collector_name,collected_on,date_source,proof_url,status,reviewed_by,reviewed_at)
      VALUES('00000000-0000-4000-8000-000000000002','existing','1','2','Existing item',1,'Collector','2026-10-18','admin','https://imgur.com/example','approved','owner',now());`);
    const tables = [
      'collection_scheduling',
      'collection_log_schedules',
      'collection_log_schedule_pages',
      'collection_schedule_audit',
      'submissions',
      'collection_credits',
      'site_settings',
      'staff_page_access',
    ];
    const snapshot = async () => {
      const rows: unknown[] = [];
      for (const table of tables)
        rows.push(
          (
            await client.query(
              'SELECT to_jsonb(t) AS row FROM ' +
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
    assert.deepEqual(await snapshot(), before);
    assert.equal(
      (await client.query('SELECT * FROM collection_permanent_pages')).rowCount,
      0,
    );
    assert.equal(
      (await client.query('SELECT * FROM schema_migrations')).rowCount,
      4,
    );
    await assert.rejects(
      client.query(
        "INSERT INTO collection_permanent_pages(page_id) VALUES('missing-page')",
      ),
      { code: '23503' },
    );
    await client.query(
      "INSERT INTO collection_permanent_pages(page_id) VALUES('existing-page')",
    );
    await assert.rejects(
      client.query(
        "INSERT INTO collection_permanent_pages(page_id) VALUES('existing-page')",
      ),
      { code: '23505' },
    );
    await migrate(url.href);
    assert.deepEqual(
      (await client.query('SELECT page_id FROM collection_permanent_pages'))
        .rows,
      [{ page_id: 'existing-page' }],
    );
  },
);
